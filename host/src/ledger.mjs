// The Host's dedupe ledger: one append-only JSONL per chat that records each side-effecting request before it acts and after it settles, so a replayed key returns the stored result and a restart never runs a request twice (docs: design/host/index.html, package 2.3).
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** What a caller gets for a request that started before a restart and never settled: it may or may not have happened. */
export const INDETERMINATE = Object.freeze({ state: 'indeterminate' });

/** Refusals the Host makes before it does anything (a harness not installed or signed in, a credential or login it cannot use, an organization identity busy, a limit or a rule, a folder that is not there, a request it cannot serve): the same key may be sent again once the cause is gone. */
export const NOT_DONE = new Set([
  'harness_not_configured',
  // a Host older than the release a MoMo home needs refuses the start before doing anything (#5626)
  'host_too_old',
  'credential_unavailable',
  'login_unavailable',
  'login_signed_out',
  'login_limited',
  'login_removed',
  'not_supported',
  'org_identity_busy',
  'spend_limit',
  'policy_refused',
  'mode_unavailable',
  'image_unavailable',
  'image_fault',
  'outside_roots',
  'not_a_directory',
  'invalid_path',
  'session_journal_unreadable',
  'epoch_store_unreadable',
  'owner_store_unreadable',
  'agent_missing',
  'agent_signed_out',
  'directory_missing',
  'unsupported',
  'unknown_client',
  'stale_epoch',
  'session_storage_unavailable',
  'session_journal_full',
  'session_journal_budget',
  'session_journal_busy',
  'side_chat_starting',
  'side_chat_fork_timeout',
  // Deletion is an idempotent file cleanup: disk repair must permit the same deletion key to finish.
  'session_journal_delete_failed',
]);

/** A key already used for a different method: a client bug, refused rather than answered with another request's result. */
export class KeyReusedError extends Error {
  /** @param {string} key */
  constructor(key) {
    super(`The key ${key} was already used for a different request.`);
    this.name = 'KeyReusedError';
    this.code = 'key_reused';
  }
}

