// The phone's two requests for direct access to a Host (P2): `machines.enroll` carries the enrollment the phone minted and its
// keys, `machines.forget` takes it away. Parsers only; the Mac's courier is electron/host/phoneEnroll.cjs.
const RELAY_HOST = /^h_[A-Za-z0-9_-]{16,64}$/;
const RELAY_SECRET = /^[A-Za-z0-9_-]{43,128}$/;
const RELAY_PAIR = /^p_[A-Za-z0-9_-]{8,64}$/;
const KEY32 = /^[A-Za-z0-9+/]{43}=$/;
const MAX_URL = 2048;

/** @param {{ bad: (message: string) => Error, machineOf: (v: unknown) => string }} o */
export function phoneEnrollParsers({ bad, machineOf }) {
  const match = (/** @type {unknown} */ v, /** @type {RegExp} */ re, /** @type {string} */ message) => {
    if (typeof v !== 'string' || !re.test(v)) throw bad(message);
    return v;
  };
  const relayOf = (/** @type {any} */ r) => {
    if (!r || typeof r !== 'object') throw bad('That is not a relay enrollment.');
    const m = typeof r.relayUrl === 'string' && r.relayUrl.length <= MAX_URL ? /^(wss?):\/\/([^\s/?#]+)\/[^\s#]*$/.exec(r.relayUrl) : null;
    if (!m || (m[1] === 'ws' && !/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(m[2]))) throw bad('That is not a relay address.');
    return {
      hostId: match(r.hostId, RELAY_HOST, 'That is not a relay host id.'),
      secret: match(r.secret, RELAY_SECRET, 'That is not a relay credential.'),
      pairId: match(r.pairId, RELAY_PAIR, 'That is not a relay pair id.'),
      relayUrl: r.relayUrl,
    };
  };
  return {
    'machines.enroll': (/** @type {any} */ p) => {
      const relay = relayOf(p.relay);
      return {
        hostId: machineOf(p.hostId),
        relay,
        appPub: match(p.appPub, KEY32, 'That is not a public key.'),
        appEphPub: match(p.appEphPub, KEY32, 'That is not a public key.'),
        edPub: match(p.edPub, KEY32, 'That is not a public key.'),
        name: typeof p.name === 'string' && p.name.trim() ? p.name.trim().slice(0, 80) : 'Phone',
      };
    },
    'machines.forget': (/** @type {any} */ p) => ({ hostId: machineOf(p.hostId) }),
  };
}
