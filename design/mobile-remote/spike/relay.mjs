// In-memory relay for the Mobile Remote spike: routes opaque frames, keeps a per-pair mailbox for an offline peer, publishes presence.
// It reads only the frame header (pair, dir, ctr) and the box size; it never holds a key.
import { WebSocketServer } from 'ws';

const MAX_FRAME_BYTES = 256 * 1024;
const MAX_QUEUED = 1000;
const INBOUND = { mac: 'p2m', phone: 'm2p' }; // the direction each role receives
const OTHER = { mac: 'phone', phone: 'mac' };

export async function startRelay({ port = 0, ttlMs = 7 * 24 * 3600e3, pingMs = 15e3, maxMissed = 3, onPush = () => {} } = {}) {
  const pairs = new Map(); // pair -> { mac, phone, mailbox: { mac: [], phone: [] } }
  const wss = new WebSocketServer({ port, maxPayload: MAX_FRAME_BYTES * 2 });
  await new Promise((resolve) => wss.once('listening', resolve));
  const stats = { routed: 0, queued: 0, drained: 0, dropped: 0, rejected: 0 };

  const send = (ws, msg) => ws && ws.readyState === 1 && ws.send(JSON.stringify(msg));
  const entry = (pair) => {
    if (!pairs.has(pair)) pairs.set(pair, { mac: null, phone: null, mailbox: { mac: [], phone: [] } });
    return pairs.get(pair);
  };

  // Expire queued frames; tell the sender which counters were lost so it can resync.
  const sweep = (now = Date.now()) => {
    for (const [pair, p] of pairs) {
      for (const role of ['mac', 'phone']) {
        const keep = [];
        for (const q of p.mailbox[role]) {
          if (now - q.at < ttlMs) { keep.push(q); continue; }
          stats.dropped++;
          send(p[OTHER[role]], { t: 'dropped', pair, dir: q.frame.dir, ctr: q.frame.ctr });
        }
        p.mailbox[role] = keep;
      }
    }
  };

  wss.on('connection', (ws) => {
    let me = null; // { pair, role }
    ws.missed = 0;
    ws.on('pong', () => { ws.missed = 0; });
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return ws.close(1003, 'json'); }
      if (msg.t === 'hello') {
        if (me || typeof msg.pair !== 'string' || !(msg.role in INBOUND)) return ws.close(1008, 'hello');
        me = { pair: msg.pair, role: msg.role };
        const p = entry(me.pair);
        if (p[me.role] && p[me.role] !== ws) p[me.role].close(4000, 'replaced');
        p[me.role] = ws;
        const peer = OTHER[me.role];
        send(ws, { t: 'welcome', pair: me.pair, peer: p[peer] ? 'online' : 'offline', queued: p.mailbox[me.role].length });
        send(p[peer], { t: 'presence', role: me.role, state: 'online' });
        sweep();
        for (const q of p.mailbox[me.role].splice(0)) { stats.drained++; send(ws, { t: 'frame', frame: q.frame }); }
        return;
      }
      if (!me) return ws.close(1008, 'no hello');
      if (msg.t === 'frame') {
        const f = msg.frame;
        const ok = f && f.pair === me.pair && f.dir === INBOUND[OTHER[me.role]] && Number.isSafeInteger(f.ctr)
          && typeof f.nonce === 'string' && typeof f.box === 'string' && f.box.length * 0.75 <= MAX_FRAME_BYTES;
        if (!ok) { stats.rejected++; return send(ws, { t: 'nack', reason: 'bad frame' }); }
        const p = entry(me.pair);
        const to = OTHER[me.role];
        if (p[to] && p[to].readyState === 1) {
          stats.routed++;
          send(p[to], { t: 'frame', frame: f });
          return send(ws, { t: 'ack', dir: f.dir, ctr: f.ctr, queued: false });
        }
        if (p.mailbox[to].length >= MAX_QUEUED) { stats.rejected++; return send(ws, { t: 'nack', reason: 'mailbox full', ctr: f.ctr }); }
        p.mailbox[to].push({ at: Date.now(), frame: f });
        stats.queued++;
        onPush({ pair: me.pair, kind: msg.push || null }); // the wake-up request travels in the clear, as the design says
        return send(ws, { t: 'ack', dir: f.dir, ctr: f.ctr, queued: true });
      }
    });
    ws.on('close', () => {
      if (!me) return;
      const p = pairs.get(me.pair);
      if (p && p[me.role] === ws) { p[me.role] = null; send(p[OTHER[me.role]], { t: 'presence', role: me.role, state: 'gone' }); }
    });
  });

  // A peer that misses `maxMissed` pings is gone; terminating it fires the close handler above.
  const timer = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.missed >= maxMissed) { ws.terminate(); continue; }
      ws.missed++;
      ws.ping();
    }
    sweep();
  }, pingMs);
  timer.unref();

  return {
    port: wss.address().port,
    stats,
    sweep,
    mailboxSize: (pair, role) => pairs.get(pair)?.mailbox[role].length ?? 0,
    close: () => new Promise((resolve) => { clearInterval(timer); for (const c of wss.clients) c.terminate(); wss.close(resolve); }),
  };
}
