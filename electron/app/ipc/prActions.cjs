// Create and merge a chat's pull request from a window's click: window-only IPC (no agent tool), one action per chat, bound to the chat's scope.
const { draftPullRequest, createPullRequest } = require('../../platform/prCreate.cjs');
const { mergePullRequest } = require('../../platform/prMerge.cjs');

const CHANGED = 'The chat or its pull request changed. Try again.';

/**
 * The same service for every harness: the chat's folder comes from its current adapter, GitHub from the shared queue.
 * These are deliberately not registered as capabilities: a merge and a new pull request need the user's own click.
 */
function registerPrActions(ipcMain, { live, monitor, run, scope, validWindow, github, configure, worktreeInfo }) {
  /** chats with a create or merge in flight: a second click waits for the first's answer instead of racing it */
  const busy = new Set();
  const exclusive = async (id, work) => {
    if (busy.has(id)) throw new Error('Another pull request action is still running for this chat.');
    busy.add(id);
    try {
      return await work();
    } finally {
      busy.delete(id);
    }
  };
  /** The chat's folder with the owner that retires this action: the chat, its harness scope and its PR binding. */
  const capture = async (id, tracked) => {
    if (!live.chats.records.has(id)) throw new Error('This chat is unavailable');
    const ownScope = scope(id);
    const binding = monitor.bindingTokens.get(id);
    const current = () =>
      !monitor.disposed &&
      live.chats.records.has(id) &&
      monitor.bindingTokens.get(id) === binding &&
      (tracked === undefined || monitor.snapshot(id)?.url === tracked) &&
      scope(id) === ownScope;
    if (!current()) throw new Error(CHANGED);
    const cwd = await live.peerRuntime.projectOf(id);
    if (!current()) throw new Error(CHANGED);
    if (!cwd) throw new Error('The chat has no working folder. Choose a project first.');
    return { cwd, current };
  };
  /** The branch of the open PR the chat that started this one tracks: where a linked session's PR stacks. */
  const stackParent = (id) => {
    const child = live.orchestrator?.journal.child(id);
    const pr = child && !child.detached ? monitor.snapshot(child.parentId)?.pr : null;
    return pr?.state === 'OPEN' ? pr.headRefName : null;
  };
  // only gh joins the GitHub queue: a slow push must not hold up every chat's PR read
  const queued = (cmd, args, opts) => (cmd === 'gh' ? github(() => run(cmd, args, opts)) : run(cmd, args, opts));
  const draft = async (id) => {
    const { cwd, current } = await capture(id);
    const result = await draftPullRequest(run, cwd, { sourceBranch: worktreeInfo(cwd)?.sourceBranch, stackParent: stackParent(id) });
    if (!current()) throw new Error(CHANGED);
    return result;
  };
  const create = (id, input) =>
    exclusive(id, async () => {
      const { cwd, current } = await capture(id);
      const result = await createPullRequest(queued, cwd, input);
      if (result.status !== 'created' && result.status !== 'exists') return result;
      // the pull request exists on GitHub whatever happened here; it binds only to the chat that asked, as it was
      if (!current()) return { ...result, bound: false };
      try {
        configure(id, { url: result.url });
      } catch {
        // the monitor's store could not take it: the pull request is still real, and its link is the answer
        return { ...result, bound: false };
      }
      return { ...result, bound: true };
    });
  const merge = (id, url, head) =>
    exclusive(id, async () => {
      const { cwd, current } = await capture(id, url);
      const result = await github(() => mergePullRequest(run, cwd, url, head, current));
      // merged or refused, the rows then show GitHub's answer rather than the read the click was made on; the click's
      // own answer does not wait for that read (its stack, its comments, a follow-up it may start)
      if (current()) void monitor.refresh(id, true);
      return result;
    });
  ipcMain.handle('prMonitor:createDraft', (event, id) => {
    validWindow(event);
    return draft(id);
  });
  ipcMain.handle('prMonitor:create', (event, id, input) => {
    validWindow(event);
    return create(id, input);
  });
  ipcMain.handle('prMonitor:merge', (event, id, url, head) => {
    validWindow(event);
    return merge(id, url, head);
  });
}

module.exports = { registerPrActions, registeredBy: 'prMonitor' };
