// Claude Code and ACP turns' file changes from Git snapshots (electron/session/turnSnapshots.cjs): what a shell command
// wrote counts, live and at the end, through the real ChatController, and read back from their transcripts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseUnifiedDiff } from '../src/lib/diff.ts';
import { buildAcpTurns } from '../electron/harness/items/acpTranslator.cjs';
import { tick } from './support/async-scenarios.ts';

const require = createRequire(import.meta.url);
const { SessionStore } = require('../electron/session/state.cjs');
const { ChatController } = require('../electron/session/controller.cjs');
const { TurnChanges } = require('../electron/session/turnChanges.cjs');
const { TurnSnapshots, savedTurnChanges } = require('../electron/session/turnSnapshots.cjs');

/** A repository with one committed file, as a chat's folder. */
async function repo() {
  const cwd = await mkdtemp(join(tmpdir(), 'turn-snapshots-ut-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.name', 'UT');
  git('config', 'user.email', 'ut@example.invalid');
  await writeFile(join(cwd, 'kept.ts'), 'old\n');
  git('add', '.');
  git('commit', '-qm', 'baseline');
  return cwd;
}

/** A ChatController with Claude ('cl…') and ACP ('acp…') chats, its turn snapshots attached. */
function setup(changes: any, o: { delayMs?: number } = {}) {
  const kindOf = (id: string) => (id.startsWith('cl') ? 'claude' : 'acp:kimi');
  const rec = (id: string) => ({ id, segments: [{ kind: kindOf(id), nativeId: id }] });
  const state = new SessionStore();
  const c = new ChatController({
    state,
    chats: {
      record: rec,
      records: new Map([
        ['cl1', rec('cl1')],
        ['cl2', rec('cl2')],
        ['acp1', rec('acp1')],
      ]),
    },
    codex: {},
    claudeTurns: { startTurn: async () => ({ started: true }), crashed: () => {} },
    acpTurns: { startTurn: async () => ({ started: true }) },
    claude: { send: async () => true },
    acp: { send: async () => true, cancel: () => true },
  });
  const published: any[] = [];
  let heard = () => {};
  const snapshots = new TurnSnapshots({
    changes,
    publish: (d: any) => {
      published.push(d);
      heard();
    },
    state,
    delayMs: o.delayMs ?? 0,
  });
  snapshots.attach(c);
  const next = () =>
    new Promise<void>((resolve) => {
      heard = resolve;
    });
  return { c, state, snapshots, published, next };
}

const result = (key: string) => ({ key, kind: 'message', msg: { type: 'result', subtype: 'success', result: 'done' } });
const files = (diff: string) => parseUnifiedDiff(diff).map((f) => f.path);

test("a Claude Code turn's diff holds what a shell command wrote, and its transcript reads it back", async () => {
  const cwd = await repo();
  try {
    const changes = new TurnChanges();
    const { c, snapshots, published, next } = setup(changes);
    await c.claudeSend('cl1', 'claude:cl1', { cwd }, null, 'next', { uuid: 'p1' });
    await changes.baselines.get('claude:cl1').ready;
    // no Edit or Write tool: a script writes the files
    await writeFile(join(cwd, 'kept.ts'), 'new\n');
    await writeFile(join(cwd, 'script.ts'), 'made by sed\n');
    const finished = next();
    c.onClaudeEvent(result('claude:cl1'));
    await finished;
    assert.equal(published.length, 1);
    assert.equal(published[0].chatId, 'cl1');
    assert.equal(published[0].turnId, 'ct-p1');
    assert.deepEqual(files(published[0].diff).sort(), ['kept.ts', 'script.ts']);
    // read back, the transcript names the turn h-<prompt>
    assert.deepEqual(snapshots.savedDiffs('claude:cl1', ['h-p1', 'h-other']), { 'h-p1': published[0].diff });
    assert.deepEqual(snapshots.savedDiffs('claude:cl1', []), {});
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

/** TurnChanges over in-memory trees: each capture is the folder's current contents. */
function virtual() {
  const folder = { contents: 'base' };
  const changes = new TurnChanges(
    async () => folder.contents,
    async (_cwd: string, before: string, after: string) => (before === after ? '' : `${before}->${after}`),
    null,
    (cwd: string) => cwd,
  );
  return { changes, folder };
}

test('an ACP turn shows its changes after each tool call and at its end, and its transcript reads them back', async () => {
  const { changes, folder } = virtual();
  const { c, state, snapshots, published, next } = setup(changes);
  // the chat is open: acpSend made its session state
  state.patch('acp1', { plan: false });
  c.onAcpEvent({ key: 'acp:kimi:acp1', kind: 'turnStart', turnId: 'at-p2', cwd: '/work' });
  await changes.baselines.get('acp:kimi:acp1').ready;
  c.onAcpEvent({ key: 'acp:kimi:acp1', kind: 'update', turnId: 'at-p2', update: { sessionUpdate: 'tool_call', status: 'pending' } });
  folder.contents = 'edited';
  let heard = next();
  c.onAcpEvent({
    key: 'acp:kimi:acp1',
    kind: 'update',
    turnId: 'at-p2',
    update: { sessionUpdate: 'tool_call_update', status: 'completed' },
  });
  await heard;
  assert.deepEqual(published.at(-1), { chatId: 'acp1', turnId: 'at-p2', diff: 'base->edited' });
  // updates that are no tool call's end read nothing
  c.onAcpEvent({ key: 'acp:kimi:acp1', kind: 'update', turnId: 'at-p2', update: { sessionUpdate: 'agent_message_chunk' } });
  c.onAcpEvent({ key: 'acp:kimi:acp1', kind: 'update', turnId: 'at-p2', update: { sessionUpdate: 'tool_call_update' } });
  await tick();
  assert.equal(published.length, 1);
  folder.contents = 'final';
  heard = next();
  c.onAcpEvent({ key: 'acp:kimi:acp1', kind: 'turnEnd', turnId: 'at-p2', stopReason: 'end_turn' });
  await heard;
  assert.deepEqual(published.at(-1), { chatId: 'acp1', turnId: 'at-p2', diff: 'base->final' });
  // the transcript gets a diff record per turn with a saved diff, which the replay puts on the turn
  const records: any[] = [
    { t: 'user', turnId: 'at-p2', user: { id: 'u-p2', clientId: 'p2', content: [] } },
    { t: 'end', turnId: 'at-p2', stopReason: 'end_turn' },
    { t: 'user', turnId: 'at-none', user: { id: 'u-none', clientId: 'none', content: [] } },
    { t: 'end', turnId: 'at-none', stopReason: 'end_turn' },
  ];
  const turns = buildAcpTurns(records, 'acp1', '/work');
  assert.equal(turns.length, 2);
  const ids = turns.map((t: any) => t.id);
  assert.deepEqual(snapshots.savedOf('acp:kimi:acp1', ids), { 'at-p2': 'base->final' });
  assert.deepEqual(snapshots.savedOf('acp:kimi:other', ids), {});
});

test('a malformed diff record changes no turn', () => {
  const turns = buildAcpTurns(
    [
      { t: 'user', turnId: 'at-1', user: { id: 'u-1', clientId: '1', content: [] } },
      { t: 'end', turnId: 'at-1', stopReason: 'end_turn' },
      { t: 'diff', turnId: 'at-1', diff: 42 } as any,
      { t: 'diff', turnId: 'at-gone', diff: 'patch' },
    ],
    'acp1',
    '/work',
  );
  assert.equal(turns.length, 1);
  assert.equal(turns[0].diff, undefined);
});

test("a live read still in flight when the turn ends publishes nothing over the turn's final diff", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const { changes, folder } = virtual();
  const peek = changes.peek.bind(changes);
  changes.peek = async (key: string) => {
    await gate;
    return peek(key);
  };
  const { c, published, next } = setup(changes);
  await c.claudeSend('cl1', 'claude:cl1', { cwd: '/work' }, null, 'next', { uuid: 'p3' });
  await changes.baselines.get('claude:cl1').ready;
  folder.contents = 'edited';
  const toolResult = { type: 'user', message: { content: [{ type: 'tool_result' }] } };
  c.onClaudeEvent({ key: 'claude:cl1', kind: 'message', msg: toolResult });
  await new Promise((r) => setTimeout(r, 5));
  // a second tool call ends while the first read is in flight: it reads again after, unless the turn ended
  c.onClaudeEvent({ key: 'claude:cl1', kind: 'message', msg: toolResult });
  const finished = next();
  c.onClaudeEvent(result('claude:cl1'));
  await finished;
  release();
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(published, [{ chatId: 'cl1', turnId: 'ct-p3', diff: 'base->edited' }]);
});

test('a burst of tool calls reads once, and a call ending during a read reads again after it', async () => {
  let release!: () => void;
  let gate = new Promise<void>((r) => {
    release = r;
  });
  const { changes, folder } = virtual();
  const peek = changes.peek.bind(changes);
  let reads = 0;
  changes.peek = async (key: string) => {
    reads++;
    await gate;
    return peek(key);
  };
  const { c, published, next } = setup(changes, { delayMs: 1 });
  await c.claudeSend('cl1', 'claude:cl1', { cwd: '/work' }, null, 'next', { uuid: 'p4' });
  await changes.baselines.get('claude:cl1').ready;
  const toolResult = { type: 'user', message: { content: [{ type: 'tool_result' }] } };
  folder.contents = 'one';
  c.onClaudeEvent({ key: 'claude:cl1', kind: 'message', msg: toolResult });
  c.onClaudeEvent({ key: 'claude:cl1', kind: 'message', msg: toolResult });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(reads, 1);
  c.onClaudeEvent({ key: 'claude:cl1', kind: 'message', msg: toolResult });
  folder.contents = 'two';
  let heard = next();
  const first = release;
  gate = Promise.resolve();
  first();
  await heard;
  // the call that ended during the read reads again, and finds the same diff, which windows already have
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(reads, 2);
  assert.deepEqual(
    published.map((d) => d.diff),
    ['base->two'],
  );
  c.end('cl1', { drain: false });
});

test("a tool call that starts before the start snapshot is taken leaves the turn to its items, and another chat's events change nothing", async () => {
  let take!: (tree: string) => void;
  const changes = new TurnChanges(
    () =>
      new Promise((r) => {
        take = r;
      }),
    async () => 'patch',
    null,
    (cwd: string) => cwd,
  );
  const { c, published } = setup(changes);
  await c.claudeSend('cl1', 'claude:cl1', { cwd: '/work' }, null, 'next', { uuid: 'p5' });
  // another chat's tool calls and an old session's are not this turn's
  c.onClaudeEvent({ key: 'claude:cl2', kind: 'message', msg: { type: 'assistant', message: { content: [{ type: 'tool_use' }] } } });
  assert.equal(changes.baselines.get('claude:cl1').raced, false);
  c.onClaudeEvent({ key: 'claude:cl1', kind: 'message', msg: { type: 'assistant', message: { content: [{ type: 'text', text: 'x' }] } } });
  assert.equal(changes.baselines.get('claude:cl1').raced, false);
  c.onClaudeEvent({ key: 'claude:cl1', kind: 'message', msg: { type: 'assistant', message: { content: [{ type: 'tool_use' }] } } });
  take('tree');
  c.onClaudeEvent(result('claude:cl1'));
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(published, []);
});

test('a steer adds no snapshot; a crash ends the turn with none; a turn with no snapshot ends quietly', async () => {
  const { changes, folder } = virtual();
  const { c, state, published } = setup(changes);
  await c.claudeSend('cl1', 'claude:cl1', { cwd: '/work' }, null, 'next', { uuid: 'p6' });
  const baseline = changes.baselines.get('claude:cl1');
  await c.claudeSend('cl1', 'claude:cl1', { cwd: '/work' }, null, 'now', { uuid: 'p7' });
  assert.equal(changes.baselines.get('claude:cl1'), baseline);
  folder.contents = 'edited';
  c.crash('cl1', 'gone');
  assert.equal(changes.baselines.has('claude:cl1'), false);
  // the turn the crash left is not this one's to finish; a chat that never snapshotted ends as before
  c.end('cl1', { drain: false });
  state.patch('cl2', { turn: 'running', activeTurn: { id: 'auto-1', human: false } });
  c.end('cl2', { drain: false });
  c.crash('cl2', 'gone');
  await tick();
  assert.deepEqual(published, []);
});

test('a turn whose id is unknown at its end is snapshotted but not kept', async () => {
  const { changes } = virtual();
  const { snapshots, published } = setup(changes);
  snapshots.begin('cl1', 'claude:cl1', '/work');
  await changes.baselines.get('claude:cl1').ready;
  await snapshots.finished({ chatId: 'cl1', turnId: null });
  assert.deepEqual(published, []);
  assert.deepEqual(Object.keys(changes.diffs), []);
});

test('failed snapshot work is noted, never thrown into the turn', async () => {
  const failing = {
    begin: async () => {
      throw new Error('begin');
    },
    finish: async () => {
      throw new Error('finish');
    },
    peek: async () => {
      throw new Error('peek');
    },
    itemStarted: () => {},
    abort: () => {},
  };
  const { c, published } = setup(failing);
  await c.claudeSend('cl1', 'claude:cl1', { cwd: '/work' }, null, 'next', { uuid: 'p8' });
  c.onClaudeEvent({ key: 'claude:cl1', kind: 'message', msg: { type: 'user', message: { content: [{ type: 'tool_result' }] } } });
  await new Promise((r) => setTimeout(r, 5));
  c.onClaudeEvent(result('claude:cl1'));
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(published, []);
});

test('a Claude Code turn and a Codex turn in one folder share the snapshot owner, so neither claims the other’s edits', async () => {
  const { changes, folder } = virtual();
  const { snapshots, published } = setup(changes);
  // the Codex adapter takes its own snapshot of its thread on the same TurnChanges (electron/app/sessions.cjs)
  await changes.begin('codex-thread', '/work');
  snapshots.begin('cl1', 'claude:cl1', '/work');
  await changes.baselines.get('claude:cl1').ready;
  folder.contents = 'both';
  await snapshots.finished({ chatId: 'cl1', turnId: 'ct-p9' });
  assert.equal(await changes.finish('codex-thread', 'turn'), undefined);
  assert.deepEqual(published, []);
});

test("main's one TurnChanges keeps every harness's diffs across a restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), 'turn-snapshots-saved-'));
  try {
    const first = savedTurnChanges(dir);
    first.capture = async () => 'tree';
    first.compare = async () => 'patch';
    first.resolveScope = (cwd: string) => cwd;
    await first.begin('claude:cl1', '/work');
    await first.finish('claude:cl1', 'p1');
    first.store.flushSync();
    const after = savedTurnChanges(dir);
    assert.equal(after.saved('claude:cl1', 'p1'), 'patch');
    assert.equal(savedTurnChanges(join(dir, 'missing')).saved('claude:cl1', 'p1'), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a turn that names no folder works in its session's last one, and one with none known is not snapshotted", async () => {
  const { changes } = virtual();
  const begun: any[] = [];
  const begin = changes.begin.bind(changes);
  changes.begin = (key: string, cwd: string) => (begun.push([key, cwd]), begin(key, cwd));
  const { c, snapshots } = setup(changes);
  // a steer that reached Claude Code after its turn ended is the next turn, sent without the session's options
  await c.claudeSend('cl2', 'claude:cl2', {}, null, 'now', { uuid: 'p10' });
  assert.deepEqual(begun, []);
  assert.equal(snapshots.turns.has('cl2'), false);
  await c.claudeSend('cl1', 'claude:cl1', { cwd: '/work' }, null, 'next', { uuid: 'p11' });
  c.end('cl1', { drain: false });
  await c.claudeSend('cl1', 'claude:cl1', {}, null, 'now', { uuid: 'p12' });
  assert.deepEqual(begun, [
    ['claude:cl1', '/work'],
    ['claude:cl1', '/work'],
  ]);
  c.end('cl1', { drain: false });
});

test("a live diff the final snapshot can't confirm is taken back, and a crash takes it back too", async () => {
  const { changes, folder } = virtual();
  const { c, published, next } = setup(changes);
  const toolResult = { type: 'user', message: { content: [{ type: 'tool_result' }] } };
  for (const end of ['overlap', 'crash']) {
    published.length = 0;
    await c.claudeSend('cl1', 'claude:cl1', { cwd: '/work' }, null, 'next', { uuid: `p-${end}` });
    await changes.baselines.get('claude:cl1').ready;
    folder.contents = `${end}-1`;
    let heard = next();
    c.onClaudeEvent({ key: 'claude:cl1', kind: 'message', msg: toolResult });
    await heard;
    assert.equal(published.at(-1).diff, `base->${end}-1`);
    folder.contents = 'base';
    if (end === 'overlap') {
      // another chat's turn in the same folder: neither can say whose edits they are
      await changes.begin('codex-thread', '/work');
      heard = next();
      c.onClaudeEvent(result('claude:cl1'));
      await heard;
      changes.abort('codex-thread');
    } else {
      heard = next();
      c.crash('cl1', 'gone');
      await heard;
    }
    assert.deepEqual(published.at(-1), { chatId: 'cl1', turnId: `ct-p-${end}`, diff: null });
  }
});

test("the turn's own id names its diff while the controller still knows it as a queue item's", async () => {
  const { changes } = virtual();
  const { c, state, published, next } = setup(changes);
  // the start's dispatch has not named the turn yet: the controller's activeTurn is pending-<queue item>
  state.patch('cl1', { turn: 'running', activeTurn: { id: 'pending-q1', human: true } });
  await c.claudeSend('cl1', 'claude:cl1', { cwd: '/work' }, null, 'next', { uuid: 'p13' });
  await changes.baselines.get('claude:cl1').ready;
  const heard = next();
  c.onClaudeEvent(result('claude:cl1'));
  await heard;
  assert.equal(published[0].turnId, 'ct-p13');
  assert.equal(changes.saved('claude:cl1', 'p13'), '');
});

test("a background agent's tool call after its turn ended voids that turn's final snapshot still being taken", async () => {
  let take!: (tree: string) => void;
  let captures = 0;
  const changes = new TurnChanges(
    () => (++captures === 2 ? new Promise((r) => (take = r)) : Promise.resolve('tree')),
    async () => 'patch with the agent edits',
    null,
    (cwd: string) => cwd,
  );
  const { c, published } = setup(changes);
  await c.claudeSend('cl1', 'claude:cl1', { cwd: '/work' }, null, 'next', { uuid: 'p14' });
  await changes.baselines.get('claude:cl1').ready;
  c.onClaudeEvent(result('claude:cl1'));
  await tick();
  // a sub-agent the turn started keeps working
  c.onClaudeEvent({
    key: 'claude:cl1',
    kind: 'message',
    msg: { type: 'assistant', parent_tool_use_id: 'task', message: { content: [{ type: 'tool_use' }] } },
  });
  take('after');
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(published, []);
});

test("a prompt that names no uuid goes by the controller's turn id, and a chat with no session state by none", async () => {
  const { changes, folder } = virtual();
  const { c, state, snapshots, published, next } = setup(changes);
  await c.claudeSend('cl1', 'claude:cl1', { cwd: '/work' }, null, 'next');
  await changes.baselines.get('claude:cl1').ready;
  const id = state.get('cl1').activeTurn.id;
  assert.match(id, /^ct-/);
  folder.contents = 'edited';
  const heard = next();
  c.onClaudeEvent({ key: 'claude:cl1', kind: 'message', msg: { type: 'user', message: { content: [{ type: 'tool_result' }] } } });
  await heard;
  assert.deepEqual(published.at(-1), { chatId: 'cl1', turnId: id, diff: 'base->edited' });
  c.end('cl1', { drain: false });
  await tick();
  // a chat main has no state for (snapshots begun outside the controller): no id to publish under
  published.length = 0;
  snapshots.begin('nostate', 'claude:nostate', '/work');
  await changes.baselines.get('claude:nostate').ready;
  snapshots.tool('nostate', 'claude:nostate', false);
  await new Promise((r) => setTimeout(r, 5));
  snapshots.turns.get('nostate').shown = true;
  snapshots.crashed('nostate');
  snapshots.crashed('nostate');
  assert.deepEqual(published, []);
});

test('a turn that ends while its live read is still waiting reads nothing more', async () => {
  const { changes, folder } = virtual();
  let peeks = 0;
  const peek = changes.peek.bind(changes);
  changes.peek = (key: string) => (peeks++, peek(key));
  const { c, published, next } = setup(changes, { delayMs: 60_000 });
  await c.claudeSend('cl1', 'claude:cl1', { cwd: '/work' }, null, 'next', { uuid: 'p15' });
  await changes.baselines.get('claude:cl1').ready;
  folder.contents = 'edited';
  c.onClaudeEvent({ key: 'claude:cl1', kind: 'message', msg: { type: 'user', message: { content: [{ type: 'tool_result' }] } } });
  const heard = next();
  c.onClaudeEvent(result('claude:cl1'));
  await heard;
  assert.equal(peeks, 0);
  assert.deepEqual(published, [{ chatId: 'cl1', turnId: 'ct-p15', diff: 'base->edited' }]);
});
