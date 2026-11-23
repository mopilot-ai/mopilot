// Shared PR stacking IPC and tools: capture the tracked URL and current chat scope before GitHub work.
const { createPrStacker, assertPrStackCurrent } = require('../../platform/prStack.cjs');
const { ownerOf } = require('../../platform/segmentOwner.cjs');

function registerPrStack(ipcMain, { live, monitor, run, scope, validWindow, github }) {
  const stacker = createPrStacker(run);
  const capture = async (id, url, signal) => {
    const ownScope = scope(id);
    const binding = monitor.bindingTokens.get(id);
    const current = () =>
      !signal?.aborted &&
      !monitor.disposed &&
      live.chats.records.has(id) &&
      monitor.bindingTokens.get(id) === binding &&
      monitor.snapshot(id)?.url === url &&
      scope(id) === ownScope;
    assertPrStackCurrent(current);
    const cwd = await live.peerRuntime.projectOf(id);
    assertPrStackCurrent(current);
    if (!cwd) throw new Error('The chat has no working folder. Choose a project before stacking.');
    return { cwd, current };
  };
  const candidates = async (id, url, signal) => {
    const { cwd, current } = await capture(id, url, signal);
    const result = await github(() => stacker.candidates(cwd, url, current));
    assertPrStackCurrent(current);
    return result.parents;
  };
  const stack = async (id, url, parentUrl, signal) => {
    const { cwd, current } = await capture(id, url, signal);
    assertPrStackCurrent(current);
    // Finish an earlier monitor read before the write; a new one after it reloads the GitHub-owned base.
    await monitor.refresh(id);
    assertPrStackCurrent(current);
    await github(() => stacker.stack(cwd, url, parentUrl, current));
    if (current()) await monitor.refresh(id);
  };
  ipcMain.handle('prMonitor:stackCandidates', (event, id, url) => {
    validWindow(event);
    return candidates(id, url);
  });
  ipcMain.handle('prMonitor:stack', (event, id, url, parentUrl) => {
    validWindow(event);
    return stack(id, url, parentUrl);
  });
  /** @type {[string, string, string, object, string[], (id: string, args: any, signal?: AbortSignal) => any][]} */
  const toolSpecs = [
    [
      'get_pr_stack_candidates',
      'observe',
      'List open pull requests that this chat’s tracked PR can use as its base, excluding cycles and fork parents.',
      { url: { type: 'string' } },
      ['url'],
      (id, args, signal) => candidates(id, args.url, signal),
    ],
    [
      'stack_pull_request',
      'act',
      'Set this chat’s tracked PR base to another open PR’s head branch in the same repository. Does not rebase or merge commits. Use only when the user requests PR stacking.',
      { url: { type: 'string' }, parentUrl: { type: 'string' } },
      ['url', 'parentUrl'],
      (id, args, signal) => stack(id, args.url, args.parentUrl, signal),
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
        return handler(ctx.chatId, args, ctx.signal);
      },
    });
  }
}

module.exports = { registerPrStack, registeredBy: 'prMonitor' };
