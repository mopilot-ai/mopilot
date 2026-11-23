// Unwired sandbox lifecycle journal: immutable allocation, authenticated-principal scope, revision fences and fail-closed cross-process writes; it executes no VM, trust or chat-ownership effects.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
// a folder is synced where the system can (electron/platform/folderSync.cjs); a Host runs on Linux and macOS
const { syncFolder } = createRequire(import.meta.url)('../../electron/platform/folderSync.cjs');

/** @typedef {{operationId: string, managerId: string, principal: string, chatId: string, expectedEpoch: number, imageDigest: string}} Request */
/** @typedef {{hostId: string, publicKey: string}} Identity */
/** @typedef {{kind: 'exported', transcript: string, work: string, downloads: string} | {kind: 'discarded', approvedBy: string, decisionId: string}} Recovery */
/** @typedef {{request: Request, vmName: string, revision: number, fence: string, state: string, identity?: Identity, recovery?: Recovery}} Record */
const edges = new Map([
  ['requested', ['cloning', 'cancelled']],
  ['cloning', ['booting', 'failed', 'cancelled']],
  ['booting', ['pairing', 'failed', 'cancelled']],
  ['pairing', ['prepared', 'failed', 'cancelled']],
  ['prepared', ['ready', 'failed', 'cancelled']],
  ['ready', ['suspending', 'recovering', 'cancelled']],
  ['suspending', ['suspended', 'failed', 'cancelled']],
  ['suspended', ['resuming', 'recovering', 'cancelled']],
  ['resuming', ['prepared', 'failed', 'cancelled']],
  ['failed', ['recovering']],
  ['cancelled', ['recovering']],
  ['recovering', ['recovered']],
  ['recovered', ['destroying']],
  ['destroying', ['destroyed']],
  ['destroyed', []],
]);
const text = (/** @type {unknown} */ x) => typeof x === 'string' && x.length > 0;
/** The name binds to the immutable lifecycle operation, never a chat's native harness id. @param {Request} request */
const nameOf = (request) =>
  `mopilot-sbx-${crypto
    .createHash('sha256')
    .update(JSON.stringify([request.managerId, request.operationId]))
    .digest('hex')
    .slice(0, 24)}`;
/** @param {unknown} value @returns {asserts value is Request} */
function requestValid(value) {
  const r = /** @type {Request} */ (value);
  if (
    !r ||
    !['operationId', 'managerId', 'principal', 'chatId', 'imageDigest'].every((key) => text(r[key])) ||
    !Number.isSafeInteger(r.expectedEpoch) ||
    r.expectedEpoch < 0
  )
    throw new Error('Invalid sandbox lifecycle request');
}
/** Recovery is durable evidence, not a hint: parse the same contract on load and before every write.
 * @param {Recovery | undefined} recovery @param {string} principal @param {boolean} required
 */
function recoveryValid(recovery, principal, required) {
  if (recovery === undefined && !required) return;
  const exported = recovery?.kind === 'exported' && [recovery.transcript, recovery.work, recovery.downloads].every(text);
  const discarded = recovery?.kind === 'discarded' && recovery.approvedBy === principal && text(recovery.decisionId);
  if (!exported && !discarded) throw new Error('Durable recovery or explicit owner discard is required');
}
/** These persisted fields contain scalar evidence only; field order is immaterial. @param {object} a @param {object} b */
const sameFields = (a, b) =>
  Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((key) => Object.hasOwn(b, key) && a[key] === b[key]);
/** @param {Record} r */
function recordValid(r) {
  requestValid(r?.request);
  if (r.vmName !== nameOf(r.request) || !Number.isSafeInteger(r.revision) || r.revision < 0 || !text(r.fence) || !edges.has(r.state))
    throw new Error('Invalid sandbox lifecycle record');
  if (r.identity !== undefined && (!r.identity || !text(r.identity.hostId) || !text(r.identity.publicKey)))
    throw new Error('Invalid guest identity');
  if (['prepared', 'ready'].includes(r.state) && !r.identity) throw new Error('Guest identity is not recorded');
  recoveryValid(r.recovery, r.request.principal, ['recovered', 'destroying', 'destroyed'].includes(r.state));
}
/**
 * The caller must supply an already-authenticated principal. This store is not a pairing or authorization endpoint.
 * A crash-left lock requires explicit recovery; never steal a lock based on a pid or elapsed time.
 * @param {{file: string}} o
 */
