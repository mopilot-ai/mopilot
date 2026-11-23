// programs Sky matrix cases using shared fake harness and desktop fixtures.
import { mock, test, assert, NativeDesktopHolds, cuaProgramUse, js, turn, NOTES, BROWSER, fakeLock } from './fixture.ts';

export function registerProgramLocks() {
  test('CM-V01b: guard: every kind of native desktop program holds the lock from its start through its turn, for its chat', () => {
    const programs = [
      NOTES,
      'await sky.click({ x: 1, y: 2 })',
      "const { sky } = await import('@oai/sky');",
      'const apps = await cua.listApps();',
      // a variable an earlier program of the thread bound to an app (the kernel keeps it)
      "await notes.pressKey('cmd+n')",
    ];
    for (const [i, code] of programs.entries()) {
      const cu = fakeLock();
      const holds = new NativeDesktopHolds({ cu, isNativeThread: () => true, chatOf: () => 'chat', onBusy: () => assert.fail('busy') });
      if (i === programs.length - 1) holds.observe({ method: 'item/started', params: js('th', 't0', NOTES, 'bind') });
      holds.observe({ method: 'item/started', params: js('th', 't1', code, `p${i}`) });
      assert.equal(cu.controlling, 'chat', `held while running: ${code}`);
      holds.observe({ method: 'item/completed', params: js('th', 't1', code, `p${i}`, 'completed') });
      assert.equal(cu.controlling, 'chat', `held until the turn ends: ${code}`);
      holds.observe({ method: 'turn/completed', params: turn('th', 't1') });
      if (i === programs.length - 1) holds.observe({ method: 'turn/completed', params: turn('th', 't0') });
      assert.equal(cu.controlling, null, `let go: ${code}`);
    }
    // a program that drives no desktop app, a kernel reset that forgets bound apps, a reassigned variable
    const cu = fakeLock();
    const holds = new NativeDesktopHolds({ cu, isNativeThread: () => true, chatOf: () => 'chat', onBusy: () => {} });
    for (const code of [BROWSER, '1 + 1', '', null]) holds.observe({ method: 'item/started', params: js('th', 't1', code as any) });
    assert.equal(cu.controlling, null);
    holds.observe({ method: 'item/started', params: js('th', 't1', NOTES, 'x') });
    holds.observe({ method: 'turn/completed', params: turn('th', 't1') });
    holds.observe({
      method: 'item/started',
      params: { threadId: 'th', turnId: 't2', item: { type: 'mcpToolCall', server: 'cua_repl', tool: 'js_reset', id: 'r' } },
    });
    holds.observe({ method: 'item/started', params: js('th', 't2', 'await notes.click([1, 1])', 'y') });
    assert.equal(cu.controlling, null, 'after js_reset the old binding names nothing');
    holds.observe({
      method: 'item/started',
      params: js('th', 't3', "notes = await cua.getApp('Notes');\nnotes = await cua.createBrowserTab('chrome');", 'z'),
    });
    holds.observe({ method: 'turn/completed', params: turn('th', 't3') });
    holds.observe({ method: 'item/started', params: js('th', 't4', "await notes.goto('https://example.com')", 'w') });
    assert.equal(cu.controlling, null, 'a variable rebound to a browser tab no longer names an app');
    // MoPilot's own JS reset on Stop forgets the bindings too
    holds.observe({ method: 'item/started', params: js('th', 't5', "app = await cua.getApp('Mail'); x = app;", 'm') });
    holds.observe({ method: 'turn/completed', params: turn('th', 't5') });
    holds.reset('th');
    holds.observe({ method: 'item/started', params: js('th', 't6', 'await x.click([1, 1])', 'n') });
    assert.equal(cu.controlling, null);
    assert.deepEqual(cuaProgramUse(NOTES), { desktop: true, app: 'Notes' });
  });
}

export function registerProgramParsing() {
  test('a program the lock helper reads: string literals and comments never count, escapes are kept', () => {
    assert.deepEqual(cuaProgramUse("// cua.getApp('Notes')\nconsole.log('sky.click')"), { desktop: false, app: null });
    assert.deepEqual(cuaProgramUse('/* sky.x */ const a = cua.getApp("Te\\"xt");'), { desktop: true, app: 'Te"xt' });
    assert.deepEqual(cuaProgramUse('const a = await cua.getApp(name); await a.click([1, 1])'), { desktop: true, app: null });
    assert.deepEqual(cuaProgramUse("'unterminated"), { desktop: false, app: null });
    assert.deepEqual(cuaProgramUse('/* unterminated'), { desktop: false, app: null });
    // the lock helper with a holder that already is the chat keeps its app current, and never takes it twice
    const activity: any[] = [];
    const cu = fakeLock({ controlling: 'chat', app: 'Mail', onActivity: (c: string, a: any) => activity.push([c, a]) });
    const holds = new NativeDesktopHolds({ cu, isNativeThread: () => true, chatOf: () => 'chat', onBusy: () => {} });
    holds.observe({ method: 'item/started', params: js('th', 't1', NOTES) });
    holds.observe({ method: 'item/started', params: js('th', 't1', 'await notes.click([1, 1])', 'k') });
    assert.deepEqual(activity, [['chat', { app: 'Notes', state: 'active' }]]);
    holds.observe({ method: 'turn/completed', params: turn('th', 't1') });
    assert.equal(cu.controlling, 'chat', "a hold it did not take is the turn-end ledger's to let go");
    for (const msg of [
      null,
      { method: 'x' },
      { id: 1, method: 'item/started', params: js('th', 't1', NOTES) },
      { method: 'item/started', params: { threadId: 7 } },
    ])
      holds.observe(msg);
    holds.observe({
      method: 'item/started',
      params: { threadId: 'th', item: { type: 'mcpToolCall', server: 'cua_repl', tool: 'js', arguments: { code: NOTES } } },
    });
    holds.observe({ method: 'turn/completed', params: { threadId: 'th' } });
    holds.clear();
    assert.equal(cu.controlling, 'chat');
    // the app-server exiting: a hold it took is let go, one it did not take (or that moved on) is left alone
    const mine = fakeLock();
    const two = new NativeDesktopHolds({ cu: mine, isNativeThread: () => true, chatOf: (id: string) => `chat-${id}`, onBusy: () => {} });
    two.observe({ method: 'item/started', params: js('a', 't1', NOTES) });
    mine.controlling = 'chat-b';
    two.observe({ method: 'item/started', params: js('b', 't1', NOTES) });
    two.clear();
    assert.equal(mine.controlling, 'chat-b', "chat-b's hold was not taken here, and chat-a's had moved on");
    // a lone quote at the end of a program
    assert.deepEqual(cuaProgramUse("x = '"), { desktop: false, app: null });
    mock.restoreAll();
  });
}
