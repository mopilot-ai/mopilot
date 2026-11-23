// Main-process PR monitor entrypoint tests across current harnesses, lifecycle, IPC and authenticated tools.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { selectSegment, tick } from './support/controller/fixture.ts';
import { Accounts } from '../electron/identity/codexAccounts.cjs';
import { CodexDriver } from '../electron/identity/drivers/codex.cjs';
import { Registry } from '../electron/identity/contract/registry.cjs';
import { ClaudeAdapter } from '../electron/harness/claude/adapter.cjs';
import { assertInputCurrent } from '../electron/session/contract/inputGuard.cjs';

import { prMonitorFixture } from './support/pr-monitor-fixture.ts';

const url = 'https://github.com/o/r/pull/1';

test('IPC controls and shared tools bind PRs and route no-window autofix through each current harness', async () => {
  const f = prMonitorFixture();
  try {
    for (const [family, expected] of [
      ['codex', 'turn'],
      ['claude', 'claude-turn'],
      ['acp:qwen', 'acp-turn'],
    ]) {
      const id = `chat-${family}`;
      selectSegment(f.controller, f.chats, id, [[family, `native-${family}`]]);
      const ctx = { chatId: id, segmentId: f.controller.ref(id).key };
      const configured = f.tools.get('set_pr_monitor').handler({ url, autoFix: true }, ctx);
      assert.equal(configured.autoFix, true);
      await f.monitor.refresh(id);
      assert.equal(f.execs.at(-1)!.kind, expected);
      assert.equal(f.execs.at(-1)!.chatId, id);
      assert.equal(f.execs.at(-1)!.item.opts.human, false);
      assert.equal(f.tools.get('get_pr_monitor').handler({}, ctx).message, 'Autofix started');
      assert.equal((await f.handlers.get('prMonitor:refresh')({ sender: f.sender }, id)).uncertain, false);
    }
    const id = 'chat-codex';
    assert.ok(f.handlers.get('prMonitor:snapshot')({ sender: f.sender }, id));
    assert.equal(f.handlers.get('prMonitor:configure')({ sender: f.sender }, id, { autoFix: false }).autoFix, false);
    await tick();
    for (const sender of [{ isDestroyed: () => false }, f.sender]) {
      if (sender === f.sender) f.sender.isDestroyed = () => true;
      assert.throws(() => f.handlers.get('prMonitor:snapshot')({ sender }, id), /Unknown app window/);
    }
    assert.throws(() => f.tools.get('set_pr_monitor').handler({ url }, { chatId: 'missing', segmentId: 'x' }), /current chat segment/);
    assert.throws(() => f.tools.get('get_pr_monitor').handler({}, { chatId: id, segmentId: 'old' }), /current chat segment/);
    await f.timer();
  } finally {
    f.cleanup();
  }
});

test('mixed harness switches retain stable binding but stale tool callers cannot change it', async () => {
  const f = prMonitorFixture();
  try {
    selectSegment(f.controller, f.chats, 'chat', [['codex', 'first']]);
    f.monitor.configure('chat', { url, autoFix: true });
    selectSegment(f.controller, f.chats, 'chat', [
      ['codex', 'first'],
      ['claude', 'second'],
    ]);
    await f.monitor.refresh('chat');
    assert.equal(f.execs[0].kind, 'claude-turn');
    assert.throws(
      () => f.tools.get('set_pr_monitor').handler({ url, autoFix: false }, { chatId: 'chat', segmentId: 'first' }),
      /current chat segment/,
    );
    assert.equal(f.monitor.snapshot('chat')!.autoFix, true);
  } finally {
    f.cleanup();
  }
});

