// Atomic encrypted phone state over an injected transactional row and device-only key store.
import { fromBase64, fromUtf8, toBase64, utf8 } from './envelope.mjs';

const aad = utf8('mopilot-phone-vault-v1');
const copy = (value) => JSON.parse(JSON.stringify(value));

/**
 * The transaction acquires a cross-process write lock before invoking its callback. It commits the row only when the
 * callback succeeds. A key that exists may be read ahead of the lock and kept (the adapter does: a keychain read inside the lock is slow on a
 * device); a missing key is asked for again while the lock is held, and is only made and written there; a missing key with an existing row
 * fails closed.
 * @param {{ prim: import('./crypto.mjs').Primitives, transaction: (fn: (row: {read: () => Promise<string | null>, write: (value: string) => Promise<void>}) => Promise<any>) => Promise<any>, key: {get: () => Promise<string | null>, set: (value: string) => Promise<void>} }} o
 */
export function createPhoneVault(o) {
  const mutate = (/** @type {(state: any) => any} */ fn) =>
    o.transaction(async (row) => {
      const encrypted = await row.read();
      let encodedKey = await o.key.get();
      if (!encodedKey) {
        if (encrypted !== null) throw new Error('phone vault key unavailable');
        encodedKey = toBase64(o.prim.randomBytes(32));
        await o.key.set(encodedKey);
      }
      const key = fromBase64(encodedKey);
      if (key.length !== 32) throw new Error('invalid phone vault key');
      let state = { identity: null, pending: null, pairs: {}, account: null };
      if (encrypted !== null) {
        let blob;
        try {
          blob = JSON.parse(encrypted);
        } catch {
          throw new Error('invalid phone vault');
        }
        const nonce = fromBase64(blob.nonce);
        if (nonce.length !== 24) throw new Error('invalid phone vault');
        const plain = o.prim.aeadOpen(key, nonce, fromBase64(blob.box), aad);
        if (!plain) throw new Error('invalid phone vault');
        try {
          state = JSON.parse(fromUtf8(plain));
        } catch {
          throw new Error('invalid phone vault');
        }
        if (!state || typeof state !== 'object' || !state.pairs || typeof state.pairs !== 'object') throw new Error('invalid phone vault');
      }
      const result = await fn(state);
      const nonce = o.prim.randomBytes(24);
      const box = o.prim.aeadSeal(key, nonce, utf8(JSON.stringify(state)), aad);
      await row.write(JSON.stringify({ nonce: toBase64(nonce), box: toBase64(box) }));
      return copy(result ?? null);
    });
  return {
    async getIdentity() {
      const identity = await mutate((s) => {
        if (!s.account?.deviceId) throw new Error('phone account required');
        if (!s.identity) {
          const sk = o.prim.randomBytes(32);
          const ed = o.prim.edKeypair();
          s.identity = {
            phoneId: s.account.deviceId,
            x: { sk: toBase64(sk), pk: toBase64(o.prim.x25519Base(sk)) },
            ed: { sk: toBase64(ed.sk), pk: toBase64(ed.pk) },
          };
        }
        return s.identity;
      });
      return {
        phoneId: identity.phoneId,
        x: { sk: fromBase64(identity.x.sk), pk: fromBase64(identity.x.pk) },
        ed: { sk: fromBase64(identity.ed.sk), pk: fromBase64(identity.ed.pk) },
      };
    },
    getInstallId: () =>
      mutate((s) => {
        if (!s.installId) {
          const bytes = o.prim.randomBytes(16);
          bytes[6] = (bytes[6] & 15) | 64;
          bytes[8] = (bytes[8] & 63) | 128;
          const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
          s.installId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
        }
        return s.installId;
      }),
    getPending: () => mutate((s) => s.pending),
    claimPending: (pending) =>
      mutate((s) => {
        if (s.pending) return false;
        if ((s.retiredPairs ?? []).includes(pending.pairId)) throw new Error('pair code was retired');
        s.pending = copy(pending);
        return true;
      }),
    markJoining: (owner) =>
      mutate((s) => {
        if (s.pending?.owner !== owner || s.pending.phase !== 'prepared') throw new Error('stale pairing');
        s.pending.phase = 'joining';
      }),
    clearPrepared: (owner) =>
      mutate((s) => {
        if (s.pending?.owner !== owner || s.pending.phase !== 'prepared') throw new Error('stale pairing');
        s.pending = null;
      }),
    /** The relay refused the join: this phone never joined, so there is nothing to clean up. */
    clearRefused: (owner) =>
      mutate((s) => {
        if (s.pending?.owner !== owner || s.pending.phase !== 'joining') throw new Error('stale pairing');
        s.pending = null;
      }),
    claimCleanup: (owner, pairId) =>
      mutate((s) => {
        if (!s.pending) return null;
        if (s.pending.owner !== owner || s.pending.pairId !== pairId) throw new Error('stale pairing cleanup');
        const retired = s.retiredPairs ?? [];
        if (!retired.includes(s.pending.pairId)) {
          if (retired.length >= 1024) throw new Error('pair retirement storage full');
          retired.push(s.pending.pairId);
        }
        s.retiredPairs = retired;
        const claim = toBase64(o.prim.randomBytes(24));
        s.pending = {
          ...s.pending,
          cleanupFrom: s.pending.phase === 'cleanup' ? s.pending.cleanupFrom : s.pending.phase,
          phase: 'cleanup',
          cleanupClaim: claim,
        };
        return s.pending;
      }),
    finishCleanup: (claim) =>
      mutate((s) => {
        if (s.pending?.phase !== 'cleanup' || s.pending.cleanupClaim !== claim) throw new Error('stale pairing cleanup');
        s.pending = null;
      }),
    savePair: (owner, pair) =>
      mutate((s) => {
        if (s.pending?.owner !== owner || s.pending.phase !== 'joining' || s.pending.pairId !== pair.pairId)
          throw new Error('stale pairing');
        s.pairs[pair.pairId] = copy(pair);
        s.pending = null;
      }),
    getPair: (id) => mutate((s) => (Object.prototype.hasOwnProperty.call(s.pairs, id) ? s.pairs[id] : null)),
    /** Forgets a paired computer and its ratchet state for good; false when it was not paired. */
    removePair: (id) =>
      mutate((s) => {
        if (!Object.prototype.hasOwnProperty.call(s.pairs, id)) return false;
        delete s.pairs[id];
        // the computer is not the one to resume any more, and what was typed for it goes with it
        if (s.lastPair === id) s.lastPair = null;
        if (s.outbox) s.outbox.items = s.outbox.items.filter((item) => item?.pairId !== id);
        return true;
      }),
    pairs: () => mutate((s) => Object.values(s.pairs)),
    updatePair: (id, fn) =>
      mutate(async (s) => {
        if (!Object.prototype.hasOwnProperty.call(s.pairs, id)) throw new Error('unknown pair');
        const result = await fn(copy(s.pairs[id]));
        s.pairs[id] = copy(result.pair);
        return result.value;
      }),
    /** The phone's own enrollments with Hosts, by the machine's id on the Mac (P3). */
    getHosts: () => mutate((s) => s.hosts ?? {}),
    putHost: (machineId, record) =>
      mutate((s) => {
        s.hosts = { ...(s.hosts ?? {}), [machineId]: copy(record) };
      }),
    /** The chats this phone started on each Host (by machine id), kept so it can open them again after a restart; the Mac does not list them. */
    getStarted: () => mutate((s) => s.started ?? {}),
    /** Keeps the chats started on one Host, replacing what was kept for it; an empty list forgets them. */
    setStarted: (machineId, chats) =>
      mutate((s) => {
        const { [machineId]: _gone, ...rest } = s.started ?? {};
        s.started = chats.length ? { ...rest, [machineId]: copy(chats) } : rest;
      }),
    /** Forgets one enrollment, and the chats started on it; false when there was none. */
    removeHost: (machineId) =>
      mutate((s) => {
        if (s.started) delete s.started[machineId];
        if (!s.hosts || !Object.prototype.hasOwnProperty.call(s.hosts, machineId)) return false;
        delete s.hosts[machineId];
        return true;
      }),
    getAccount: () => mutate((s) => s.account),
    /** The computer connected to last, which the app connects to again when it starts; null when none, or the user left it. */
    getLastPair: () => mutate((s) => s.lastPair ?? null),
    setLastPair: (id) =>
      mutate((s) => {
        s.lastPair = id ?? null;
      }),
    /** The messages typed for a chat and not yet accepted by a computer, with the account they belong to; null when there are none. */
    getOutbox: () => mutate((s) => s.outbox ?? null),
    setOutbox: (outbox) =>
      mutate((s) => {
        s.outbox = outbox ? copy(outbox) : null;
      }),
    claimRefresh: (expected) =>
      mutate((s) => {
        if (!s.account || s.account.refreshToken !== expected) throw new Error('account changed');
        // A claim is a durable operation, not a process lease. Every retry must recover the same server rotation.
        if (s.refreshClaim) {
          if (
            s.refreshClaim.protocol !== 1 ||
            s.refreshClaim.deviceId !== s.account.deviceId ||
            typeof s.refreshClaim.owner !== 'string' ||
            !/^[A-Za-z0-9_-]{32}$/.test(s.refreshClaim.owner)
          )
            throw new Error('refresh interrupted; sign in again');
          return s.refreshClaim.owner;
        }
        const owner = toBase64(o.prim.randomBytes(24)).replaceAll('+', '-').replaceAll('/', '_');
        s.refreshClaim = { owner, deviceId: s.account.deviceId, protocol: 1 };
        return owner;
      }),
    completeRefresh: (owner, expected, account) =>
      mutate((s) => {
        if (
          !s.account ||
          s.account.refreshToken !== expected ||
          s.refreshClaim?.owner !== owner ||
          s.refreshClaim.deviceId !== account.deviceId
        )
          throw new Error('account changed');
        s.account = copy(account);
        s.refreshClaim = null;
      }),
    setAccount: (account) =>
      mutate((s) => {
        if (s.account?.user?.id !== account?.user?.id || s.account?.deviceId !== account?.deviceId) {
          s.pairs = {};
          s.pending = null;
          s.identity = null;
          s.refreshClaim = null;
          // the messages typed under the other account, and its computers, are not this one's
          s.outbox = null;
          s.lastPair = null;
          s.hosts = {};
          s.started = {};
        }
        s.account = copy(account);
        s.refreshClaim = null;
      }),
  };
}
