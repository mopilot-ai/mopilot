// Warm on open (#1830): electron/session/warmOnOpen.cjs (a chat in view a moment gets its harness's process ready, one start
// a second), electron/harness/claude/warmOnOpen.cjs (Claude Code resumes the chat's CLI with its send's options), and
// electron/app/ipc/app.cjs (app:viewing feeds it, quit stops it).
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createWarmOnOpen, SETTLE_MS, STAGGER_MS } = require('../electron/session/warmOnOpen.cjs');
const { claudeWarmOnOpen } = require('../electron/harness/claude/warmOnOpen.cjs');
const { chatShownIn } = require('../electron/session/viewing.cjs');
const { recentIgnored, clearIgnored } = require('../electron/ignored.cjs');

const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
};

function service(o: any = {}) {
  const warmed: string[] = [];
  const shown = new Set<string>(o.shown ?? []);
  const s = createWarmOnOpen({
    hooks: { claude: { warm: async (id: string) => (o.fail ? Promise.reject(new Error('spawn failed')) : warmed.push(id)) } },
    kindOf: o.kindOf ?? ((id: string) => (id.startsWith('cx') ? 'codex' : 'claude')),
    shown: (id: string) => shown.has(id),
    enabled: o.enabled,
  });
  return { s, warmed, shown };
}

test('a chat that stays in view the settle time is warmed once; one flicked past, or another harness, is not', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { s, warmed, shown } = service({ shown: ['a', 'cx1'] });
    s.viewed('a');
    s.viewed('a');
    s.viewed('b');
    s.viewed('cx1');
    s.viewed('');
    mock.timers.tick(SETTLE_MS - 1);
    await flush();
    assert.deepEqual(warmed, []);
    shown.delete('b');
    mock.timers.tick(1);
    await flush();
    assert.deepEqual(warmed, ['a'], "the chat flicked past and Codex's (no hook) start nothing");
  } finally {
    mock.timers.reset();
  }
});

test('A1: starts are a second apart, and a chat left while it waited its turn starts nothing', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { s, warmed, shown } = service({ shown: ['a', 'b', 'c'] });
    s.viewed('a');
    s.viewed('b');
    s.viewed('c');
    mock.timers.tick(SETTLE_MS);
    await flush();
    assert.deepEqual(warmed, ['a']);
    shown.delete('b');
    mock.timers.tick(STAGGER_MS);
    await flush();
    mock.timers.tick(STAGGER_MS);
    await flush();
    assert.deepEqual(warmed, ['a', 'c']);
    // viewing it again after its turn warms it again (the hook decides there is nothing to do)
    s.viewed('a');
    mock.timers.tick(SETTLE_MS);
    await flush();
    assert.deepEqual(warmed, ['a', 'c', 'a']);
  } finally {
    mock.timers.reset();
  }
});

test('B2: a warm that fails and a chat the controller no longer knows are noted; the switch off and quitting start nothing', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  clearIgnored();
  try {
    const failing = service({ shown: ['a'], fail: true });
    failing.s.viewed('a');
    mock.timers.tick(SETTLE_MS);
    await flush();
    assert.ok(recentIgnored().some((e: any) => e.context === 'warm a chat opened in a window'));
    const unknown = service({
      shown: ['gone'],
      kindOf: () => {
        throw new Error('no chat gone');
      },
    });
    unknown.s.viewed('gone');
    mock.timers.tick(SETTLE_MS);
    await flush();
    assert.ok(recentIgnored().some((e: any) => e.context === 'read the harness of a chat to warm'));
    // a chat with no segment yet has no harness to warm
    const bare = service({ shown: ['a'], kindOf: () => null });
    bare.s.viewed('a');
    mock.timers.tick(SETTLE_MS);
    await flush();
    assert.deepEqual(bare.warmed, []);
    const off = service({ shown: ['a'], enabled: () => false });
    off.s.viewed('a');
    const quitting = service({ shown: ['a'] });
    quitting.s.viewed('a');
    quitting.s.stop();
    quitting.s.viewed('a');
    mock.timers.tick(SETTLE_MS);
    await flush();
    assert.deepEqual([off.warmed, quitting.warmed], [[], []]);
  } finally {
    mock.timers.reset();
  }
});

function claudeHook(o: any = {}) {
  const warms: any[] = [];
  const live = new Map();
  const adapter = {
    sessions: new Map(Object.entries(o.sessions ?? {})),
    startingTurns: new Set(o.starting ?? []),
    live,
    settings: () => ({
      account: 'acct',
      prefs: { claudeBin: '/bin/claude', permission: 'default' },
      model: 'haiku',
      effort: 'low',
      permission: 'default',
      fast: false,
    }),
  };
  const hook = claudeWarmOnOpen({
    adapter,
    api: {
      isLive: (key: string) => key === 'claude:live',
      sessionCwd: async (id: string) => (id === 'nodisk' ? null : '/work'),
      warm: async (key: string, opts: any) => (warms.push([key, opts]), o.started ?? true),
    },
    ref: (chatId: string) => (chatId === 'none' ? null : { key: `claude:${chatId}`, id: chatId }),
  });
  return { hook, warms, live };
}

