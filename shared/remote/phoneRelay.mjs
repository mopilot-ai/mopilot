// Phone relay client: authenticated socket, bounded operation acknowledgements and retired-socket guards. A socket the relay closes with one of its refusals (relayRefusal.mjs: at capacity, the account's device limit, switched off) fails the connect with RelayRefused and tells onClose which. When the relay's hello says it keeps frames until acked, `acker` sends the receipts (shared/remote/ack.mjs).
import { ReceiptAcker, relayAcks } from './ack.mjs';
import { RelayRefused, refusalOf } from './relayRefusal.mjs';

/** @param {{ open: (url: string, token: string) => any, timeoutMs?: number, onFrame: (frame: any) => void, onEvent: (event: any) => void, onClose: (refusal?: import('./relayRefusal.mjs').RelayRefusal | null) => void }} o `onClose` is told the relay's refusal when the socket was closed with one */
export function createPhoneRelay(o) {
  /** @type {any} */
  let socket = null;
  let generation = 0,
    sequence = 0;
  const pending = new Map();
  /** @type {(() => void) | null} */
  let connecting = null;
  const timeoutMs = o.timeoutMs ?? 15000;
  let acks = false;
  const acker = new ReceiptAcker({
    enabled: () => acks && !!socket,
    send: (m) => {
      try {
        socket.send(JSON.stringify(m));
        return true;
      } catch {
        return false;
      }
    },
  });
  function retire() {
    generation++;
    acks = false;
    if (connecting) {
      const cancel = connecting;
      connecting = null;
      cancel();
    }
    const old = socket;
    socket = null;
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error('relay disconnected'));
    }
    pending.clear();
    if (old) old.close();
  }
  function wait(key, send) {
    if (!socket) return Promise.reject(new Error('relay disconnected'));
    let text;
    try {
      text = JSON.stringify(send);
    } catch (error) {
      // a frame that cannot be written is the caller's error, not the connection's
      return Promise.reject(error);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(key);
        reject(new Error('relay acknowledgement timed out'));
      }, timeoutMs);
      pending.set(key, { resolve, reject, timer });
      try {
        socket.send(text);
      } catch {
        // a socket that is not open throws (React Native says INVALID_STATE_ERR): to the callers it is a relay that is not connected
        clearTimeout(timer);
        pending.delete(key);
        reject(new Error('relay disconnected'));
      }
    });
  }
  return {
    async connect(url, token) {
      retire();
      const owner = generation;
      const ws = o.open(url, token);
      socket = ws;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          connecting = null;
          if (generation === owner) retire();
          reject(new Error('relay connection timed out'));
        }, timeoutMs);
        connecting = () => {
          clearTimeout(timer);
          reject(new Error('relay disconnected'));
        };
        let ready = false;
        ws.onmessage = (event) => {
          if (generation !== owner) return;
          if (typeof event.data !== 'string' || event.data.length > 400000) {
            retire();
            o.onClose();
            return;
          }
          let msg;
          try {
            msg = JSON.parse(event.data);
          } catch {
            return;
          }
          if (msg?.t === 'hello' && !ready) {
            ready = true;
            acks = relayAcks(msg);
            connecting = null;
            clearTimeout(timer);
            resolve(msg);
            return;
          }
          const key = msg?.t === 'ack' ? `frame:${msg.pair}:${msg.dir}:${msg.ctr}` : msg?.rid;
          const frameKey = msg?.t === 'error' && msg.pair && Number.isSafeInteger(msg.ctr) ? `frame:${msg.pair}:p2m:${msg.ctr}` : key;
          const entry = pending.get(frameKey);
          if (entry && (msg.t === 'ack' || msg.t === 'ok' || msg.t === 'error')) {
            pending.delete(frameKey);
            clearTimeout(entry.timer);
            if (msg.t === 'error') {
              const code =
                typeof msg.code === 'string' &&
                [
                  'bad_message',
                  'bad_frame',
                  'unknown_pair',
                  'bad_dir',
                  'mailbox_full',
                  'forbidden',
                  'pair_exists',
                  'pair_limit',
                  'pair_expired',
                  'already_joined',
                  'expired',
                  'taken',
                ].includes(msg.code)
                  ? msg.code
                  : 'error';
              entry.reject(new Error(`relay: ${code}`));
            } else entry.resolve(msg);
          } else if (msg?.t === 'frame') o.onFrame(msg);
          else if (msg?.t === 'event') o.onEvent(msg);
        };
        ws.onerror = () => {
          if (generation !== owner) return;
          if (!ready) {
            connecting = null;
            clearTimeout(timer);
            retire();
            reject(new Error('relay connection failed'));
          }
        };
        ws.onclose = (event) => {
          if (generation !== owner) return;
          clearTimeout(timer);
          connecting = null;
          const refusal = refusalOf(event?.code);
          if (!ready) reject(refusal ? new RelayRefused(refusal) : new Error('relay connection closed'));
          retire();
          o.onClose(refusal);
        };
      });
    },
    acker,
    close: retire,
    authenticate(token) {
      const rid = `r${++sequence}`;
      return wait(rid, { t: 'auth', token, rid });
    },
    join(pair) {
      const rid = `r${++sequence}`;
      return wait(rid, { t: 'pair.join', pair, rid });
    },
    remove(pair) {
      const rid = `r${++sequence}`;
      return wait(rid, { t: 'pair.remove', pair, rid });
    },
    connected: () => socket !== null,
    /** A request the relay answers ok or refuses, on the Host lane (`host.register`, `host.revoke`). @param {{ t: string, [k: string]: unknown }} m */
    request(m) {
      const rid = `r${++sequence}`;
      return wait(rid, { ...m, rid });
    },
    registerPush(platform, token) {
      const rid = `r${++sequence}`;
      return wait(rid, { t: 'push.register', platform, token, rid });
    },
    unregisterPush() {
      const rid = `r${++sequence}`;
      return wait(rid, { t: 'push.unregister', rid });
    },
    registerActivity(token) {
      const rid = `r${++sequence}`;
      return wait(rid, { t: 'activity.register', token, rid });
    },
    unregisterActivity() {
      const rid = `r${++sequence}`;
      return wait(rid, { t: 'activity.unregister', rid });
    },
    send(frame) {
      return wait(`frame:${frame.pair}:${frame.dir}:${frame.ctr}`, { t: 'frame', ...frame });
    },
  };
}
