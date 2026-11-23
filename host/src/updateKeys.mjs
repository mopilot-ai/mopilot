// The keys a Host takes updates from, and how they change (key rotation): the update key file, every desktop app paired with this Host (a phone or the CLI is never an update key), and the keys a signed update added (`nextKey`), less the ones a signed update revoked. Each key has an id (a paired client's fingerprint) and a time this Host last heard from it; a key not heard from for 180 days is refused for updates (shared/host/updateSignature.mjs). The store is `<config>/update-keys.json` (0600); the key file and the pairing stay as they are.
import { createPublicKey } from 'node:crypto';
import path from 'node:path';
import { keyIdOf, checkManifest } from '../../shared/host/updateSignature.mjs';
import { createPairing } from './pairing.mjs';
import { withTrustWrite } from './trustWrite.mjs';
import { readPairing, readUpdateKeys, writeTrustState } from './trustState.mjs';
import { commitTrust } from './trustRecovery.mjs';

/** A key that was seen is not written down again for this long: every connection authenticates, and none should write a file. */
const SEEN_EVERY_MS = 60 * 60 * 1000;

/** @typedef {{ added: { id: string, pem: string }[], revoked: string[], seen: Record<string, number> }} State */

/** The PEM of a base64 SPKI DER key, as a paired client's is kept. @param {string} der */
const pemOf = (der) =>
  createPublicKey({ key: Buffer.from(der, 'base64'), format: 'der', type: 'spki' })
    .export({ type: 'spki', format: 'pem' })
    .toString();

/**
 * @param {object} o
 * @param {string} o.configDir
 * @param {() => number} [o.now]
 * @param {() => string | null} o.fileKey the update key file's PEM, null when there is none (update.mjs readUpdateKey)
 */
export function createUpdateKeys({ configDir, now = Date.now, fileKey }) {
  const file = path.join(configDir, 'update-keys.json');

  const load = () => readUpdateKeys(configDir);
  /** @param {State} state */
  const save = (state) => writeTrustState(file, state);

  const store = {
    /**
     * Every key this Host takes an update from now, with when it last heard from it. A key seen for the first time counts from now, so a Host that had paired apps before this existed does not refuse them all at once.
     * @returns {import('../../shared/host/updateSignature.mjs').TrustedKey[]}
     */
    entries() {
      const state = load();
      /** @type {Map<string, string>} */
      const pems = new Map();
      const fromFile = fileKey();
      // the key file is the administrator's own: there is no app to pair again, so it is never stale
      const fileId = fromFile ? keyIdOf(fromFile) : '';
      if (fromFile) pems.set(fileId, fromFile);
      for (const der of createPairing({ configDir }).desktopKeys()) pems.set(keyIdOf(pemOf(der)), pemOf(der));
      for (const k of state.added) pems.set(k.id, k.pem);
      for (const id of state.revoked) pems.delete(id);
      const fresh = [...pems.keys()].filter((id) => id !== fileId && state.seen[id] === undefined);
      if (fresh.length > 0) save({ ...state, seen: { ...state.seen, ...Object.fromEntries(fresh.map((id) => [id, now()])) } });
      return [...pems].map(([id, pem]) => ({ id, pem, lastSeen: id === fileId ? null : load().seen[id] }));
    },
    /** This Host heard from the key `id` (an app authenticated, or a manifest it signed was taken). @param {string} id */
    markSeen(id) {
      const state = load();
      if (now() - (state.seen[id] ?? 0) < SEEN_EVERY_MS) return;
      save({ ...state, seen: { ...state.seen, [id]: now() } });
    },
    /**
     * What a signed update says of keys, applied once the update is taken: `nextKey` is trusted from now on, to sign and to connect (it must be an Ed25519 public key), and every id in `revoke` is not, to sign or to connect, except the key that signed the update (that would lock the Host out of its own update).
     * @param {{ signedBy: string, nextKey?: string, revoke?: string[] }} change
     */
    apply({ signedBy, nextKey, revoke = [] }) {
      const state = load();
      const drop = revoke.filter((id) => id !== signedBy);
      let added = state.added.filter((k) => !drop.includes(k.id));
      const pairing = readPairing(configDir);
      const clients = { ...pairing.clients };
      if (nextKey) {
        // checkManifest has seen that it is an Ed25519 public key
        const id = keyIdOf(nextKey);
        if (!state.revoked.includes(id) && !drop.includes(id) && !added.some((k) => k.id === id)) {
          added = [...added, { id, pem: nextKey }];
          // the app's next key connects too: a rotation that left it unknown to the Host would lock the app out
          clients[id] ??= {
            key: createPublicKey(nextKey).export({ type: 'spki', format: 'der' }).toString('base64'),
            name: '',
            kind: 'desktop',
            addedAt: now(),
            addedBy: signedBy,
          };
        }
      }
      // a revoked key stops connecting as well as stops signing
      for (const id of drop) delete clients[id];
      commitTrust(configDir, {
        pairing: { ...pairing, clients },
        keys: { added, revoked: [...new Set([...state.revoked, ...drop])], seen: state.seen },
      });
    },
    /** The ids of the keys this Host no longer trusts. */
    revoked: () => [...load().revoked],
  };
  return {
    /** Revalidate live authority and floor, then run acceptance synchronously under the same owner.
     * @template T
     * @param {Record<string, any>} manifest
     * @param {{ hostId: string, now: () => number, floor: () => { seq: number, sha256: string } | null }} context
     * @param {() => T} accept must be synchronous; network fetches stay outside this lock
     * @returns {T}
     */
    withCurrentTrust(manifest, context, accept) {
      return withTrustWrite(configDir, () => {
        const verdict = checkManifest(manifest, {
          keys: store.entries(),
          hostId: context.hostId,
          now: context.now(),
          floor: context.floor(),
        });
        if (!verdict.ok)
          throw Object.assign(
            new Error(
              'The Host’s trust or update eligibility changed while the update was prepared. No update was accepted; reconnect and try again.',
            ),
            { code: 'update_trust_changed' },
          );
        return accept();
      });
    },
    entries: () => withTrustWrite(configDir, () => store.entries()),
    markSeen: (/** @type {string} */ id) => withTrustWrite(configDir, () => store.markSeen(id)),
    apply: (/** @type {Parameters<typeof store.apply>[0]} */ change) => withTrustWrite(configDir, () => store.apply(change)),
    revoked: () => withTrustWrite(configDir, () => store.revoked()),
  };
}
