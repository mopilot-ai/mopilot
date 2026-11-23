// Allocate, record and clean up native Codex threads started for a Host chat.
import { createRequire } from 'node:module';
import { isBoundSideFork } from './nativeSideChat.mjs';
import { UnsupportedError } from './errors.mjs';
import { HostRefusal } from './hostFs.mjs';

const require = createRequire(import.meta.url);
const { permissionParams } = require('../../electron/harness/codex.cjs');
const { SETUP_TIMEOUT } = require('../../electron/harness/codexIsolatedServer.cjs');
const { guardSend } = require('../../electron/session/contract/inputGuard.cjs');
const { segment, emptyRecord } = require('../../electron/platform/chatRecord.cjs');
const { ignoring } = require('../../electron/ignored.cjs');
const { within } = require('../../electron/host/boundedWait.cjs');
const SIDE_FORK_WAIT_MS = 30_000;

/** @typedef {InstanceType<typeof import('../../electron/harness/codex.cjs').CodexAdapter>} CodexAdapter */

/** @param {CodexAdapter} adapter @param {{ thread?: { id?: string } }} started @param {(id: string) => void} record
 * @param {(id: string) => void | Promise<unknown>} [release] */
export async function recordNewCodexThread(
  adapter,
  started,
  record,
  release = (id) => adapter.threadDelete(id).catch(ignoring('delete an unrecorded Host Codex thread')),
) {
  const nativeId = started?.thread?.id;
  if (typeof nativeId !== 'string' || !nativeId) throw new Error("Codex didn't start a thread.");
  try {
    record(nativeId);
  } catch (error) {
    // It has no recorded owner or turn. Deleting it also frees the native process's resources.
    await release(nativeId);
    throw error;
  }
}

/** @param {CodexAdapter} adapter @param {import('./sessions.mjs').FamilyContext['chats']} chats
 * @param {import('./nativeSideChat.mjs').SideChatSource} source @param {Record<string, unknown>} params @param {() => void} check */
async function forkSideThread(adapter, chats, source, params, check) {
  const timedOut = new HostRefusal(
    'side_chat_fork_timeout',
    'Codex did not finish opening this side chat. Send the message again to retry.',
  );
  let expired = false;
  guardSend(params, () => {
    if (expired) throw timedOut;
    check();
  });
  const available = (id) => typeof id === 'string' && Boolean(id) && id !== source.id && !chats.names(id);
  const requireAvailable = (id) => {
    if (available(id)) return;
    check();
    throw new UnsupportedError('Codex did not return a separate side chat.');
  };
  const release = (id) => {
    if (!available(id)) return;
    // The answer or deletion can wait while another chat claims a native session.
    void adapter.threadDelete(id, () => requireAvailable(id)).catch(ignoring('delete an unrecorded Host Codex side chat'));
  };
  const pending = adapter.fork(params, true, {
    active: () => !expired,
    validate: (result) => requireAvailable(result?.thread?.id),
  });
  const started = await within(pending, SIDE_FORK_WAIT_MS).catch((error) => {
    if (error?.code === SETUP_TIMEOUT) throw timedOut;
    throw error;
  });
  if (started === 'late') {
    expired = true;
    void pending.then((result) => release(result?.thread?.id), ignoring('finish a late Host Codex side chat'));
    throw timedOut;
  }
  return { started, release, requireAvailable };
}

/** @param {CodexAdapter} adapter @param {import('./sessions.mjs').FamilyContext} ctx
 * @param {(chatId: string) => Record<symbol, unknown>} lane
 */
export function createCodexChatStart(adapter, ctx, lane) {
  /** @type {Map<string, Promise<boolean>>} */
  const preparing = new Map();
  return (
    /** @type {{ chatId: string, cwd?: string, check?: () => void, source?: import('./nativeSideChat.mjs').SideChatSource }} */ {
      chatId,
      cwd,
      check = () => undefined,
      source,
    },
  ) => {
    check();
    if (ctx.chats.records.has(chatId)) return Promise.resolve(isBoundSideFork(ctx.chats.record(chatId), source));
    const running = preparing.get(chatId);
    if (running) return running;
    const run = (async () => {
      const params = {
        ...permissionParams(source ? 'read-only' : 'default'),
        // The Host retires the side chat with its journal. Codex must be able to resume it while the app is open.
        ephemeral: false,
        ...(source ? { threadId: source.id, excludeTurns: true, deferGoalContinuation: true } : { cwd: cwd ?? ctx.paths.dataDir }),
        ...lane(source?.chatId ?? chatId),
      };
      if (!source) guardSend(params, check);
      const { started, release, requireAvailable } = source
        ? await forkSideThread(adapter, ctx.chats, source, params, check)
        : { started: await adapter.startThread(params), release: undefined, requireAvailable: undefined };
      await recordNewCodexThread(
        adapter,
        started,
        (nativeId) => {
          check();
          requireAvailable?.(nativeId);
          if (source && started.thread?.ephemeral === true) throw new UnsupportedError('Codex did not return a resumable side chat.');
          const segments = [segment({ kind: 'codex', nativeId })];
          let record;
          if (source) {
            const latest = ctx.chats.record(chatId);
            record = { ...latest, segments, meta: { ...latest.meta, nativeSideFork: source.binding } };
          } else record = emptyRecord(chatId, segments, Date.now());
          if (!ctx.chats.commit(record)) throw new Error("Couldn't record the new chat.");
        },
        release,
      );
      ctx.controller().invalidate();
      return Boolean(source);
    })().finally(() => preparing.delete(chatId));
    preparing.set(chatId, run);
    return run;
  };
}
