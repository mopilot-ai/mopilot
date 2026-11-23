// Main session scheduler wiring cases using shared fake timers and main harness.
import { test, mock, assert, path, loadMain, unloadMain, calls, ready, delegates } from './fixture.ts';

export function registerScheduler() {
  test('scheduler: runs start in main, on harnesses that can run them; tasks live where their harness keeps them', async () => {
    const h = await ready({ state: { prefs: { model: 'm', permission: 'auto', serviceTier: 'fast' } } });
    const runner = h.one('AutomationRunner').opts;
    const sched = h.one('Scheduler');
    const so = sched.opts;
    const ctl = h.one('ChatController');
    const sessions = h.one('SessionStore');
    const codex = h.one('CodexAdapter');
    const store = h.one('AutomationStore');
    const natives = h.mod('platform/nativeSchedulers.cjs');
    assert.equal(so.enabled(), true);
    assert.deepEqual(await so.list(), ['a']);
    // the homes: the Codex app's folder, MoPilot's in the home folder; the ledger beside it
    assert.equal(store.opts.codexDir(), path.join(h.home, '.codex', 'automations'));
    assert.equal(store.opts.mopilotDir(), path.join(h.home, '.mopilot', 'automations'));
    assert.equal(calls(natives.codexApp)[0][0].codexHome(), path.join(h.home, '.codex'));
    assert.equal(store.opts.codexApp, natives.codexApp.mock.calls[0].result);
    assert.equal(store.opts.desktop, natives.claudeDesktop.mock.calls[0].result);
    assert.deepEqual(so.natives, { 'codex-app': store.opts.codexApp, 'claude-desktop': store.opts.desktop });
    const ledger = h.one('RunLedger');
    assert.equal(ledger.opts.dir, path.join(h.home, '.mopilot', 'automation-runs'));
    assert.equal(ledger.opts.by.pid, process.pid);
    assert.equal(so.ledger, ledger);
    ledger.recordManual = mock.fn(async () => {});
    await runner.record({ id: 'manual' }, 'chat', 'acp:gemini');
    assert.deepEqual(calls(ledger.recordManual), [['manual', 'chat', 'acp:gemini']]);
    assert.equal(store.migrate.mock.callCount(), 1, 'old tasks move out of the Codex folder at start');
    await so.before();
    assert.equal(store.sync.mock.callCount(), 1);
    assert.equal(so.tickMs, undefined);
    const runA = h.one('AutomationRunner');
    so.run({ t: 1 });
    assert.deepEqual(calls(runA.run)[0], [{ t: 1 }, { unattended: true }]);
    sessions.all = () => ['x'];
    assert.deepEqual(so.sessions.all(), ['x']);
    sessions.has = () => true;
    assert.equal(so.sessions.has('x'), true);
    delegates(so.sessions.get, sessions.get, ['x']);
    delegates(so.sessions.patch, sessions.patch, ['x', { p: 1 }]);
    delegates(so.sessions.approvalToken, sessions.approvalToken, ['x', 1]);
    const notifier = h.mod('platform/notify.cjs').registerNotify.mock.calls[0].result;
    so.notify('c', { name: 'Daily' });
    codex.chatName = () => 'Chat';
    so.notify('c', { name: 'Daily' }, { catchUp: false });
    so.notify('c', { name: 'Daily' }, { catchUp: true });
    assert.deepEqual(calls(notifier.notify), [
      ['scheduled', 'c', { title: 'Scheduled task started', body: 'Daily', chatTitle: undefined }],
      ['scheduled', 'c', { title: 'Scheduled task started', body: 'Daily', chatTitle: 'Chat' }],
      ['scheduled', 'c', { title: 'Catch-up run started', body: 'Daily', chatTitle: 'Chat' }],
    ]);
    // a run that failed says so: by its chat when it has one, else by its task (a failure before the chat existed)
    so.notify('c', { id: 't1', name: 'Daily' }, { catchUp: false, error: 'not signed in' });
    so.notify(null, { id: 't1', name: 'Daily' }, { catchUp: true, error: 'gone' });
    assert.deepEqual(calls(notifier.notify).slice(3), [
      ['scheduled', 'c', { title: "Scheduled task didn't start", body: 'Daily: not signed in', group: 'failed', chatTitle: 'Chat' }],
      ['scheduled', 'automation:t1', { title: "Catch-up run didn't start", body: 'Daily: gone', group: 'failed', chatTitle: 'Daily' }],
    ]);
    const warn = mock.method(console, 'warn', () => {});
    so.log('hello');
    store.opts.log('moved');
    assert.deepEqual(
      warn.mock.calls.map((c: any) => c.arguments),
      [['hello'], ['moved']],
    );
    warn.mock.restore();
    // the runner's collaborators
    assert.equal(runner.prefs().model, 'm');
    delegates(runner.sessions.patch, sessions.patch, ['c', { p: 1 }]);
    // a run's message: a busy chat queues it; an idle one starts it now and its start is awaited
    ctl.state = { get: (id: string) => ({ turn: id === 'busy' ? 'running' : 'idle' }) };
    ctl.send = mock.fn(() => ({ action: 'queued', id: 'q' }));
    ctl.startOrKeep = mock.fn(async () => ({ started: false, error: 'Sign in to Gemini first' }));
    assert.deepEqual(await runner.send('busy', { text: 'x' }, 7), { action: 'queued', id: 'q' });
    assert.deepEqual(calls(ctl.send), [['busy', { text: 'x' }, 7]]);
    assert.deepEqual(await runner.send('c', { text: 'y', attachments: [], opts: { o: 1 } }, 7), {
      started: false,
      error: 'Sign in to Gemini first',
    });
    const [startedIn, item] = calls(ctl.startOrKeep)[0];
    assert.deepEqual([startedIn, item.text, item.opts, item.origin, typeof item.id], ['c', 'y', { o: 1 }, 7, 'string']);
    codex.startThread = mock.fn(async () => ({ thread: { id: 't' } }));
    assert.deepEqual(await runner.codexThread({ cwd: '/w' }), { id: 't' });
    assert.deepEqual(calls(codex.startThread)[0], [
      { cwd: '/w', model: 'm', approvalPolicy: 'auto', ephemeral: false, serviceTier: 'fast' },
    ]);
    delegates(runner.claudeSession, h.one('ClaudeAdapter').registerSession, ['k', {}]);
    delegates(runner.acpSession, h.one('AcpTurns').registerSession, ['acp:gemini:k', {}]);
    assert.equal(runner.label('acp:gemini'), 'Gemini');
    assert.equal(runner.label('acp:other'), 'other');
    assert.equal(runner.chats, h.one('ChatsStore'));
    delegates(runner.worktree, h.mod('platform/git.cjs').worktreeAdd, ['/w', { o: 1 }]);
    delegates(runner.script, h.mod('platform/git.cjs').runScript, ['/w', 's']);
    // a heartbeat's chat is saved through the store, and windows hear of it
    const w = h.windows[0].webContents;
    await runner.remember({ id: 'hb', kind: 'heartbeat' }, 'c');
    assert.deepEqual(calls(store.rememberChat).at(-1), [{ id: 'hb', kind: 'heartbeat' }, 'c']);
    assert.deepEqual(w.on_('automation:changed').at(-1), [{ id: 'hb' }]);
    const notices = w.on_('automation:changed').length;
    store.rememberChat = mock.fn(async () => false);
    await runner.remember({ id: 'hb', kind: 'heartbeat' }, 'late');
    assert.equal(w.on_('automation:changed').length, notices, 'a superseded startup announces no save');
    runner.started({ harness: 'claude', chatId: 'c', cwd: '/w', worktreeOf: null });
    runner.started({ harness: 'codex', chatId: 'd', cwd: '/w', worktreeOf: '/r', config: { c: 1 } });
    runner.started({ harness: 'acp', chatId: 'acp:gemini:e', cwd: '/w', worktreeOf: null });
    assert.deepEqual(w.on_('claude:event').at(-1), [{ kind: 'chatStarted', key: 'c', chatId: 'c', cwd: '/w', worktreeOf: null }]);
    // a durable fork starts from its copied conversation, which windows read when it opens
    runner.started({ harness: 'claude', chatId: 'f', cwd: '/w', worktreeOf: null, history: true });
    assert.deepEqual(w.on_('claude:event').at(-1), [
      { kind: 'chatStarted', key: 'f', chatId: 'f', cwd: '/w', worktreeOf: null, history: true },
    ]);
    assert.deepEqual(w.on_('codex:item').at(-1), [
      { kind: 'chatStarted', chatId: 'd', cwd: '/w', worktreeOf: '/r', config: { c: 1 }, mine: false },
    ]);
    assert.deepEqual(w.on_('acp:event').at(-1), [
      { kind: 'chatStarted', key: 'acp:gemini:e', chatId: 'acp:gemini:e', cwd: '/w', worktreeOf: null },
    ]);
    // a run on a remote machine: its folder is the machine's, and the project it was started for keeps it there
    runner.started({ harness: 'acp', chatId: 'acp:host-claude:m', cwd: '/srv', worktreeOf: null, hostId: 'box', projectId: null });
    assert.deepEqual(w.on_('acp:event').at(-1), [
      {
        kind: 'chatStarted',
        key: 'acp:host-claude:m',
        chatId: 'acp:host-claude:m',
        cwd: '/srv',
        worktreeOf: null,
        hostId: 'box',
        projectId: null,
      },
    ]);
    runner.started({ harness: 'acp', chatId: 'acp:host-codex:p', cwd: '/srv', worktreeOf: null, hostId: 'box' });
    assert.equal(w.on_('acp:event').at(-1)[0].projectId, null);
    // the Host's machine starter, read when a run needs it (unset until Host is wired)
    assert.equal(typeof runner.machine().start, 'function');
    // Run now
    await h.invokeFrom(w, 'automation:run', { id: 'a' });
    await h.invokeFrom(w, 'automation:run', null);
    assert.deepEqual(calls(runA.run).slice(1), [
      [{ id: 'a' }, { unattended: false, origin: w.id }],
      [{}, { unattended: false, origin: w.id }],
    ]);
    // the Scheduled page reads and writes through main
    assert.deepEqual(await h.invokeFrom(w, 'automation:list'), { tasks: ['a'], errors: [] });
    assert.deepEqual(await h.invokeFrom(w, 'automation:save', { name: 'N' }), { name: 'N', id: 'saved' });
    assert.deepEqual(await h.invokeFrom(w, 'automation:save', 'junk'), { id: 'saved' });
    assert.deepEqual(w.on_('automation:changed').at(-1), [{ id: 'saved' }]);
    ledger.forget = mock.fn(async () => {});
    await h.invokeFrom(w, 'automation:delete', 7);
    assert.deepEqual(calls(store.remove).at(-1), ['7']);
    assert.deepEqual(calls(ledger.forget).at(-1), ['7']);
    assert.deepEqual(w.on_('automation:changed').at(-1), [{ id: '7' }]);
    // where tasks run: the scheduler, and each native app, installed and open
    store.opts.codexApp.installed = () => true;
    store.opts.codexApp.running = async () => true;
    store.opts.desktop.installed = () => false;
    store.opts.desktop.running = mock.fn(async () => true);
    assert.deepEqual(await h.invokeFrom(w, 'automation:apps'), {
      scheduler: true,
      codexApp: { installed: true, running: true },
      claudeDesktop: { installed: false, running: false },
    });
    assert.equal(store.opts.desktop.running.mock.callCount(), 0, 'an app that is not installed is not looked for');
    // runs: MoPilot's and the Codex app's, newest first
    assert.deepEqual(await h.invokeFrom(w, 'automation:runs', 't'), [{ scheduledFor: 3 }, { scheduledFor: 2 }, { scheduledFor: 1 }]);
    assert.deepEqual(calls(ledger.list).at(-1), ['t', 20]);
    // on unless turned off; the older runSchedules (off by default) is not read
    h.writeState({ prefs: { runSchedules: false } });
    assert.equal(so.enabled(), true);
    h.writeState({});
    assert.equal(so.enabled(), true);
    h.writeState({ prefs: { schedulerOff: true } });
    assert.equal(so.enabled(), false);
  });

  test('scheduler: a failed move of old tasks is logged, not fatal', async () => {
    const warn = mock.method(console, 'warn', () => {});
    const h = await loadMain({
      before: (h) =>
        (h.mods['electron/platform/automationStore.cjs'].AutomationStore = h.cls('AutomationStore', () => ({
          migrate: mock.fn(async () => {
            throw new Error('read-only');
          }),
        }))),
    });
    await h.ready();
    await new Promise((r) => setImmediate(r));
    assert.ok(warn.mock.calls.some((c: any) => c.arguments[0] === 'scheduled tasks: read-only'));
    warn.mock.restore();
    const w2 = mock.method(console, 'warn', () => {});
    const h2 = await loadMain({
      before: (h) =>
        (h.mods['electron/platform/automationStore.cjs'].AutomationStore = h.cls('AutomationStore', () => ({
          migrate: mock.fn(async () => {
            throw 'plain';
          }),
        }))),
    });
    await h2.ready();
    await new Promise((r) => setImmediate(r));
    assert.ok(w2.mock.calls.some((c: any) => c.arguments[0] === 'scheduled tasks: plain'));
    w2.mock.restore();
  });

  test('scheduler: chats get the scheduled-task tools, owned by the chat that calls, with its harness and folder', async () => {
    const h = await ready();
    const reg = h.mod('capabilities/tools/scheduledTasks.cjs').registerScheduledTaskTools;
    const [registry, o] = calls(reg)[0];
    assert.ok(registry);
    assert.equal(o.store, h.one('AutomationStore'));
    h.one('ChatsStore').records = new Map([
      [
        'c1',
        {
          segments: [
            { kind: 'codex', nativeId: 'n0' },
            { kind: 'acp:gemini', nativeId: 'n1' },
          ],
        },
      ],
    ]);
    // the segment's key, as its harness's tool session names it (platform/segmentOwner.cjs)
    assert.equal(o.owner({ chatId: 'c1', segmentId: 'acp:gemini:n1' }), 'c1');
    assert.equal(o.owner({ chatId: 'c1', segmentId: 'n0' }), 'c1');
    assert.equal(o.owner({ chatId: 'c1', segmentId: 'n1' }), null);
    assert.equal(o.owner({ chatId: 'c1', segmentId: 'nope' }), null);
    assert.equal(o.owner({ chatId: 'c9', segmentId: 'acp:gemini:n1' }), null);
    assert.equal(o.harnessOf('c1'), 'acp:gemini', 'its current harness: the last segment');
    assert.equal(o.harnessOf('c9'), null);
    assert.deepEqual(o.nextRun('FREQ=DAILY', new Date(5)), { rule: 'FREQ=DAILY', after: new Date(5) });
    assert.equal(o.describe('FREQ=DAILY'), 'described FREQ=DAILY');
    assert.ok(o.nextRun('FREQ=DAILY').after instanceof Date);
    await o.cwdOf('c1');
    const runA = h.one('AutomationRunner');
    await o.run({ id: 'x' });
    assert.deepEqual(calls(runA.run).at(-1), [{ id: 'x' }, { unattended: false }]);
    o.changed({ id: 'x', action: 'created', chatId: 'c1' });
    assert.deepEqual(h.windows[0].webContents.on_('automation:changed').at(-1), [{ id: 'x', action: 'created', chatId: 'c1' }]);
    o.changed();
    assert.deepEqual(h.windows[0].webContents.on_('automation:changed').at(-1), [{}]);
  });

  test('scheduler: started at ready, and checked again when the computer wakes', async () => {
    const h = await ready();
    const s = h.one('Scheduler');
    assert.equal(s.start.mock.callCount(), 1);
    s.tick = mock.fn(async () => {});
    h.electron.powerMonitor.emit('resume');
    assert.equal(s.tick.mock.callCount(), 1);
    // a failed check is logged and retried on the next interval
    const warn = mock.method(console, 'warn', () => {});
    for (const thrown of [new Error('io'), 'raw']) {
      s.tick = mock.fn(async () => {
        throw thrown;
      });
      h.electron.powerMonitor.emit('resume');
      await new Promise((r) => setImmediate(r));
      assert.equal(s.tick.mock.callCount(), 1);
    }
    assert.deepEqual(
      warn.mock.calls.map((c: any) => c.arguments[0]),
      ['scheduled tasks: the check on wake failed: io', 'scheduled tasks: the check on wake failed: raw'],
    );
    warn.mock.restore();
  });

  test('scheduler: whether a harness is usable for a run', async () => {
    const h = await ready({ state: { prefs: { claudeBin: '/c' } } });
    const usable = h.one('AutomationRunner').opts.usable;
    const kill = h.mod('shared/killSwitch.cjs').killedReason;
    kill.mock.mockImplementation(() => 'off');
    assert.equal(await usable('codex'), false);
    assert.equal(await usable('acp:gemini'), false);
    assert.deepEqual(calls(kill).at(-1).slice(2), [{ needsChannel: true }], 'a basic harness also needs its tool channel');
    kill.mock.mockImplementation(() => null);
    // a basic harness runs a task when it passed admission
    h.one('Admission').list = () => [
      { id: 'gemini', state: 'admitted' },
      { id: 'kimi', state: 'signin' },
    ];
    assert.equal(await usable('acp:gemini'), true);
    assert.equal(await usable('acp:kimi'), false);
    assert.equal(await usable('acp:none'), false);
    // a signed-out one is checked again; an unattended run checks it whatever the cache says
    const adm = h.one('Admission');
    assert.deepEqual(calls(adm.current).at(-1), ['none', { again: true }]);
    adm.verify = mock.fn(async () => ({ id: 'gemini', state: 'signin' }));
    assert.equal(await usable('acp:gemini', { unattended: true }), false);
    assert.deepEqual(calls(adm.verify), [['gemini']]);
    const detect = h.claude.turnApi.detect;
    for (const [state, ok] of [
      ['ready', true],
      ['apikey', true],
      ['loggedOut', false],
    ] as const) {
      detect.mock.mockImplementation(async () => ({ state }));
      assert.equal(await usable('claude'), ok, state);
    }
    assert.deepEqual(calls(detect).at(-1), ['/c']);
    // a check that fails is logged, and the run doesn't start
    const warn = mock.method(console, 'warn', () => {});
    detect.mock.mockImplementation(async () => {
      throw new Error('x');
    });
    assert.equal(await usable('claude'), false);
    detect.mock.mockImplementation(async () => {
      throw 'raw';
    });
    assert.equal(await usable('claude'), false);
    assert.deepEqual(
      warn.mock.calls.map((c: any) => c.arguments[0]),
      ["scheduled tasks: Claude Code can't be checked: x", "scheduled tasks: Claude Code can't be checked: raw"],
    );
    warn.mock.restore();
    h.writeState({});
    detect.mock.mockImplementation(async () => null);
    assert.equal(await usable('claude'), false);
    assert.deepEqual(calls(detect).at(-1), [undefined]);
    const codex = h.one('CodexAdapter');
    codex.connect = async () => {};
    codex.accountRead = async () => ({ account: { id: 1 } });
    assert.equal(await usable('codex'), true);
    codex.accountRead = async () => ({ requiresOpenaiAuth: false });
    assert.equal(await usable('codex'), true);
    codex.accountRead = async () => ({ requiresOpenaiAuth: true });
    assert.equal(await usable('codex'), false);
    h.one('Accounts').view = () => ({ accounts: [{ id: 'a' }] });
    assert.equal(await usable('codex'), true, 'saved accounts: re-verify later');
    h.one('Accounts').view = () => ({});
    assert.equal(await usable('codex'), false);
    codex.accountRead = async () => null;
    assert.equal(await usable('codex'), true);
    codex.connect = async () => {
      throw new Error('no codex');
    };
    assert.equal(await usable('codex'), false);
  });

  test('scheduler test mode: no timer, and the clock can be moved', async () => {
    const h = await ready({ env: { MOPILOT_SCHEDULER_TEST: '1' } });
    const s = h.one('Scheduler');
    assert.equal(s.opts.tickMs, 0);
    s.tick = mock.fn(() => 'ticked');
    assert.equal((globalThis as any).__schedulerAdvance(100), 'ticked');
    assert.equal(s.skew, 100);
    assert.equal((globalThis as any).__schedulerAdvance(50, true), undefined);
    assert.equal(s.skew, 150);
    assert.deepEqual(calls(s.markAttention), [[1000]]);
    assert.equal(s.tick.mock.callCount(), 1);
    delete (globalThis as any).__schedulerAdvance;
  });

  test('scheduler sessions before the store opens are empty', async () => {
    const h = await loadMain({
      before: (h) =>
        (h.mods['electron/platform/scheduler.cjs'].Scheduler = h.cls('Scheduler', (o: any) => ({
          early: o.sessions.all(),
          earlyToken: o.sessions.approvalToken('c', 1),
        }))),
    });
    await h.ready();
    assert.deepEqual(h.one('Scheduler').early, []);
    assert.equal(h.one('Scheduler').earlyToken, undefined);
  });

  test('main scheduler facade preserves private approval lifetimes through request-id reuse', async () => {
    unloadMain();
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    const { SessionStore } = require('../../../electron/session/state.cjs');
    const { Scheduler } = require('../../../electron/platform/scheduler.cjs');
    const h = await ready();
    const actual = new SessionStore();
    const live = h.one('SessionStore');
    for (const method of ['all', 'has', 'get', 'patch', 'approvalToken']) live[method] = actual[method].bind(actual);
    const scheduler = new Scheduler({ ...h.one('Scheduler').opts, tickMs: 0 });
    const card = { id: 1, method: 'ask', params: {} };
    actual.patch('c', { scheduled: { unattended: true }, approvals: [card] });
    scheduler.markAttention(0);
    scheduler.markAttention(3_600_000);
    assert.equal(actual.get('c').scheduled.needsAttention, true);
    actual.patch('c', { approvals: [] });
    actual.patch('c', { approvals: [card] });
    scheduler.markAttention(3_600_000);
    assert.equal(actual.get('c').scheduled.needsAttention, false);
  });
}
