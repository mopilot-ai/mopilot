// The relay path's wire methods (host/src/relayLink.mjs): the credential the app issued and its half of the pair key; the Host answers with its half.
const MAX_URL = 2048;
/** The relay path's ids and credential (relay/src/hosts.mjs checks the same shapes). */
const RELAY_HOST = /^h_[A-Za-z0-9_-]{16,64}$/;
const RELAY_SECRET = /^[A-Za-z0-9_-]{43,128}$/;
const RELAY_PAIR = /^p_[A-Za-z0-9_-]{8,64}$/;
const KEY32 = /^[A-Za-z0-9+/]{43}=$/;

/** @param {{ bad: (message: string) => Error, matchOf: (v: unknown, re: RegExp, message: string) => string }} kit */
export default ({ bad, matchOf }) => {
  /** A 32-byte X25519 public key in base64. @param {unknown} v */
  const keyOf32 = (v) => matchOf(v, KEY32, 'That is not a public key.');
  /** The relay's WebSocket address: `wss://`, or `ws://` to this machine's own loopback only (the credential travels in its header). @param {unknown} v */
  const relayUrlOf = (v) => {
    if (typeof v !== 'string' || v.length > MAX_URL) throw bad('That is not a relay address.');
    const m = /^(wss?):\/\/([^\s/?#]+)\/[^\s#]*$/.exec(v);
    if (!m || (m[1] === 'ws' && !/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(m[2]))) throw bad('That is not a relay address.');
    return v;
  };
  return {
    features: ['relay'],
    methods: {
      // reaching this Host through the relay: an older Host is reached over SSH only
      'host.relayEnroll': {
        access: 'paired',
        requires: ['relay'],
        parse: (/** @type {any} */ p) => ({
          relayUrl: relayUrlOf(p.relayUrl),
          hostId: matchOf(p.hostId, RELAY_HOST, 'That is not a relay host id.'),
          secret: matchOf(p.secret, RELAY_SECRET, 'That is not a relay credential.'),
          pairId: matchOf(p.pairId, RELAY_PAIR, 'That is not a relay pair id.'),
          appPub: keyOf32(p.appPub),
          appEphPub: keyOf32(p.appEphPub),
          // the client the enrollment belongs to (a phone's, P2): where a push for its pair goes
          ...(p.client == null ? {} : { client: matchOf(p.client, /^[0-9a-f]{64}$/, 'That is not a client.') }),
        }),
      },
      'host.relayForget': {
        access: 'paired',
        requires: ['relay'],
        parse: (/** @type {any} */ p) => ({ hostId: matchOf(p.hostId, RELAY_HOST, 'That is not a relay host id.') }),
      },
      'host.relayStatus': { access: 'paired', requires: ['relay'], parse: () => ({}) },
    },
  };
};