export function createSandboxJournal({ file }) {
  /** @template T @param {(records: Record[]) => {value: T, changed: boolean}} action */
  function transaction(action) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const lock = `${file}.lock`;
    const fd = fs.openSync(lock, 'wx', 0o600);
    const tmp = `${file}.${crypto.randomUUID()}.tmp`;
    try {
      /** @type {Record[]} */
      let records = [];
      try {
        records = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch (error) {
        if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw error;
      }
      if (!Array.isArray(records)) throw new Error('Invalid sandbox journal');
      const ids = new Set();
      const names = new Set();
      for (const record of records) {
        recordValid(record);
        if (ids.has(record.request.operationId) || names.has(record.vmName)) throw new Error('Conflicting sandbox journal ownership');
        ids.add(record.request.operationId);
        names.add(record.vmName);
      }
      const result = action(records);
      if (result.changed) {
        const output = fs.openSync(tmp, 'wx', 0o600);
        try {
          fs.writeFileSync(output, JSON.stringify(records));
          fs.fsyncSync(output);
        } finally {
          fs.closeSync(output);
        }
        fs.renameSync(tmp, file);
        syncFolder(path.dirname(file), { fs });
      }
      return structuredClone(result.value);
    } finally {
      try {
        fs.rmSync(tmp, { force: true });
      } finally {
        try {
          fs.closeSync(fd);
        } finally {
          fs.unlinkSync(lock);
        }
      }
    }
  }
  /** @param {Record[]} records @param {string} principal @param {string} operationId */
  function owned(records, principal, operationId) {
    const record = records.find((r) => r.request.operationId === operationId);
    if (!record || record.request.principal !== principal) throw new Error('Sandbox operation unavailable to this principal');
    return record;
  }
  return {
    /** Exact replay returns pending or terminal state; a conflicting request never creates a second allocation. @param {Request} request */
    reserve(request) {
      requestValid(request);
      return transaction((records) => {
        const old = records.find((r) => r.request.operationId === request.operationId);
        if (old) {
          if (
            Object.keys(old.request).some((key) => old.request[key] !== request[key]) ||
            Object.keys(request).length !== Object.keys(old.request).length
          )
            throw new Error('Sandbox operation request conflicts');
          return { value: old, changed: false };
        }
        if (records.some((r) => r.request.chatId === request.chatId && !['destroyed', 'cancelled', 'failed'].includes(r.state)))
          throw new Error('Chat already has a pending sandbox operation');
        /** @type {Record} */
        const record = {
          request: structuredClone(request),
          vmName: nameOf(request),
          revision: 0,
          fence: crypto.randomUUID(),
          state: 'requested',
        };
        records.push(record);
        return { value: record, changed: true };
      });
    },
    /** @param {string} principal @param {string} operationId */
    read(principal, operationId) {
      return transaction((records) => ({ value: owned(records, principal, operationId), changed: false }));
    },
    /**
     * Persists intent/outcome only. Registry and chat effects still need their own authoritative CAS using the captured fence.
     * @param {string} principal @param {string} operationId @param {number} revision @param {string} fence
     * @param {{state: string, identity?: Identity, recovery?: Recovery}} next
     */
    advance(principal, operationId, revision, fence, next) {
      return transaction((records) => {
        const old = owned(records, principal, operationId);
        if (old.revision !== revision || old.fence !== fence) throw new Error('Sandbox lifecycle fence is retired');
        if (!edges.get(old.state)?.includes(next.state)) throw new Error('Invalid sandbox lifecycle transition');
        const identity = next.identity ?? old.identity;
        if (
          old.identity &&
          next.identity &&
          (old.identity.hostId !== next.identity.hostId || old.identity.publicKey !== next.identity.publicKey)
        )
          throw new Error('Guest identity changed');
        if (['prepared', 'ready'].includes(next.state) && !identity) throw new Error('Guest identity is not recorded');
        const recovery = next.recovery ?? old.recovery;
        if (old.recovery && next.recovery !== undefined && !sameFields(old.recovery, next.recovery))
          throw new Error('Recorded recovery evidence changed');
        const record = { ...old, state: next.state, identity, recovery, revision: old.revision + 1, fence: crypto.randomUUID() };
        recordValid(record);
        records[records.indexOf(old)] = record;
        return { value: record, changed: true };
      });
    },
  };
}
