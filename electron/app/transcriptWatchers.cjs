// External transcript watching: per-thread Codex rollout subscriptions and Codex/Claude reconciliation using current session services.
const path = require('node:path');
const { fs } = require('../platform/ports/fs.cjs');
const { claudeTailRunning, tailLines } = require('../session/contract/reconcile.cjs');

/**
 * @param {{ broadcast: (channel: string, ...args: any[]) => void, claude: Pick<ReturnType<typeof import('../harness/claude/index.cjs').createClaudeHarness>, 'ownWrites'>,
 *   live: { readonly external: InstanceType<typeof import('../session/contract/reconcile.cjs').ExternalWrites> | null,
 *           readonly controller: InstanceType<typeof import('../session/controller.cjs').ChatController>,
 *           readonly codex: InstanceType<typeof import('../harness/codex.cjs').CodexAdapter> } }} o
 *   live getters retain startup/replacement binding rather than capturing services before they are assigned.
 */
function createTranscriptWatchers({ broadcast, claude, live }) {
  /* A Codex thread another client is writing only changes on disk: watch its rollout file. */
  const rolloutWatchers = new Map();
  function watchRollout(threadId, file) {
    if (rolloutWatchers.has(threadId)) return true;
    // only Codex session logs
    if (typeof file !== 'string' || !file.endsWith('.jsonl') || !file.includes(`${path.sep}sessions${path.sep}`)) return false;
    try {
      /** @type {import('node:fs').FSWatcher & { timer?: NodeJS.Timeout }} */
      const w = fs.watch(file, () => {
        if (rolloutWatchers.get(threadId) !== w) return;
        clearTimeout(w.timer);
        w.timer = setTimeout(() => {
          broadcast('codex:rollout', threadId);
          reconcileCodex(threadId, file);
        }, 250);
      });
      // a failed watcher (the file went away) is let go, so the thread can be watched again
      w.on('error', () => rolloutWatchers.get(threadId) === w && unwatchRollout(threadId));
      rolloutWatchers.set(threadId, w);
      reconcileCodex(threadId, file);
      return true;
    } catch {
      return false;
    }
  }
  function unwatchRollout(threadId) {
    const w = rolloutWatchers.get(threadId);
    clearTimeout(w?.timer);
    w?.close();
    rolloutWatchers.delete(threadId);
    live.external?.forget(live.controller.chatOf(threadId), { kind: 'codex', key: threadId });
  }
  /** Another Codex client wrote the thread: is it running a turn on it? */
  const reconcileCodex = (threadId, file) =>
    live.external?.reconcile(live.controller.chatOf(threadId), file, () => live.codex.runningElsewhere(threadId), {
      kind: 'codex',
      key: threadId,
    });
  /** Another app wrote a Claude transcript: is its tail mid-turn? */
  const reconcileClaude = (key, file) =>
    live.external?.reconcile(live.controller.chatOf(key), file, () => !claude.ownWrites(key) && claudeTailRunning(tailLines(file)), {
      kind: 'claude',
      key,
    });
  const forgetClaude = (key) => live.external?.forget(live.controller.chatOf(key), { kind: 'claude', key });

  return { watchRollout, unwatchRollout, reconcileClaude, forgetClaude, rolloutWatchers };
}

module.exports = { createTranscriptWatchers };
