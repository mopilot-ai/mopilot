// Relay scenarios and the Mac -> relay -> phone -> relay -> Mac round trip, over real localhost WebSockets.
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import os from 'node:os';
import WebSocket from 'ws';
import { startRelay } from './relay.mjs';
import { nodeBackend, wasmBackend, Sender, Receiver, keysFor } from './crypto.mjs';

await nodeBackend.ready(); await wasmBackend.ready();
const PAIR = 'p_bench';
const checks = [];
const check = (name, ok, detail = '') => { checks.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${detail}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A relay client: Mac side runs sodium-native, phone side runs libsodium-wrappers.
async function client(port, role, pair = PAIR) {
  const be = role === 'mac' ? nodeBackend : wasmBackend;
  const keys = keysFor(be, role);
  const [out, inn] = role === 'mac' ? ['m2p', 'p2m'] : ['p2m', 'm2p'];
  const c = { role, events: [], texts: [], errors: [], tx: new Sender(be, pair, out, keys[out]), rx: new Receiver(be, pair, inn, keys[inn]), waiters: [] };
  c.ws = new WebSocket(`ws://127.0.0.1:${port}`);
  c.ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.t === 'frame') {
      try { c.texts.push(c.rx.open(m.frame)); } catch (e) { c.errors.push(e.message); }
    } else c.events.push(m);
    for (const w of c.waiters.splice(0)) w();
  });
  await new Promise((r) => c.ws.once('open', r));
  c.ws.send(JSON.stringify({ t: 'hello', pair, role }));
  c.send = (text, push) => c.ws.send(JSON.stringify({ t: 'frame', frame: c.tx.seal(text), push }));
  c.until = async (pred, ms = 3000) => {
    const end = Date.now() + ms;
    while (!pred()) { if (Date.now() > end) throw new Error('timeout'); await new Promise((r) => { c.waiters.push(r); setTimeout(r, 20); }); }
  };
  return c;
}

const relay = await startRelay({ pingMs: 40, maxMissed: 3, ttlMs: 400 });

// 1. Online round trip with a sealed card.answer request and reply.
const mac = await client(relay.port, 'mac');
const phone = await client(relay.port, 'phone');
await mac.until(() => mac.events.some((e) => e.t === 'presence' && e.state === 'online'));
check('presence: mac sees the phone come online', true);
phone.send('{"method":"card.answer","params":{"cardId":"c1","key":"allow"}}');
await mac.until(() => mac.texts.length === 1);
check('sealed card.answer crosses the relay (phone=wasm, mac=sodium-native)', mac.texts[0].includes('card.answer'));

// 2. Round-trip latency: mac seals, phone opens and seals the reply, mac opens.
const N = 1000, WARM = 100, samples = [];
for (let i = 0; i < N + WARM; i++) {
  const before = phone.texts.length, beforeMac = mac.texts.length;
  const t0 = performance.now();
  mac.send(`req ${i}`);
  await phone.until(() => phone.texts.length > before);
  phone.send(`rep ${i}`);
  await mac.until(() => mac.texts.length > beforeMac);
  if (i >= WARM) samples.push(performance.now() - t0);
}
samples.sort((a, b) => a - b);
const q = (p) => +samples[Math.min(samples.length - 1, Math.floor(samples.length * p))].toFixed(3);
const rtt = { samples: N, p50_ms: q(0.5), p95_ms: q(0.95), p99_ms: q(0.99), max_ms: +samples.at(-1).toFixed(3) };
console.log('round trip', rtt);
check('localhost round trip p95 under 300 ms (floor, not the Wi-Fi bar)', rtt.p95_ms < 300, `p95=${rtt.p95_ms} ms`);

// 3. A replay through the relay: the relay forwards it blindly, the endpoint refuses it.
const replayed = phone.tx.seal('once'); 
phone.ws.send(JSON.stringify({ t: 'frame', frame: replayed }));
phone.ws.send(JSON.stringify({ t: 'frame', frame: replayed }));
await mac.until(() => mac.errors.length > 0);
check('replayed frame forwarded by the relay is rejected by the Mac', mac.errors[0] === 'replay' && mac.texts.at(-1) === 'once');

// 4. Offline phone: frames wait in the mailbox, drain in order on reconnect, relay reports queued.
phone.ws.close();
await mac.until(() => mac.events.some((e) => e.t === 'presence' && e.state === 'gone'));
check('presence: mac sees the phone go away', true);
const before = mac.events.length;
for (let i = 0; i < 3; i++) mac.send(`queued ${i}`, 'needsYou');
await mac.until(() => mac.events.slice(before).filter((e) => e.t === 'ack').length === 3);
check('offline peer: relay acks queued=true', mac.events.slice(before).every((e) => e.queued === true) && relay.mailboxSize(PAIR, 'phone') === 3);
const phone2 = await client(relay.port, 'phone');
// The new phone session has fresh ratchet state; give it the old receive position by replaying what the old one consumed.
phone2.rx = phone.rx;
await phone2.until(() => phone2.texts.length === 3);
check('mailbox drains in order on reconnect', JSON.stringify(phone2.texts) === JSON.stringify(['queued 0', 'queued 1', 'queued 2']));

// 5. TTL: a frame left past the TTL is dropped and the sender is told.
phone2.ws.close();
await mac.until(() => mac.events.filter((e) => e.t === 'presence' && e.state === 'gone').length === 2);
mac.send('too late');
await sleep(450);
relay.sweep();
await mac.until(() => mac.events.some((e) => e.t === 'dropped'));
check('expired mailbox frame is dropped and the sender gets mailbox.dropped', relay.mailboxSize(PAIR, 'phone') === 0 && relay.stats.dropped === 1);

// 6. A silent peer (no pongs) is declared gone after three missed pings.
const ghost = await client(relay.port, 'phone', PAIR);
ghost.ws._receiver.removeAllListeners?.('ping');
ghost.ws.pong = () => {};
ghost.ws.on('ping', () => {});
const t0 = Date.now();
await mac.until(() => mac.events.filter((e) => e.t === 'presence' && e.state === 'gone').length === 3, 5000).catch(() => {});
const goneAfter = Date.now() - t0;
check('a peer that stops answering pings is marked gone', mac.events.filter((e) => e.state === 'gone').length === 3, `after ${goneAfter} ms with pingMs=40`);

// 7. Bad frames are refused without a crash.
mac.ws.send(JSON.stringify({ t: 'frame', frame: { pair: 'other', dir: 'm2p', ctr: 1, nonce: 'a', box: 'b' } }));
await mac.until(() => mac.events.some((e) => e.t === 'nack'));
check('frame for another pair is nacked', true);

const failed = checks.filter((c) => !c.ok);
writeFileSync(new URL('./result.json', import.meta.url), `${JSON.stringify({
  ran: new Date().toISOString().slice(0, 10), node: process.version, host: `${os.platform()} ${os.arch()}`,
  libraries: { 'sodium-native': '5.x', 'libsodium-wrappers': '0.8.4' },
  interop: JSON.parse(readFileSync(new URL('./interop-result.json', import.meta.url), 'utf8')), rtt, relayStats: relay.stats, checks,
}, null, 2)}\n`);
rmSync(new URL('./interop-result.json', import.meta.url));
await relay.close(); mac.ws.terminate(); ghost.ws.terminate();
console.log(`${checks.length - failed.length}/${checks.length} passed`);
process.exit(failed.length ? 1 : 0);
