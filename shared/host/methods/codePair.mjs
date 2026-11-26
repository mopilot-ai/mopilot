// The wire declaration of pairing two Macs by an 8-character code, the controlled Mac's side (feature `codePair`, R2b of #5576): the Host makes an offer at the relay and shows a code, runs the protocol when another Mac types it, tells the connection that made the offer who is asking and the safety number, and adds that Mac as a `controller` only when told to allow it WITH a proof the person gave in person. Only the CLI on this machine (the app's own local connection, by the token beside the socket) may call these methods; every other kind is refused (host/src/methods/codePair.mjs), and a feature the Host was not built with is not offered.
export const CODE_PAIR_FEATURE = 'codePair';
/** The most an approval proof may be as JSON: a signature and what it covers. */
export const MAX_APPROVAL = 1500;
const MAX_TOKEN = 4096;

/** @param {{ bad: (message: string) => Error, matchOf: (v: unknown, re: RegExp, message: string) => string }} kit */
export default ({ bad, matchOf }) => {
  const OFFER = /^r_[A-Za-z0-9_-]{22}$/;
  /** The relay's HTTP address: `https://`, or `http://` to this machine's own loopback only (a test relay), no path, query or credentials. @param {unknown} v */
  const baseOf = (v) => {
    if (typeof v !== 'string' || v.length > 2048) throw bad('That is not a relay address.');
    const m = /^(https?):\/\/([^\s/?#@]+)\/?$/.exec(v);
    if (!m || (m[1] === 'http' && !/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(m[2]))) throw bad('That is not a relay address.');
    return `${m[1]}://${m[2]}`;
  };
  const offerOf = (/** @type {unknown} */ v) => matchOf(v, OFFER, 'That is not an offer.');
  return {
    features: [CODE_PAIR_FEATURE],
    methods: {
      'host.codePair.offer': {
        access: /** @type {const} */ ('paired'),
        requires: [CODE_PAIR_FEATURE],
        parse: (/** @type {any} */ p) => {
          if (typeof p.token !== 'string' || p.token.length < 1 || p.token.length > MAX_TOKEN) throw bad('That is not an account token.');
          return { relayUrl: baseOf(p.relayUrl), token: p.token };
        },
      },
      'host.codePair.answer': {
        access: /** @type {const} */ ('paired'),
        requires: [CODE_PAIR_FEATURE],
        parse: (/** @type {any} */ p) => {
          if (typeof p.accept !== 'boolean') throw bad('Allow or do not allow.');
          if (
            p.approval != null &&
            (typeof p.approval !== 'object' || Array.isArray(p.approval) || JSON.stringify(p.approval).length > MAX_APPROVAL)
          )
            throw bad('That is not an approval.');
          return { offerId: offerOf(p.offerId), accept: p.accept, ...(p.approval == null ? {} : { approval: p.approval }) };
        },
      },
      'host.codePair.cancel': {
        access: /** @type {const} */ ('paired'),
        requires: [CODE_PAIR_FEATURE],
        parse: (/** @type {any} */ p) => ({ offerId: offerOf(p.offerId) }),
      },
      'host.codePair.approvalText': {
        access: /** @type {const} */ ('paired'),
        requires: [CODE_PAIR_FEATURE],
        parse: (/** @type {any} */ p) => ({ offerId: offerOf(p.offerId) }),
      },
      'host.codePair.enrol': {
        access: /** @type {const} */ ('paired'),
        requires: [CODE_PAIR_FEATURE],
        parse: (/** @type {any} */ p) => {
          const b64 = (/** @type {unknown} */ v, /** @type {number} */ max) =>
            matchOf(v, new RegExp(`^[A-Za-z0-9+/]{1,${max}}={0,2}$`), 'That is not a key.');
          if (typeof p.weak !== 'boolean') throw bad('Say whether the key is kept in software.');
          return { key: b64(p.key, 200), weak: p.weak, signature: b64(p.signature, 200) };
        },
      },
      'host.codePair.resetApproval': { access: /** @type {const} */ ('paired'), requires: [CODE_PAIR_FEATURE], parse: () => ({}) },
      'host.codePair.status': { access: /** @type {const} */ ('paired'), requires: [CODE_PAIR_FEATURE], parse: () => ({}) },
      // "Allow connections" as the app on this Mac has it: the Host keeps it and makes no code while it is off
      'host.codePair.connections': {
        access: /** @type {const} */ ('paired'),
        requires: [CODE_PAIR_FEATURE],
        parse: (/** @type {any} */ p) => {
          if (typeof p.open !== 'boolean') throw bad('Say whether connections are allowed.');
          // the fingerprint of this Mac's app's own key: the one paired client "Allow connections" off does not keep out
          if (p.app != null && (typeof p.app !== 'string' || !/^[0-9a-f]{64}$/.test(p.app))) throw bad('That is not a client fingerprint.');
          return { open: p.open, ...(p.app == null ? {} : { app: p.app }) };
        },
      },
    },
  };
};
