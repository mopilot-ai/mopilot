// Real deletion IPC keeps the ledger and success events unchanged whenever the real store refuses deletion.
import { test, mock, assert, calls, ready } from './support/main-sessions/fixture.ts';
import { setup, base, fs, path, writeTask, fakeDesktop } from './support/automation-store/fixture.ts';

mock.module('../electron/plugins/service.cjs', {
  namedExports: {
    pluginDelivery: () => ({}),
    pluginService: () => ({ subscribe() {} }),
    codexPluginMirror: () => ({ attach: mock.fn(), sync: async () => {} }),
  },
});

for (const failure of ['corrupt', 'native', 'ambiguous', 'filesystem']) {
  test(`deletion IPC preserves ledger and emits no success on ${failure} failure`, async (t) => {
    const h = await ready();
    const s = setup(t, fakeDesktop({ tasks: failure === 'ambiguous' ? [{ ...base, id: 'target', harness: 'claude' }] : [] }));
    await writeTask(s.store.o.codexDir(), { ...base, id: 'target' });
    if (failure === 'corrupt') fs.writeFileSync(path.join(s.root, 'codex', 'target', 'automation.toml'), '[');
    if (failure === 'native') {
      await fs.promises.rm(path.join(s.root, 'codex', 'target'), { recursive: true });
      s.desktop.list = (_onError: any, strictId: string) => {
        if (strictId === 'target') throw new Error('native unreadable');
        return [];
      };
    }
    if (failure === 'filesystem') {
      const rm = fs.promises.rm;
      t.mock.method(fs.promises, 'rm', async (...args: any[]) => {
        if (args[0] === path.join(s.root, 'codex', 'target')) throw new Error('remove failed');
        return (rm as any)(...args);
      });
    }
    h.one('AutomationStore').remove = (id: string) => s.store.remove(id);
    const w = h.windows[0].webContents;
    const ledger = h.one('RunLedger');
    const before = w.on_('automation:changed').length;
    await assert.rejects(h.invokeFrom(w, 'automation:delete', 'target'));
    assert.deepEqual(calls(ledger.forget), []);
    assert.equal(w.on_('automation:changed').length, before);
  });
}

test('deletion IPC acknowledges missing targets and emits one change after accepted deferred native deletion', async (t) => {
  const h = await ready();
  const s = setup(t, fakeDesktop({ running: true, tasks: [{ ...base, id: 'native', harness: 'claude' }] }));
  h.one('AutomationStore').remove = (id: string) => s.store.remove(id);
  const w = h.windows[0].webContents;
  const ledger = h.one('RunLedger');
  await h.invokeFrom(w, 'automation:delete', 'missing');
  await h.invokeFrom(w, 'automation:delete', 'native');
  assert.deepEqual(calls(ledger.forget), [['missing'], ['native']]);
  assert.deepEqual(w.on_('automation:changed').slice(-2), [[{ id: 'missing' }], [{ id: 'native' }]]);
  assert.deepEqual(s.store.readPending(), ['native']);
  assert.equal(s.desktop.tasks.length, 1, 'native removal is durably queued while Desktop runs');
  assert.deepEqual((await s.store.list()).tasks, []);
});
