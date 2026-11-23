// App startup ordering: the window opens before slow service setup, without exposing unready services.
import { after, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { deferred } from './support/async-scenarios.ts';
import { flush, loadMain, unloadMain } from './support/electron-main-harness.ts';

mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
after(() => unloadMain());

test('the app window opens while the login shell is still starting', async () => {
  const environment = deferred<void>();
  const h = await loadMain({
    before: (h) => h.mod('platform/env.cjs').ready.mock.mockImplementation(() => environment.promise),
  });
  assert.equal(h.windows.length, 0, 'wait for Electron before opening the window');
  const startup = h.ready();
  try {
    await flush();
    assert.equal(h.windows.length, 1, 'a slow login shell must not leave the app with no window');
    assert.equal(h.windows[0].isVisible(), true, 'the native window opens before first paint or the login shell answers');
    assert.equal(h.inst.Accounts, undefined, 'harness setup still waits for the correct environment');
  } finally {
    environment.resolve();
    await startup;
  }
});

type Stage = 'environment' | 'relay' | 'tools';
function holdStartup(stage: Stage) {
  const pending = deferred<any>();
  return {
    pending,
    before: (h: Awaited<ReturnType<typeof loadMain>>) => {
      if (stage === 'environment') h.mod('platform/env.cjs').ready.mock.mockImplementation(() => pending.promise);
      if (stage === 'relay') {
        h.mods['electron/identity/codexAccounts.cjs'].Accounts = h.cls('Accounts', () => ({ startRelay: () => pending.promise }));
      }
      if (stage === 'tools') {
        fs.writeFileSync(path.join(h.tmp, 'sage-mcp'), '');
        h.mods['electron/capabilities/mcp/socket.cjs'].ToolSocket = h.cls('ToolSocket', () => ({ listen: () => pending.promise }));
      }
    },
  };
}

for (const stage of ['environment', 'relay', 'tools'] as const) {
  test(`readiness for all windows waits for ${stage}, then releases together`, async () => {
    const setup = holdStartup(stage);
    const h = await loadMain({ before: setup.before });
    const startup = h.ready();
    const first = h.invoke('app:ready');
    const second = h.invoke('app:ready');
    let settled = false;
    void first.then(() => (settled = true));
    try {
      await flush();
      assert.equal(h.windows.length, 1);
      assert.equal(first === second, true, 'the process owns one readiness result');
      assert.equal(settled, false);
      assert.equal(Boolean(h.inst.ChatController), false, 'no sessions start before the tools are ready');
      h.windows[0].destroyed = true;
      h.app.emit('activate');
      assert.equal(h.windows.length, 2, 'a replacement window shares the same pending startup');
    } finally {
      setup.pending.resolve(stage === 'relay' ? ['--relay'] : '/tmp/tools.sock');
      await startup;
    }
    assert.deepEqual(await first, { value: null });
    assert.deepEqual(await second, { value: null });
    assert.equal(h.inst.ChatController.length, 1);
    assert.equal(h.windows.length, 2, 'finishing startup does not open another window');
    h.app.emit('will-quit');
    assert.deepEqual(await h.invoke('app:ready'), { value: null }, 'a completed startup stays completed');
    h.app.emit('activate');
    assert.equal(h.windows.length, 2, 'termination does not reopen a window');
  });

  test(`${stage} failure settles readiness and reports the failed startup`, async () => {
    const setup = holdStartup(stage);
    const h = await loadMain({ before: setup.before });
    const startup = h.ready();
    await flush();
    setup.pending.reject(new Error(`${stage} unavailable`));
    await startup;
    assert.deepEqual(await h.invoke('app:ready'), {
      error: { code: 'startup_failed', message: 'MoPilot could not finish starting.' },
    });
    assert.equal(h.windows.length, 1, 'the error has a window to reach');
    assert.equal(h.inst.ChatController, undefined);
    assert.deepEqual(h.one('Telemetry').error.mock.calls.at(-1).arguments, [{ message: `${stage} unavailable`, kind: 'startup' }]);
  });

  for (const outcome of ['success', 'failure'] as const) {
    test(`quitting during ${stage} ignores its late ${outcome} and stops later setup`, async () => {
      const setup = holdStartup(stage);
      const h = await loadMain({ before: setup.before });
      const startup = h.ready();
      await flush();
      h.app.emit('will-quit');
      const closed = { error: { code: 'startup_closed', message: 'MoPilot is quitting.' } };
      assert.deepEqual(await h.invoke('app:ready'), closed);
      if (stage === 'relay') assert.equal(h.one('Accounts').dispose.mock.callCount(), 1);
      if (stage === 'tools') assert.ok(h.one('ToolSocket').close.mock.callCount() > 0);
      if (outcome === 'success') setup.pending.resolve('/tmp/tools.sock');
      else setup.pending.reject(new Error('obsolete setup failure'));
      await startup;
      assert.equal(h.inst.ChatController, undefined);
      if (stage === 'tools') {
        assert.equal(h.inst.SessionMcp, undefined, 'a retired listener cannot create a harness tool channel');
        assert.equal(h.inst.CodexToolInjection, undefined);
      }
      assert.equal(h.one('Telemetry').error.mock.callCount(), 0);
      assert.deepEqual(await h.invoke('app:ready'), closed, 'a late completion cannot publish readiness');
    });

    test(`a stalled ${stage} shows startup failure and ignores its late ${outcome}`, async () => {
      const setup = holdStartup(stage);
      const h = await loadMain({ before: setup.before });
      const startup = h.ready();
      await flush();
      mock.timers.tick(30_000);
      const failed = { error: { code: 'startup_failed', message: 'MoPilot could not finish starting.' } };
      assert.deepEqual(await h.invoke('app:ready'), failed);
      if (stage === 'relay') assert.equal(h.one('Accounts').dispose.mock.callCount(), 1);
      if (stage === 'tools') assert.equal(h.one('ToolSocket').close.mock.callCount(), 1);
      if (outcome === 'success') setup.pending.resolve('/tmp/tools.sock');
      else setup.pending.reject(new Error('late setup rejection'));
      await startup;
      assert.equal(h.inst.ChatController, undefined);
      if (stage === 'tools') assert.equal(h.inst.SessionMcp, undefined);
      assert.deepEqual(await h.invoke('app:ready'), failed);
      assert.deepEqual(
        h.one('Telemetry').error.mock.calls.map((call: any) => call.arguments),
        [[{ message: 'App startup timed out.', kind: 'startup' }]],
      );
      h.app.emit('activate');
      assert.equal(h.windows[0].isVisible(), true, 'the failed window can still be brought forward to quit');
    });
  }
}

test('quitting before Electron is ready never opens a window or starts services', async () => {
  const h = await loadMain();
  h.app.emit('will-quit');
  await h.ready();
  assert.equal(h.windows.length, 0);
  assert.equal(h.inst.Accounts, undefined);
  assert.equal(h.inst.ChatController, undefined);
  assert.deepEqual(await h.invoke('app:ready'), { error: { code: 'startup_closed', message: 'MoPilot is quitting.' } });
});

test('an accepted quit retires startup before its graceful helper cleanup finishes', async () => {
  const environment = deferred<void>();
  const cleanup = deferred<void>();
  const h = await loadMain({
    before: (h) => {
      h.mod('platform/env.cjs').ready.mock.mockImplementation(() => environment.promise);
      h.claude.closeAll.mock.mockImplementation(() => cleanup.promise);
    },
  });
  const startup = h.ready();
  await flush();
  const e = { preventDefault: mock.fn() };
  h.app.emit('before-quit', e);
  assert.equal(e.preventDefault.mock.callCount(), 1, 'quit is waiting for helper cleanup');
  let readiness: unknown;
  void h.invoke('app:ready').then((result: unknown) => (readiness = result));
  await flush();
  try {
    assert.deepEqual(readiness, { error: { code: 'startup_closed', message: 'MoPilot is quitting.' } });
  } finally {
    environment.resolve();
    cleanup.resolve();
    await startup;
    await flush();
  }
  assert.equal(h.inst.Accounts, undefined);
  assert.equal(h.inst.ChatController, undefined);
});

test('quitting writes what the chats still hold back, before the writer drains', async () => {
  const h = await loadMain();
  await h.ready();
  const items = { drain: mock.fn() };
  h.inst.AcpHost[0].items = items;
  h.inst.exitGate[0].passed = true;
  h.app.emit('before-quit', { preventDefault: mock.fn() });
  await flush();
  assert.equal(items.drain.mock.callCount(), 1);
});

test('the exit gate uses native confirmation until the full renderer can answer, including after reload', async () => {
  const h = await loadMain();
  await h.ready();
  const gate = h.inst.exitGate[0];
  const win = h.windows[0];
  assert.equal(gate.opts.window(), null, 'an early or failed startup window has no QuitDialog');
  h.emitIpc('window:ready', win.webContents);
  assert.equal(gate.opts.window(), win);
  win.webContents.emit('did-start-loading');
  assert.equal(gate.opts.window(), null, "a reloading page cannot answer the previous page's confirmation");
  win.destroyed = true;
  assert.equal(gate.opts.window(), null, 'a closed window also uses the native confirmation');
});

for (const stage of ['relay', 'tools'] as const) {
  test(`${stage} accepted before quit cannot advance the outer startup after quit`, async () => {
    const setup = holdStartup(stage);
    const h = await loadMain({ before: setup.before });
    const startup = h.ready();
    await flush();
    setup.pending.resolve(stage === 'relay' ? ['--relay'] : '/tmp/tools.sock');
    // Let the resource and its owning service finish, then quit before the outer startup resumes.
    queueMicrotask(() => queueMicrotask(() => h.app.emit('before-quit', { preventDefault() {} })));
    await startup;
    await flush();
    assert.equal(h.inst.ChatController, undefined);
    assert.deepEqual(await h.invoke('app:ready'), { error: { code: 'startup_closed', message: 'MoPilot is quitting.' } });
  });

  for (const retirement of ['quit', 'timeout'] as const) {
    test(`${stage} cannot publish between its resource opening and ${retirement} in the caller handoff`, async () => {
      const setup = holdStartup(stage);
      const h = await loadMain({ before: setup.before });
      const startup = h.ready();
      await flush();
      const previousConfig = h.one('AppServer').threadConfig;
      setup.pending.resolve(stage === 'relay' ? { openai_base_url: 'http://obsolete-relay' } : '/tmp/obsolete.sock');
      queueMicrotask(() => {
        if (retirement === 'quit') h.app.emit('before-quit', { preventDefault() {} });
        else mock.timers.tick(30_000);
      });
      await startup;
      await flush();
      assert.equal(h.inst.ChatController, undefined);
      if (stage === 'relay') {
        assert.equal(h.one('AppServer').threadConfig, previousConfig, 'a retired relay config cannot be published');
        assert.ok(h.one('Accounts').dispose.mock.callCount() > 0);
      } else {
        assert.equal(h.inst.SessionMcp, undefined);
        assert.equal(h.inst.CodexToolInjection, undefined);
        assert.ok(h.one('ToolSocket').close.mock.callCount() > 0);
      }
    });
  }
}