test('common availability gates never start archived, stopped, busy, crashed, goal, switch or approval work', async () => {
  const f = prMonitorFixture();
  try {
    f.chats.ensure('chat');
    f.monitor.configure('chat', { url, autoFix: true });
    const cases = [
      () => f.chats.patchMeta('chat', { archived: 1 }),
      () => f.live.peerRuntime.paused.add('chat'),
      () => f.state.patch('chat', { runningElsewhere: true }),
      () => f.state.patch('chat', { pendingSwitch: {} }),
      () => f.state.patch('chat', { approvals: [{}] }),
      () => f.state.patch('chat', { goal: { status: 'paused' } }),
      () => f.state.patch('chat', { turn: 'crashed' }),
      () => f.state.patch('chat', { turn: 'running' }),
      () => f.state.patch('chat', { queue: [{}] }),
      () => {
        f.deps.flags = false;
      },
    ];
    for (const set of cases) {
      set();
      await f.monitor.refresh('chat');
      assert.equal(f.execs.length, 0);
      f.chats.patchMeta('chat', { archived: null });
      f.live.peerRuntime.paused.clear();
      f.state.patch('chat', { runningElsewhere: false, pendingSwitch: null, approvals: [], goal: null, turn: 'idle', queue: [] });
    }
    f.live.peerRuntime.projectOf = async () => null;
    await f.monitor.refresh('chat');
    assert.match(f.monitor.snapshot('chat')!.error!, /working folder/);
  } finally {
    f.cleanup();
  }
});

test('after the dispatch hook awaits, pause, configuration, deletion and scope changes cannot start native work', async () => {
  for (const action of ['stop', 'settings', 'delete', 'scope']) {
    const f = prMonitorFixture();
    try {
      f.chats.ensure('chat');
      f.monitor.configure('chat', { url, autoFix: true });
      // The existing peer hook is invoked before the monitor’s final native-dispatch guard.
      const hook = f.controller.beforeDispatch;
      f.controller.beforeDispatch = async (event: any) => {
        if (action === 'stop') f.live.peerRuntime.paused.add('chat');
        if (action === 'settings') f.monitor.configure('chat', { autoFix: false });
        if (action === 'delete') f.chats.records.delete('chat');
        if (action === 'scope') f.chats.patchMeta('chat', { account: { id: 'another' } });
        return hook(event);
      };
      await f.monitor.refresh('chat');
      assert.equal(f.execs.length, 0);
    } finally {
      f.cleanup();
    }
  }
});

test("a basic chat's scope is its own harness: another basic harness's check does not stop its dispatch", async () => {
  for (const [changed, runs] of [
    ['acp:gemini', 0],
    ['acp:goose', 1],
  ] as const) {
    const f = prMonitorFixture();
    try {
      selectSegment(f.controller, f.chats, 'chat', [['acp:gemini', 'native-g']]);
      const list = [
        { id: 'acp:gemini', status: 'ok' },
        { id: 'acp:goose', status: 'signedOut' },
      ];
      f.live.identity = { driver: () => null, instances: () => list.map((i) => ({ ...i })) };
      f.monitor.configure('chat', { url, autoFix: true });
      const hook = f.controller.beforeDispatch;
      f.controller.beforeDispatch = async (event: any) => {
        // a check runs while the dispatch waits: that harness reads unavailable
        list.find((i) => i.id === changed)!.status = 'unavailable';
        return hook(event);
      };
      await f.monitor.refresh('chat');
      assert.equal(f.execs.length, runs, changed);
    } finally {
      f.cleanup();
    }
  }
});

test('storage is reloaded and corrupt or unreadable files remain visible failures', async () => {
  const f = prMonitorFixture();
  try {
    f.chats.ensure('chat');
    f.monitor.configure('chat', { url });
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir, 'pr-monitors.json'), 'utf8'))[0].url, url);
    // Preserve a later hook when this module shuts down.
    f.controller.beforeDispatch = async () => {};
  } finally {
    f.cleanup();
  }
  for (const seed of ['[]', '{']) {
    const next = prMonitorFixture(seed);
    try {
      if (seed === '{') assert.throws(() => next.monitor.snapshot('chat'), /JSON/);
      else assert.equal(next.monitor.snapshot('chat'), null);
    } finally {
      next.cleanup();
    }
  }
});

