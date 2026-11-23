// Main session startup wiring cases using shared fake timers and main harness.
import { test, mock, assert, fs, path, loadMain, calls, ready, delegates } from './fixture.ts';

export function registerStartup() {
  test('the chat store opens after the migrations, in fallback mode unless they all finished', async () => {
    let h = await ready();
    let store = h.one('ChatsStore');
    assert.deepEqual(store.args[0], path.join(h.userData, 'threads'));
    assert.equal(store.opts, store.args[0]);
    const o = store.args[1];
    assert.equal(o.fallback, false);
    assert.equal(o.uiState, path.join(h.userData, 'ui-state.json'));
    assert.equal(o.legacyMirror(), true);
    h.inst.computerUse[0].visibility = { forget: () => {} };
    o.onChange();
    assert.equal(h.one('ChatController').invalidate.mock.callCount(), 1);
    h = await loadMain({ before: (h) => h.mod('migrations/migrate.cjs').runMigrations.mock.mockImplementation(() => []) });
    await h.ready();
    assert.equal(h.one('ChatsStore').args[1].fallback, true);
    h = await loadMain({
      before: (h) =>
        h.mod('migrations/migrate.cjs').runMigrations.mock.mockImplementation(() => {
          throw new Error('disk full');
        }),
    });
    const err = mock.method(console, 'error', () => {});
    await h.ready();
    err.mock.restore();
    store = h.one('ChatsStore');
    assert.equal(store.args[1].fallback, true);
    // before the controller exists a change is not an error
    h = await loadMain({
      before: (h) =>
        (h.mods['electron/platform/chats.cjs'].ChatsStore = h.cls(
          'ChatsStore',
          (_dir: string, o: any) => (o.onChange(), { records: new Map() }),
        )),
    });
    await h.ready();
    assert.deepEqual(await h.invoke('migration:status'), [{ id: 'threads-v2', result: 'ok' }]);
    h = await loadMain({
      before: (h) =>
        h.mod('migrations/migrate.cjs').runMigrations.mock.mockImplementation(() => {
          throw 'odd';
        }),
    });
    const err2 = mock.method(console, 'error', () => {});
    await h.ready();
    err2.mock.restore();
    assert.deepEqual(await h.invoke('migration:status'), [{ id: 'threads-v2', result: 'error', message: 'odd' }]);
  });

  test('basic harnesses: admission, binaries, events, and no tools without sage-mcp', async () => {
    const h = await ready({ state: { prefs: { acpBins: { gemini: '/my/gemini' } } } });
    const adm = h.one('Admission');
    const o = adm.opts;
    assert.equal(o.quirks, h.mod('harness/quirks/index.cjs').quirks);
    assert.deepEqual(o.ids, ['gemini']);
    assert.equal(o.file, path.join(h.userData, 'acp-admission.json'));
    assert.equal(o.dataDir, path.join(h.userData, 'harnesses'));
    assert.deepEqual(o.env(), { PATH: '/bin' });
    const r = o.resolveBin('gemini');
    assert.equal(r.o.manual, '/my/gemini');
    assert.equal(r.o.known, undefined, 'the user-tool folders every detector shares (detect.cjs)');
    // whether the terminal runs that binary, by the names its quirks give (no login shell here: unknown)
    assert.deepEqual(o.pathStatus('gemini', '/my/gemini'), { offPath: false, terminal: null });
    assert.deepEqual(o.pathStatus('other', null), { offPath: false, terminal: null });
    delegates(r.o.which, h.mod('platform/env.cjs').which, ['gemini']);
    h.writeState({});
    assert.equal(o.resolveBin('x').o.manual, undefined);
    delegates(
      o.killed,
      h.mod('shared/killSwitch.cjs').killedReason,
      ['gemini'],
      ['acp:gemini', h.mod('platform/flags.cjs').isEnabled, { needsChannel: true }],
    );
    calls(adm.onChange)[0][0](['list']);
    assert.deepEqual(h.windows[0].webContents.on_('acp:harnesses'), [[['list']]]);
    // without sage-mcp the tool channel refuses
    await assert.rejects(o.tools.prepare(), /sage-mcp/);
    assert.equal(await o.tools.admission(), false);
    assert.equal(o.tools.end(), undefined);
    const host = h.one('AcpHost');
    assert.equal(host.opts.cwd, h.home);
    assert.equal(host.opts.items, h.inst.ItemsLog[0]);
    adm.list = () => [
      { id: 'a', state: 'admitted', label: 'A', bin: '/a' },
      { id: 'b', state: 'blocked', label: 'B', bin: '/b', reason: 'too old' },
      { id: 'c', state: 'blocked', label: 'C', bin: '/c' },
    ];
    assert.equal(await host.opts.resolveBin('a', true), '/a');
    await assert.rejects(host.opts.resolveBin('b', true), /B: too old/);
    await assert.rejects(host.opts.resolveBin('c', true), /C: this version isn't supported/);
    assert.equal(await host.opts.resolveBin('b'), '/b', 'sign-in can reach the chosen CLI without chat admission');
    assert.equal(await host.opts.resolveBin('zzz', true), null);
    assert.deepEqual(calls(adm.current).at(-1), ['zzz', { again: true }]);
    // admission takes a chat's sign-in failures (with how to set it up) and successes, and new sessions' catalogs
    assert.equal(host.opts.admission, adm);
    const notifier = h.mod('platform/notify.cjs').registerNotify.mock.calls[0].result;
    host.opts.notify('done', 'c1', { x: 1 });
    assert.deepEqual(calls(notifier.notify), [['done', 'c1', { x: 1 }]]);
    const [ev, onEvent] = calls(host.on)[0];
    assert.equal(ev, 'event');
    onEvent({ e: 1 });
    assert.deepEqual(calls(h.one('ChatController').onAcpEvent), [[{ e: 1 }]]);
  });

  test('ACP callbacks before the controller and notifier exist do nothing', async () => {
    const h = await loadMain({
      before: (h) => (h.mods['electron/harness/acp.cjs'].AcpHost = h.cls('AcpHost', (o: any) => (o.notify('k', 'c'), {}))),
    });
    await h.ready();
    const [, onEvent] = calls(h.one('AcpHost').on)[0];
    assert.equal(onEvent({}), undefined);
  });

  test('with sage-mcp, basic harnesses get the session MCP channel', async () => {
    const h = await loadMain({ before: (h) => fs.writeFileSync(path.join(h.tmp, 'sage-mcp'), '') });
    await h.ready();
    assert.equal(h.one('Admission').opts.tools, h.one('SessionMcp'));
  });
}
