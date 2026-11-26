// Owns what a machine's row says while its Host refuses this app's proof (#5744: Allow connections off, a pairing removed there, a key this app cannot read), heard on the live connection or a one-off session: the row is attention with the cause and its fix, the live connection asks again on a timer, and an accepted proof puts the row back. A machine paired by code whose Host removed this Mac (its relay link answers `linkRemoved`, #5747) has its relay pair revoked and stays attention until it is removed here. It follows each connection beside linkWatch.cjs, which keeps the drop time.
const { clock } = require('../platform/ports/clock.cjs');
const { createLinkWatch } = require('./linkWatch.cjs');
const { ignoring, noteIgnored } = require('../ignored.cjs');

/** While a proof is refused it is asked again this often, so the row does not wait for the next message to come back (the Host writes one audit line a minute for it). */
const PROOF_RETRY_MS = 30_000;

/** What the row says for each refusal: the cause naming the machine, and where it is fixed. @type {Record<string, (machine: string) => string>} */
const ROW_WORDS = {
  connections_off: (m) => `Connections from other Macs are off on ${m}. Turn on Allow connections in its Settings › Connections.`,
  unknown_client: (m) => `${m} doesn’t know this Mac any more. Pair with it again in Settings › My machines.`,
  key_unreadable: (m) => `This Mac can’t read its key for ${m}. Unlock the keychain.`,
};
/** A machine paired by code whose Host removed this Mac: Remove in the row is the fix. @param {string} m */
const REMOVED_WORDS = (m) => `${m} removed this Mac. Remove it here, then pair again with a new code if you need it.`;

/** Any other refusal of the proof (a proof the Host could not check, an older Host, another machine at that address). @param {string} m */
const OTHER_WORDS = (m) => `${m} didn’t accept this Mac’s key. Pair with it again in Settings › My machines.`;

/** @param {string} code @param {string} machine */
const proofLine = (code, machine) => (Object.hasOwn(ROW_WORDS, code) ? ROW_WORDS[code] : OTHER_WORDS)(machine);

/** The answers of a one-off session (hostSession.cjs) that are the Host refusing this app's proof, not the connection failing. */
const SESSION_PROOF_CODES = new Set(['connections_off', 'unknown_client', 'bad_proof']);

/**
 * @typedef {{ state: () => string, onState: (fn: (s: string) => void) => () => void, onRefused: (fn: (e: (Error & { code?: unknown }) | null) => void) => () => void, status: () => Promise<unknown> }} WatchedHost
 * @typedef {{ peerRemoved: (destination: string) => Promise<boolean>, removedByPeer: (destination: string) => boolean }} RemovedPaths
 * @param {Parameters<typeof createLinkWatch>[0] & { relay?: RemovedPaths | null }} o `onChange` is also told when a machine's proof answer changes; `relay`: the relay paths (relayPaths.cjs), none without a relay
 */
function createConnectionWatch(o) {
  const links = createLinkWatch(o);
  /** A refusal that says the Host removed this Mac, on a machine paired by code: its relay pair goes (this app's to revoke), and the row says so; true when it was one. @param {string} id @param {any} e */
  const removedBy = (id, e) => {
    if (!o.relay || !id.startsWith('relay:') || e?.details?.linkRemoved !== true) return false;
    o.relay.peerRemoved(id).then(
      () => o.onChange(),
      (error) => noteIgnored('revoke the relay pair of a machine that removed this Mac', error),
    );
    return true;
  };
  /** The refusal each machine's Host last gave this app's proof, from its live connection or a one-off session (the last answer wins: both ask the same Host). @type {Map<string, string>} */
  const codes = new Map();
  /** @param {string} id @param {string | null} code */
  const heard = (id, code) => {
    if (code === (codes.get(id) ?? null)) return;
    if (code) codes.set(id, code);
    else codes.delete(id);
    o.onChange();
  };
  return {
    droppedAt: links.droppedAt,
    /** Follow a machine's connection: its drops (linkWatch.cjs) and its proof answers; returns what ends the following. @param {string} id @param {WatchedHost} host */
    watch(id, host) {
      const unlink = links.watch(id, host);
      /** @type {any} */
      let timer = null;
      // a request that needs trust proves the key once more (remoteTrust.cjs); still refused, the row already says why, and any other failure is noted
      const ask = () => void host.status().catch(ignoring('ask a machine again whether it accepts this app', Object.keys(ROW_WORDS)));
      const off = host.onRefused((e) => {
        const code = e ? String(e.code) : null;
        // a machine that removed this Mac is not asked again: its pair is gone, and only Remove here changes that
        const gone = removedBy(id, e);
        if (code && !timer && !gone) timer = clock.setInterval(ask, PROOF_RETRY_MS);
        if (!code || gone) clock.clearInterval(timer), (timer = null);
        heard(id, code);
      });
      return () => {
        unlink();
        off();
        clock.clearInterval(timer);
        codes.delete(id);
      };
    },
    /**
     * The handlers of a one-off session's opening (machines.cjs openPaired): a proof refused there is the same answer, and one accepted clears it; any other failure says nothing of the proof. `next` goes on with the opened session.
     * @template S, T @param {string} id @param {(session: S) => T} next @returns {[(session: S) => T, (error: any) => never]}
     */
    session: (id, next) => [
      (s) => (heard(id, null), next(s)),
      (e) => {
        if (SESSION_PROOF_CODES.has(e?.code)) removedBy(id, e), heard(id, e.code);
        throw e;
      },
    ],
    /**
     * The list's rows with each refused machine as attention, saying why; an offline machine stays offline (its connection is not what it is waiting on).
     * @template {{ id: string, name: string, status: string, note: string }} R @param {R[]} rows @returns {R[]}
     */
    rows: (rows) =>
      rows.map((r) => {
        if (o.relay?.removedByPeer(r.id)) return { ...r, status: 'attention', note: REMOVED_WORDS(r.name), peerRemoved: true };
        const code = codes.get(r.id);
        return code && r.status !== 'offline' ? { ...r, status: 'attention', note: proofLine(code, r.name) } : r;
      }),
  };
}

module.exports = { createConnectionWatch, proofLine, PROOF_RETRY_MS, REMOVED_WORDS };