test("Claude Code resumes the chat's session with the options its next send would use, and registers them for a later pick", async () => {
  const { hook, warms, live } = claudeHook();
  assert.equal(await hook.warm('s1'), true);
  assert.deepEqual(warms, [
    [
      'claude:s1',
      {
        bin: '/bin/claude',
        sessionId: 's1',
        resume: true,
        cwd: '/work',
        model: 'haiku',
        effort: 'low',
        permission: 'default',
        fast: false,
        account: 'acct',
        basePermission: 'default',
        chatId: 's1',
      },
    ],
  ]);
  assert.deepEqual(live.get('claude:s1'), { model: 'haiku', effort: 'low', permission: 'default', fast: false, account: 'acct' });
  // a folder the adapter knows is used as the send uses it
  const known = claudeHook({ sessions: { 'claude:s2': { cwd: '/known' } } });
  await known.hook.warm('s2');
  assert.equal(known.warms[0][1].cwd, '/known');
  // a CLI that did not start registers nothing
  const refused = claudeHook({ started: false });
  assert.equal(await refused.hook.warm('s3'), false);
  assert.equal(refused.live.size, 0);
});

test('Claude Code warms nothing for a chat with no segment, a live or starting CLI, nothing on disk, a side or temporary chat', async () => {
  const { hook, warms } = claudeHook({
    starting: ['claude:busy'],
    sessions: { 'claude:new': { fresh: true }, 'claude:side': { forkFrom: 'x' }, 'claude:tmp': { ephemeral: true } },
  });
  for (const id of ['none', 'live', 'busy', 'new', 'side', 'tmp', 'nodisk']) assert.equal(await hook.warm(id), false, id);
  assert.deepEqual(warms, []);
});

test('app:viewing records the view and warms each chat that comes on screen; quitting stops what is pending', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { register } = require('../electron/app/ipc/app.cjs');
    const handlers = new Map<string, any>();
    const quits: any[] = [];
    const viewedBy = new Map<number, any>();
    const view = (...visible: string[]) => ({ visible, primary: visible[0] ?? null, focused: visible[0] ?? null });
    const warms: string[] = [];
    let enabled = true;
    const live: any = {
      computerUse: { onViewed: () => {} },
      controller: { ref: (id: string) => ({ kind: 'claude', key: `claude:${id}`, id }) },
      claudeTurns: {
        sessions: new Map(),
        live: new Map(),
        settings: () => ({ account: null, prefs: {}, model: null, effort: null, permission: 'default', fast: false }),
      },
    };
    register(
      { handle: (ch: string, fn: any) => handlers.set(ch, fn), on: () => {} },
      {
        app: { on: (ev: string, fn: any) => ev === 'will-quit' && quits.push(fn), isPackaged: false, getPath: () => '/tmp' },
        handle: () => {},
        readyMainWindow: async () => null,
        viewedBy,
        live,
        webContents: { fromId: (id: number) => (id === 1 ? { isDestroyed: () => false } : null) },
        isFlagEnabled: (f: string) => f === 'shared.prewarm' && enabled,
        claude: {
          turnApi: {
            isLive: () => false,
            sessionCwd: async () => '/w',
            warm: async (key: string) => (warms.push(key), true),
          },
        },
      },
    );
    await handlers.get('app:viewing')({ sender: { id: 1 } }, view('c1'));
    assert.deepEqual(viewedBy.get(1), view('c1'));
    mock.timers.tick(SETTLE_MS);
    await flush();
    assert.deepEqual(warms, ['claude:c1']);
    // no Claude adapter yet: nothing to warm
    const turns = live.claudeTurns;
    live.claudeTurns = null;
    await handlers.get('app:viewing')({ sender: { id: 1 } }, view('c2'));
    mock.timers.tick(SETTLE_MS);
    await flush();
    live.claudeTurns = turns;
    assert.deepEqual(warms, ['claude:c1']);
    // a chat opened beside it in a split pane warms; the one already shown, or focus moving between them, warms nothing
    await handlers.get('app:viewing')({ sender: { id: 1 } }, view('c2', 'c5'));
    await handlers.get('app:viewing')({ sender: { id: 1 } }, { visible: ['c2', 'c5'], primary: 'c2', focused: 'c5' });
    mock.timers.tick(SETTLE_MS);
    await flush();
    assert.deepEqual(warms, ['claude:c1', 'claude:c5']);
    // the switch off, then a view that quitting cancels
    enabled = false;
    await handlers.get('app:viewing')({ sender: { id: 1 } }, view('c3'));
    enabled = true;
    await handlers.get('app:viewing')({ sender: { id: 1 } }, view('c4'));
    quits.forEach((fn) => fn());
    mock.timers.tick(SETTLE_MS);
    await flush();
    assert.deepEqual(warms, ['claude:c1', 'claude:c5']);
    // a view cleared, or a report of the wrong shape
    await handlers.get('app:viewing')({ sender: { id: 1 } }, view());
    assert.deepEqual(viewedBy.get(1), { visible: [], primary: null, focused: null }, 'a known, empty view');
    await handlers.get('app:viewing')({ sender: { id: 1 } }, view('c6'));
    await handlers.get('app:viewing')({ sender: { id: 1 } }, 'c6');
    assert.deepEqual(viewedBy.get(1)?.visible, []);
  } finally {
    mock.timers.reset();
  }
});