test('delivery boundary rechecks busy/deleted chats and retired ownership; ordinary user sends remain unaffected', async () => {
  const f = prMonitorFixture();
  try {
    f.chats.ensure('chat');
    assert.equal(f.monitor.o.blocked('missing'), 'chat deleted');
    assert.deepEqual(await f.monitor.o.deliver('chat', { id: 'unused' }, () => false), { started: false, error: 'Chat changed' });
    f.state.patch('chat', { turn: 'running' });
    assert.deepEqual(await f.monitor.o.deliver('chat', { id: 'unused' }, () => true), { started: false, error: 'chat busy' });
    f.state.patch('chat', { turn: 'idle', goal: { status: 'completed' } });
    f.controller.send('chat', { text: 'user input', opts: { human: true } });
    await tick();
    assert.equal(f.execs[0].item.text, 'user input');
  } finally {
    f.cleanup();
  }
});

test('a PR fix waits for a goal main knows runs or is paused, and not for a complete one (#2759)', () => {
  const f = prMonitorFixture();
  try {
    f.chats.ensure('chat');
    // the status is 'complete': a finished goal held the PR monitor while the check compared it with 'completed'
    f.state.patch('chat', { goal: { objective: 'ship', status: 'complete' } });
    assert.equal(f.monitor.o.blocked('chat'), null);
    f.state.patch('chat', { goal: { objective: 'ship', status: 'paused' } });
    assert.equal(f.monitor.o.blocked('chat'), 'goal active or paused');
    // the adapter's own record decides over a window's report, with no window open too
    f.state.ownGoal = (id: string) => (id === 'chat' ? 'active' : undefined);
    f.state.patch('chat', { goal: null });
    assert.equal(f.monitor.o.blocked('chat'), 'goal active or paused');
  } finally {
    f.cleanup();
  }
});

test('effective Codex pins/providers and Claude own/active accounts retire pending reads', async () => {
  for (const mode of ['codex-pin', 'codex-active', 'codex-provider', 'claude-own', 'claude-active']) {
    const f = prMonitorFixture();
    try {
      const family = mode.startsWith('claude') ? 'claude' : 'codex';
      selectSegment(f.controller, f.chats, 'chat', [[family, 'native']]);
      let active = 'a';
      const accounts: any = {
        state: { accounts: [{ id: 'a' }, { id: 'b' }] },
        pins: new Map(),
        changed() {},
        save() {},
        broadcast() {},
        view() {},
        get: (id: string) => accounts.state.accounts.find((a: any) => a.id === id),
        active: () => accounts.get(active),
        // every account here is a subscription in usage: one lane
        inChatLane: () => true,
        limited: () => false,
      };
      f.live.identity = new Registry();
      f.live.identity.register(new CodexDriver(accounts));
      const claude: any = {
        own: new Map(),
        settings: () => ({ permission: 'default' }),
        permissionChanged: () => assert.fail("an account-only receipt preserves this fixture's permission capability"),
        savedAccount: () => null,
        clock: Date.now,
        pickOf: (id: string) => ClaudeAdapter.prototype.pickOf.call(claude, id),
        api: {
          accounts: () => ({
            active,
            accounts: [
              { id: 'a', loggedIn: true },
              { id: 'b', loggedIn: true },
            ],
          }),
        },
      };
      f.controller.claudeTurns.accountOf = (id: string) => ClaudeAdapter.prototype.accountOf.call(claude, id);
      f.monitor.configure('chat', { url, autoFix: true });
      let finish!: (value: any) => void;
      f.monitor.o.read = () =>
        new Promise((resolve) => {
          finish = resolve;
        });
      const pending = f.monitor.refresh('chat');
      if (mode === 'codex-pin') Accounts.prototype.pinChat.call(accounts, 'native', 'b');
      if (mode === 'codex-active' || mode === 'claude-active') active = 'b';
      if (mode === 'codex-provider') Object.assign(accounts.get('a'), { kind: 'apiKey', baseUrl: 'https://replacement.example/v1' });
      if (mode === 'claude-own') ClaudeAdapter.prototype.setOwn.call(claude, 'chat', { account: 'b' });
      finish({ state: 'OPEN', events: [{ key: 'failure', text: 'failed' }] });
      await pending;
      assert.equal(f.execs.length, 0, mode);
    } finally {
      f.cleanup();
    }
  }
});

