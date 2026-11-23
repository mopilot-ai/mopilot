// The fake Codex's per-thread approval policy and sandbox, as the app-server keeps them: thread/start and turn/start set
// them, thread/settings/update changes them, and thread/resume falls back to Codex's default sandbox (workspace-write)
// while keeping the approval policy. Each goal round (the first and every one Codex continues with by itself) logs the
// settings it starts on as `fake/goalRun` in $FAKE_CODEX_LOG.
import fs from 'node:fs';

/** thread/start's sandbox mode, as the policy type a turn's sandboxPolicy names. */
const MODE = { 'read-only': 'readOnly', 'workspace-write': 'workspaceWrite', 'danger-full-access': 'dangerFullAccess' };
/** Codex's default for a thread loaded again with no sandbox of its own. */
const DEFAULT_SANDBOX = 'workspaceWrite';

/**
 * Wrap `handlers` (fake-codex.mjs) so threads keep their settings. `goalRound` is told of each turn with no user message:
 * it counts the thread's rounds (`rec.goalRounds`) and, for one that works on the goal (not a compaction), logs the
 * settings it starts on, as Codex runs it on the thread's own.
 * @param {Record<string, (p: any) => any>} handlers
 * @param {string | undefined} logFile
 * @returns {{ goalRound: (rec: any, working: boolean) => void }}
 */
export function withThreadSettings(handlers, logFile) {
  /** @type {Map<string, { sandbox: string, approval: string | null }>} */
  const settings = new Map();
  const of = (threadId) => settings.get(threadId) ?? { sandbox: DEFAULT_SANDBOX, approval: null };
  const set = (threadId, sandbox, approval) => {
    const was = of(threadId);
    settings.set(threadId, { sandbox: sandbox ?? was.sandbox, approval: approval ?? was.approval });
  };
  const goalRun = (threadId) => {
    if (logFile)
      fs.appendFileSync(logFile, `${JSON.stringify({ id: null, method: 'fake/goalRun', params: { threadId, ...of(threadId) } })}\n`);
  };
  const wrap = (method, before, after = () => {}) => {
    const original = handlers[method] ?? (() => ({}));
    handlers[method] = (p) => {
      before(p);
      const result = original(p);
      after(p, result);
      return result;
    };
  };
  wrap(
    'thread/start',
    () => {},
    (p, r) => set(r.thread.id, MODE[p.sandbox], p.approvalPolicy),
  );
  // loaded again: the sandbox is Codex's default, the approval policy the thread's last
  wrap('thread/resume', (p) => settings.set(p.threadId, { ...of(p.threadId), sandbox: DEFAULT_SANDBOX }));
  wrap('turn/start', (p) => set(p.threadId, p.sandboxPolicy?.type, p.approvalPolicy));
  wrap('thread/settings/update', (p) => set(p.threadId, p.sandboxPolicy?.type, p.approvalPolicy));
  return {
    goalRound: (rec, working) => {
      rec.goalRounds = (rec.goalRounds ?? 0) + 1;
      if (working) goalRun(rec.thread.id);
    },
  };
}