test('A3: a warm under way when the app quits, or the chat is left, is told so by its hook and starts nothing more', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    let current: () => boolean = () => true;
    let release: () => void = () => {};
    const shown = new Set(['a']);
    const s = createWarmOnOpen({
      hooks: { claude: { warm: (_id: string, c: () => boolean) => ((current = c), new Promise<void>((r) => (release = r))) } },
      kindOf: () => 'claude',
      shown: (id: string) => shown.has(id),
    });
    s.viewed('a');
    mock.timers.tick(SETTLE_MS);
    await flush();
    assert.equal(current(), true);
    shown.delete('a');
    assert.equal(current(), false, 'the chat left');
    shown.add('a');
    s.stop();
    assert.equal(current(), false, 'the app is quitting');
    release();
    await flush();
    // the Claude Code hook gives up after its folder read when the chat is no longer worth warming
    const { hook, warms } = claudeHook();
    assert.equal(await hook.warm('s9', () => false), false);
    assert.deepEqual(warms, []);
  } finally {
    mock.timers.reset();
  }
});

test('a window that is still open shows the chat; a closed one or another chat does not', () => {
  const viewedBy = new Map<number, any>([
    [1, { visible: ['a'], focused: 'a' }],
    [2, { visible: ['b'], focused: 'b' }],
    // a split pane that isn't focused shows its chat too
    [3, { visible: ['c', 'a'], focused: 'c' }],
  ]);
  const wcs: any = { 1: { isDestroyed: () => true }, 3: { isDestroyed: () => false, focused: false } };
  const webContents = { fromId: (id: number) => wcs[id] ?? null };
  assert.equal(chatShownIn(viewedBy, webContents, 'a'), true);
  assert.equal(
    chatShownIn(viewedBy, webContents, 'a', (wc: any) => wc.focused),
    false,
  );
  assert.equal(chatShownIn(viewedBy, webContents, 'b'), false);
});

test('Codex under memory pressure recycles after a minute of quiet instead of the full period; no pressure does nothing', async () => {
  const { codexRecycler, PRESSURE_IDLE_MS, IDLE_MS } = require('../electron/harness/codexRecycle.cjs');
  const log: string[] = [];
  const codex: any = {
    lastActivity: 0,
    running: new Set(),
    leases: new Map(),
    pending: new Map(),
    heldRequests: new Map(),
    prewarmed: new Set(),
    titling: new Map(),
    hidden: new Map(),
    realtime: new Set(),
    call: async (m: string) => (m === 'thread/loaded/list' ? { data: ['t1'] } : { data: [] }),
    connect: async () => log.push('connect'),
    onStatus: () => {},
  };
  const server = { proc: {}, stop: () => log.push('stop') };
  const r = codexRecycler({ server: () => server, codex: () => codex, now: () => PRESSURE_IDLE_MS + 1 });
  assert.ok(PRESSURE_IDLE_MS < IDLE_MS);
  r.onPressure(null);
  await flush();
  assert.deepEqual(log, []);
  r.onPressure('warning');
  await flush();
  assert.deepEqual(log, ['stop', 'connect']);
  // once a minute: the next reading within it runs no pass
  r.onPressure('critical');
  await flush();
  assert.deepEqual(log, ['stop', 'connect']);
  // a pass that throws (Codex does not come back) is noted
  clearIgnored();
  const other = { proc: {}, stop: () => {} };
  const broken = { ...codex, connect: async () => Promise.reject(new Error('no codex')) };
  const failing = codexRecycler({
    server: () => other,
    codex: () => broken,
    now: () => PRESSURE_IDLE_MS + 1,
  });
  failing.onPressure('critical');
  await flush();
  assert.ok(recentIgnored().some((e: any) => e.context === 'recycle Codex under memory pressure'));
});