test('the production delivery keeps its input guard through asynchronous adapter preparation', async () => {
  const f = prMonitorFixture();
  try {
    f.chats.ensure('chat');
    f.monitor.configure('chat', { url, autoFix: true });
    let release!: () => void;
    const preparing = new Promise<void>((resolve) => {
      release = resolve;
    });
    let sent = 0;
    f.controller.codex.startTurn = async (_chat: string, _ref: any, item: any) => {
      await preparing;
      assertInputCurrent(item);
      sent++;
      return { started: true };
    };
    const pending = f.monitor.refresh('chat');
    await tick();
    f.monitor.configure('chat', { autoFix: false });
    release();
    await pending;
    assert.equal(sent, 0);
  } finally {
    f.cleanup();
  }
});

test('GitHub work from explicit refreshes serializes globally and recovers after failure and retirement', async () => {
  const f = prMonitorFixture();
  try {
    for (const id of ['a', 'b', 'c']) {
      f.chats.ensure(id);
      f.monitor.configure(id, { url });
    }
    const calls: string[] = [];
    f.live.peerRuntime.projectOf = async (id: string) => {
      calls.push(id);
      return '/work';
    };
    // Invoke the production read boundary with a pending current check to model retired queued work.
    let current = true;
    const first = f.monitor.o.read('invalid', false, 'a', () => true);
    const second = f.monitor.o.read(url, false, 'b', () => current);
    const third = f.monitor.o.read(url, false, 'c', () => true);
    current = false;
    await assert.rejects(first, /GitHub pull request URL/);
    await assert.rejects(second, /context changed/);
    await third;
    // each folder is read on joining the queue; the retired read never reaches GitHub
    assert.deepEqual(calls, ['a', 'b', 'c']);
  } finally {
    f.cleanup();
  }
});

test("the chat's folder is read without blocking, and a context change while it is read retires the read before GitHub", async () => {
  const f = prMonitorFixture();
  try {
    f.chats.ensure('chat');
    let found!: (cwd: string) => void;
    f.live.peerRuntime.projectOf = () =>
      new Promise((resolve) => {
        found = resolve;
      });
    let current = true;
    const read = f.monitor.o.read(url, false, 'chat', () => current);
    await new Promise((resolve) => setImmediate(resolve));
    current = false;
    found('/work');
    await assert.rejects(read, /context changed/);
    assert.equal(f.deps.ran, 0);
    // a read whose context holds goes on to GitHub in the folder it found
    f.live.peerRuntime.projectOf = async () => '/work';
    const held = await f.monitor.o.read(url, false, 'chat', () => true);
    assert.equal(held.state, 'OPEN');
    // the PR, then its repository's default branch: the PR's base is that branch, so it is stacked on nothing
    assert.deepEqual(held.parents, []);
    assert.equal(f.deps.ran, 2);
  } finally {
    f.cleanup();
  }
});

test('Stop followed by a replacement user turn cannot revive an automatic send still preparing', async () => {
  const f = prMonitorFixture();
  try {
    f.chats.ensure('chat');
    f.monitor.configure('chat', { url, autoFix: true });
    let finish!: () => void;
    const preparation = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const sent: string[] = [];
    f.controller.codex.startTurn = async (_chat: string, _ref: any, item: any) => {
      if (!item.opts.human) await preparation;
      assertInputCurrent(item);
      sent.push(item.text);
      return { started: true };
    };
    const old = f.monitor.refresh('chat');
    await tick();
    f.live.peerRuntime.paused.add('chat');
    f.controller.end('chat', { drain: false });
    f.live.peerRuntime.paused.delete('chat');
    f.controller.send('chat', { text: 'replacement user input', opts: { human: true } });
    await tick();
    finish();
    await old;
    assert.deepEqual(sent, ['replacement user input']);
    assert.equal(f.state.get('chat').turn, 'running');
  } finally {
    f.cleanup();
  }
});