/** @param {string} file @param {string} line */
function append(file, line) {
  const fd = fs.openSync(file, 'a', 0o600);
  try {
    fs.writeSync(fd, `${line}\n`);
    // the intent must be on disk before the effect starts
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * @param {string} dir where the per-chat files live
 * @param {{ report: (problem: string) => void }} o told about each line that could not be read
 */
export function createLedger(dir, { report }) {
  /** @type {Map<string, Map<string, { method: string, state: 'started' | 'completed' | 'failed' | 'refused', result?: unknown, error?: unknown }>>} */
  const chats = new Map();
  /** Requests running in this process, by chat and key: an overlapping duplicate shares their outcome. @type {Map<string, Promise<any>>} */
  const running = new Map();
  /** @param {string} chatId */
  const fileOf = (chatId) => path.join(dir, `${createHash('sha256').update(chatId).digest('hex').slice(0, 32)}.jsonl`);

  /** The chat's entries, read from its file once; a line that does not parse is reported and skipped, the rest kept. @param {string} chatId */
  function open(chatId) {
    const known = chats.get(chatId);
    if (known) return known;
    const entries = new Map();
    const file = fileOf(chatId);
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (e) {
      if (/** @type {any} */ (e).code !== 'ENOENT') throw e;
    }
    for (const [i, line] of text.split('\n').entries()) {
      if (!line) continue;
      try {
        const e = JSON.parse(line);
        if (typeof e?.key !== 'string' || typeof e.method !== 'string' || !['started', 'completed', 'failed', 'refused'].includes(e.state))
          throw new Error('shape');
        entries.set(e.key, { ...entries.get(e.key), ...e });
      } catch {
        report(`Line ${i + 1} of ${file} could not be read and was skipped.`);
      }
    }
    chats.set(chatId, entries);
    return entries;
  }

  /** @param {string} chatId @param {Record<string, unknown> & { key: string, method: string, state: string }} entry */
  function record(chatId, entry) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    append(fileOf(chatId), JSON.stringify(entry));
    const entries = open(chatId);
    entries.set(entry.key, /** @type {any} */ ({ ...entries.get(entry.key), ...entry }));
  }

  return {
    /** The clients (their fingerprints) that sent the chat a request, as the entries say who. @param {string} chatId @returns {string[]} */
    clients: (chatId) => [
      ...new Set([...open(chatId).values()].flatMap((e) => (typeof e.by?.fingerprint === 'string' ? [e.by.fingerprint] : []))),
    ],
    /**
     * A deleted chat keeps no request of its own: its file is replaced by the one entry of the deletion's key (kept so that deletion, sent again, is answered and never run twice), or removed.
     * What the other entries hold (a message's text, a handoff) is the chat's content, so none of it stays.
     * @param {string} chatId @param {string} keepKey
     */
    retire(chatId, keepKey) {
      const file = fileOf(chatId);
      const kept = open(chatId).get(keepKey);
      if (kept) {
        const tmp = `${file}.${process.pid}.tmp`;
        const fd = fs.openSync(tmp, 'w', 0o600);
        try {
          fs.writeSync(fd, `${JSON.stringify(kept)}\n`);
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
        fs.renameSync(tmp, file);
      } else fs.rmSync(file, { force: true });
      chats.set(chatId, new Map(kept ? [[keepKey, kept]] : []));
    },
    /**
     * Runs `act` once for `key`. A key that completed returns its stored result; one that started in an earlier life of
     * the Host and never settled returns INDETERMINATE and is not run again; one running now shares the running call.
     * @template T
     * @param {{ chatId: string, key: string, method: string, by?: { fingerprint: string, name: string, kind: string }, idempotent?: boolean }} id `by`: the client that sent it, on each line; `idempotent`: running it again after a failure, or after a Host that died under it, does what one run does (every step is safe to repeat), so neither is the key's answer
     * @param {() => Promise<T> | T} act
     * @returns {Promise<{ replayed: boolean, result: T | typeof INDETERMINATE | unknown }>}
     */
    async once({ chatId, key, method, by, idempotent = false }, act) {
      const entries = open(chatId);
      const seen = entries.get(key);
      if (seen && seen.method !== method) throw new KeyReusedError(key);
      const live = running.get(`${chatId}\n${key}`);
      if (live) return { replayed: true, result: await live };
      if (seen?.state === 'completed') return { replayed: true, result: seen.result ?? null };
      // a refusal that happened before any effect is not the key's answer: the retry runs the request again
      if (seen?.state === 'failed' && !idempotent)
        throw Object.assign(new Error(String(/** @type {any} */ (seen.error)?.message ?? 'The request failed.')), {
          code: /** @type {any} */ (seen.error)?.code,
        });
      // one that started in an earlier life of the Host and never settled: a request that is safe to run again (a deletion) runs again
      if (seen && seen.state !== 'refused' && !(idempotent && ['started', 'failed'].includes(seen.state)))
        return { replayed: true, result: INDETERMINATE };
      record(chatId, {
        key,
        method,
        state: 'started',
        at: Date.now(),
        ...(by ? { by } : {}),
      });
      const call = (async () => {
        try {
          const result = (await act()) ?? null;
          record(chatId, {
            key,
            method,
            state: 'completed',
            result,
            ...(by ? { by } : {}),
          });
          return result;
        } catch (e) {
          record(chatId, {
            key,
            method,
            ...(by ? { by } : {}),
            state: idempotent || NOT_DONE.has(/** @type {any} */ (e)?.code) ? 'refused' : 'failed',
            error: { code: /** @type {any} */ (e)?.code ?? null, message: String(/** @type {any} */ (e)?.message ?? e) },
          });
          throw e;
        }
      })().finally(() => running.delete(`${chatId}\n${key}`));
      running.set(`${chatId}\n${key}`, call);
      return { replayed: false, result: await call };
    },
  };
}
