// PR monitoring composition: durable storage, background polling, shared-controller delivery, IPC, agent tools and review auto-fix.
const { goalHolds } = require('../../session/goalStatus.cjs');
const { fs } = require('../../platform/ports/fs.cjs');
const path = require('node:path');
const { PrMonitor } = require('../../session/prMonitor.cjs');
const { readPullRequest } = require('../../platform/prGithub.cjs');
const { readStackParents } = require('../../platform/prStackParents.cjs');
const { writeAtomic } = require('../../platform/fsutil.cjs');
const { ownerOf } = require('../../platform/segmentOwner.cjs');
const { killedReason } = require('../../../shared/killSwitch.cjs');
const { parseKind } = require('../../../shared/harnessKind.mjs');
const { guardInput } = require('../../session/contract/inputGuard.cjs');
const { registerPrStack } = require('./prStack.cjs');
const { registerPrActions } = require('./prActions.cjs');
const { registerPrSource } = require('./prSource.cjs');
const { attachReviewAutoFix } = require('../reviewAutoFix.cjs');
const { addHook } = require('../../session/hookChain.cjs');
const { authoredInput } = require('../../session/authoredInput.cjs');

/** Production entrypoint discovered by ipcModules; dependencies are injectable for focused unit tests. */
function register(ipcMain, { app, live, run, broadcastAll, execWindows, isFlagEnabled, readState }) {
  const file = path.join(app.getPath('userData'), 'pr-monitors.json');
  const controller = live.controller;
  const dispatches = new Map();
  // each repository's default branch, where a stack ends; read once per process
  const defaultBranches = new Map();
  let githubTail = Promise.resolve();
  const github = (work) => {
    const task = githubTail.then(work);
    githubTail = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  };
  const exists = (id) => live.chats.records.has(id);
  const scope = (id) => {
    const ref = controller.ref(id);
    const family = parseKind(ref.kind)?.family;
    const driver = live.identity?.driver(family);
    const pinned = driver?.chatInstance?.(ref.id) ?? null;
    const own = controller.adapterOf(id).accountOf?.(id) ?? null;
    // a chat whose kind names one instance (a basic harness: one per harness) is scoped to it; another harness's
    // check moving its status is not this chat's context
    const all = live.identity?.instances(family) ?? [];
    const instances = all.some((i) => i.id === ref.kind) ? all.filter((i) => i.id === ref.kind) : all;
    // the project folder is left out: ref.id names the native session, which keeps its folder (and reading it may wait)
    return JSON.stringify([ref.kind, ref.id, ref.key, ref.instance, live.chats.records.get(id)?.meta.account, pinned, own, instances]);
  };
  const blocked = (id, starting = false) => {
    const rec = live.chats.records.get(id);
    if (!rec) return 'chat deleted';
    const state = live.sessions.get(id);
    if (rec.meta.archived != null) return 'chat archived';
    if (live.peerRuntime.paused.has(id)) return 'stopped by user; send a message to resume';
    if (state.runningElsewhere) return 'running in another app';
    if (state.pendingSwitch) return 'harness switch pending';
    if (state.approvals.length) return 'approval required';
    // main's record of the goal, not a window's report of it; a complete goal holds nothing (#2759)
    if (goalHolds(live.sessions.goalStatus(id))) return 'goal active or paused';
    if (state.turn === 'crashed') return 'harness unavailable';
    if (!starting && (state.turn !== 'idle' || state.queue.length)) return 'chat busy';
    return killedReason(controller.ref(id).kind, isFlagEnabled) || null;
  };
  const monitor = new PrMonitor({
    load: () => {
      try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch (error) {
        if (error?.code === 'ENOENT') return [];
        throw error;
      }
    },
    save: (rows) => writeAtomic(file, JSON.stringify(rows)),
    exists,
    scope,
    blocked,
    read: (url, comments, id, current) => {
      // the folder is read before joining the queue (a slow transcript read holds up no other chat's GitHub read)
      const folder = live.peerRuntime.projectOf(id);
      return github(async () => {
        const cwd = await folder;
        if (!current()) throw new Error('PR monitoring context changed');
        if (!cwd) throw new Error('The chat has no working folder. Open it and choose a project before monitoring.');
        const pr = await readPullRequest(run, cwd, url, comments);
        if (pr.state !== 'OPEN') return { ...pr, parents: [] };
        if (!current()) throw new Error('PR monitoring context changed');
        try {
          return { ...pr, parents: await readStackParents(run, cwd, pr, defaultBranches, current) };
        } catch (error) {
          // the parents are context for the cards, not the monitored PR: the monitor keeps its last stack (see poll)
          // and the card says the stack could not be read
          return { ...pr, parents: null, stackError: error.message };
        }
      });
    },
    make: (id, text, show) => {
      const item = authoredInput(live.chats, id, text, show);
      live.mainRepair?.api?.monitorInput(id, item, monitor.snapshot(id)?.owner);
      broadcastAll('chats:changed', { id, chat: live.chats.get(id) });
      return item;
    },
    deliver: async (id, item, current) => {
      const reason = blocked(id);
      if (reason || !current()) return { started: false, error: reason || 'Chat changed' };
      /** @type {{ attempt: { token: string | null, startAttempt: object } | null, current: () => boolean }} */
      const dispatch = { attempt: null, current: () => current() && !blocked(id, true) };
      const owned = () => {
        const runtime = controller.rt(id);
        return (
          dispatch.current() &&
          dispatch.attempt !== null &&
          runtime.startAttempt === dispatch.attempt.startAttempt &&
          runtime.token === dispatch.attempt.token
        );
      };
      dispatches.set(item.id, { dispatch, owned });
      const release = guardInput(item, owned);
      try {
        return await controller.start(id, item);
      } finally {
        dispatches.delete(item.id);
        release();
      }
    },
    // a PR that needs the user shows in the PR inbox, never as a system notification: only a session's question
    // interrupts the user, and it notifies through its own kind (#3661)
    changed: (id) => broadcastAll('prMonitor:changed', id),
  });
  live.prMonitor = monitor;
  const before = controller.beforeDispatch;
  const beforeDispatch = async (event) => {
    const automatic = dispatches.get(event.item.id);
    if (automatic) {
      const runtime = controller.rt(event.chatId);
      automatic.dispatch.attempt = { token: runtime.token, startAttempt: runtime.startAttempt };
    }
    await before(event);
    if (automatic && !automatic.owned()) throw new Error('Autofix paused because the chat changed');
  };
  controller.beforeDispatch = beforeDispatch;
  // a review's findings applied without a click, through the same gate as Auto-fix (and always in a chat Auto-fix monitors)
  attachReviewAutoFix({ live, monitor, blocked, readState, broadcastAll });
  addHook(controller, 'onFinished', (event) => monitor.afterTurn(event.chatId));
  const validWindow = (event) => {
    if (!execWindows.has(event.sender) || event.sender.isDestroyed()) throw new Error('Unknown app window');
  };
  registerPrStack(ipcMain, { live, monitor, run, scope, validWindow, github });
  registerPrSource(ipcMain, { run, validWindow, github });
  ipcMain.handle('prMonitor:snapshot', (event, id) => {
    validWindow(event);
    return monitor.snapshot(id);
  });
  const configure = (id, patch, owner = null) => {
    const result = monitor.configure(id, { ...patch, owner });
    void monitor.refresh(id);
    return result;
  };
  registerPrActions(ipcMain, {
    live,
    monitor,
    run,
    scope,
    validWindow,
    github,
    configure,
    // the managed worktree's marker names the branch it was cut from; loaded on first use (it brings the pty with it)
    worktreeInfo: (dir) => require('../../platform/git.cjs').worktreeInfo(dir),
  });
  ipcMain.handle('prMonitor:configure', (event, id, patch) => {
    validWindow(event);
    return configure(id, patch);
  });
  ipcMain.handle('prMonitor:refresh', async (event, id) => {
    validWindow(event);
    await monitor.refresh(id);
    return monitor.snapshot(id);
  });
  /** @type {[string, string, string, object, string[], (id: string, args?: any) => any][]} */
  const toolSpecs = [
    [
      'get_pr_monitor',
      'observe',
      'Read this chat’s PR monitor, CI state and autofix delivery errors.',
      {},
      [],
      (id) => monitor.snapshot(id),
    ],
    [
      'set_pr_monitor',
      'act',
      'Bind this chat to a GitHub PR and configure Auto-fix and review feedback. Enable only when requested by the user or repository instructions. Monitoring runs while MoPilot is open. Before ending a turn waiting for CI or a merge, set continuation to a condition (checks_pass or merged) and the already-authorized next steps. It wakes this chat once, including after an app restart. Null cancels it. This grants no merge or release permission; the agent must verify results and update_task_list before continuing.',
      {
        url: { type: 'string' },
        autoFix: { type: 'boolean' },
        addressComments: { type: 'boolean' },
        continuation: {
          anyOf: [
            { type: 'null' },
            {
              type: 'object',
              properties: {
                when: { type: 'string', enum: ['checks_pass', 'merged'] },
                message: { type: 'string', minLength: 1, maxLength: 2000 },
              },
              required: ['when', 'message'],
              additionalProperties: false,
            },
          ],
        },
      },
      ['url'],
      (id, patch) => configure(id, patch, live.mainRepair?.api?.monitorOwner(id) ?? null),
    ],
  ];
  for (const [name, policy, description, properties, required, handler] of toolSpecs) {
    live.capabilities.register({
      name,
      policy,
      description,
      schema: { type: 'object', properties, required, additionalProperties: false },
      authorizesItself: policy === 'act',
      handler: (args, ctx) => {
        if (!ownerOf(live.chats.records, ctx, { current: true })) throw new Error('The caller does not own the current chat segment');
        return handler(ctx.chatId, args);
      },
    });
  }
  const timer = setInterval(() => void monitor.tick(), 60_000);
  timer.unref();
  void monitor.tick();
  app.once('will-quit', () => {
    clearInterval(timer);
    monitor.dispose();
    if (controller.beforeDispatch === beforeDispatch) controller.beforeDispatch = before;
  });
  return monitor;
}

module.exports = { register };