test('automatic input requires the controller hook and its original pending token', async () => {
  for (const scenario of ['missing-hook', 'ended-turn']) {
    const f = prMonitorFixture();
    try {
      f.chats.ensure('chat');
      f.monitor.configure('chat', { url, autoFix: true });
      if (scenario === 'missing-hook') {
        f.controller.start = async (_id: string, item: any) => {
          assertInputCurrent(item);
          return { started: true };
        };
      } else {
        f.controller.codex.startTurn = async (_id: string, _ref: any, item: any) => {
          f.controller.end('chat', { drain: false });
          assertInputCurrent(item);
          return { started: true };
        };
      }
      await f.monitor.refresh('chat');
      assert.equal(f.execs.length, 0);
      assert.equal(f.monitor.snapshot('chat')!.uncertain, true);
    } finally {
      f.cleanup();
    }
  }
});

test("an open PR's read carries its stack; a failed stack read keeps the monitor working, and an ended PR reads none", async () => {
  const f = prMonitorFixture();
  try {
    f.chats.ensure('chat');
    const view = {
      url,
      title: 'PR',
      state: 'OPEN',
      headRefOid: 'head',
      headRefName: 'child',
      baseRefName: 'parent',
      mergeable: 'MERGEABLE',
      statusCheckRollup: [],
    };
    const parent = {
      url: 'https://github.com/o/r/pull/2',
      title: 'Parent',
      state: 'OPEN',
      headRefName: 'parent',
      baseRefName: 'main',
      isCrossRepository: false,
      statusCheckRollup: [],
    };
    const answers: Record<string, any> = { view, repo: { defaultBranchRef: { name: 'main' } }, list: [parent] };
    const asked: string[] = [];
    f.deps.github = async (_cmd: string, args: string[]) => {
      const kind = args[0] === 'repo' ? 'repo' : args[1];
      asked.push(kind);
      const answer = answers[kind];
      return answer instanceof Error
        ? { ok: false, stdout: '', stderr: answer.message }
        : { ok: true, stdout: JSON.stringify(answer), stderr: '' };
    };
    f.monitor.configure('chat', { url });
    await f.monitor.refresh('chat');
    const shown = f.monitor.snapshot('chat')!;
    assert.deepEqual(shown.pr.parents, [
      { url: parent.url, title: 'Parent', state: 'OPEN', headRefName: 'parent', baseRefName: 'main', failed: 0, pending: 0 },
    ]);
    assert.deepEqual(asked, ['view', 'repo', 'list']);
    // GitHub refusing the stack's list leaves the PR monitored, without an error, and its cards as last read
    answers.list = new Error('rate limited');
    await f.monitor.refresh('chat');
    assert.equal(f.monitor.snapshot('chat')!.error, null);
    assert.deepEqual(f.monitor.snapshot('chat')!.pr.parents, shown.pr.parents);
    assert.equal(f.monitor.snapshot('chat')!.pr.stackError, 'rate limited');
    assert.equal(shown.pr.stackError, undefined);
    // a merged PR is stacked on nothing worth showing, and costs no stack read
    asked.length = 0;
    answers.view = { ...view, state: 'MERGED' };
    await f.monitor.refresh('chat');
    assert.deepEqual(f.monitor.snapshot('chat')!.pr.parents, []);
    assert.deepEqual(asked, ['view']);
    // a context change after the PR's read retires the read before the stack is asked for
    answers.view = view;
    asked.length = 0;
    let current = true;
    const read = f.monitor.o.read(url, false, 'chat', () => current);
    f.deps.github = async (...args: any[]) => {
      current = false;
      return { ok: true, stdout: JSON.stringify(view), stderr: '', args };
    };
    await assert.rejects(read, /context changed/);
  } finally {
    f.cleanup();
  }
});
