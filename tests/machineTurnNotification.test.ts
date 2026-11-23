// A machine chat's turn notification reads as a local chat's (#5165): the agent's name for a title, never its wire id, and a failed turn says it failed with the cause the Host gave.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { SessionStore } = require('../electron/session/state.cjs');
const { ChatController } = require('../electron/session/controller.cjs');
const { Notifier } = require('../electron/platform/notify.cjs');
const { notificationTarget } = require('../electron/app/computerAccess.cjs');
const { machineAwareLabel } = require('../electron/app/harnessLabel.cjs');

const label = machineAwareLabel({ describe: (basic: string) => (basic === 'kimi' ? { label: 'Kimi CLI' } : null) });

function chat(
  kind: string,
  localName?: string,
  id = 'c1',
  sink?: (k: string, id: string, o: any) => void,
  titleOf?: (key: string) => Promise<unknown>,
) {
  const said: any[] = [];
  const rec = { id, segments: [{ kind, nativeId: id }] };
  const state = new SessionStore();
  const c = new ChatController({
    state,
    chats: { record: () => rec, records: new Map([[id, rec]]) },
    codex: {},
    claudeTurns: {},
    acpTurns: {},
    acp: { send: async () => true, cancel: () => true, ...(titleOf ? { titleOf } : {}) },
    labelOf: label,
    chatTitle: () => localName ?? null,
    notify: (k: string, chatId: string, o: any) => (
      sink?.(k, chatId, o), said.push({ kind: k, title: o.title, chatTitle: o.chatTitle, body: o.body })
    ),
  });
  const key = `${kind}:${id}`;
  state.patch(id, { plan: false });
  let n = 0;
  const run = (stopReason: string, error: unknown, text?: string, user?: object) => {
    const turnId = `t${n++}`;
    c.onAcpEvent({ key, kind: 'turnStart', turnId, ...(user ? { user } : {}) });
    if (text) c.rt(id).lastText = text;
    c.onAcpEvent({ key, kind: 'turnEnd', turnId, stopReason, error });
    return said.at(-1);
  };
  const name = (text: string) => c.onAcpEvent({ key, kind: 'threadName', chatId: id, name: text, provisional: text });
  return { run, name, c, said: () => said };
}

test('a machine chat and a local chat of the same agent notify with the same title, kind and body', () => {
  for (const [machine, local] of [
    ['acp:host-codex', 'codex'],
    ['acp:host-claude', 'claude'],
  ]) {
    const a = chat(machine).run('end_turn', null);
    assert.equal(a.title, local === 'codex' ? 'Codex' : 'Claude Code');
    assert.deepEqual([a.kind, a.body], ['turn', 'Task complete']);
    assert.equal(label(local), a.title, 'the same name the local chat of that agent has');
  }
});

test('no native adapter id reaches a notification title', () => {
  assert.equal(label('acp:host-codex'), 'Codex');
  assert.equal(label('acp:host-claude'), 'Claude Code');
  assert.equal(label('acp:kimi'), 'Kimi CLI');
  assert.equal(label('acp:unknown'), 'unknown');
  assert.equal(label('nonsense'), 'nonsense');
});

test('a failed turn says it failed with the cause the Host gave, never the agent’s last words', () => {
  const { run } = chat('acp:host-codex');
  const a = run('error', { message: 'Not signed in: log in again' }, 'Here is the answer');
  assert.equal(a.body, 'The turn ended with an error: Not signed in: log in again');
  assert.equal(run('error', null, 'Almost done').body, 'The turn ended with an error');
  assert.equal(run('error', 'boom').body, 'The turn ended with an error: boom');
});

test('a failed local turn reads the same as a machine one', () => {
  assert.equal(chat('acp:kimi').run('error', 'disk full', 'last words').body, 'The turn ended with an error: disk full');
});

test('a machine chat carries the name its Host gave it in every notification, as a local chat carries its own', () => {
  const local = chat('acp:kimi', 'Fix the build');
  const machine = chat('acp:host-codex');
  machine.name('Fix the build');
  for (const [stop, error] of [
    ['end_turn', null],
    ['error', 'boom'],
    ['error', null],
  ] as const) {
    const a = local.run(stop, error, 'words');
    const b = machine.run(stop, error, 'words');
    assert.equal(b.chatTitle, 'Fix the build');
    assert.deepEqual([b.chatTitle, b.body, b.kind], [a.chatTitle, a.body, a.kind]);
  }
  assert.equal(machine.run('end_turn', null).title, 'Fix the build', 'the title is the chat name, as for a local Codex chat');
});

test('a failed turn with no cause has no dangling colon', () => {
  const m = chat('acp:host-codex');
  for (const error of [null, '', '  ']) assert.equal(m.run('error', error).body, 'The turn ended with an error');
});

test('a chat nobody named keeps its agent as the title', () => {
  assert.deepEqual(
    [chat('acp:host-claude').run('end_turn', null).title, chat('acp:host-claude').run('end_turn', null).chatTitle],
    ['Claude Code', undefined],
  );
});

/** Two chats finishing inside the merge window, through the real notifier: what the banner says and where its click goes. */
function merged(first: [string, string], second: [string, string]) {
  const shown: any[] = [];
  const n = new Notifier({
    getMode: () => 'always',
    getKinds: () => ({}),
    isFocused: () => false,
    now: () => 1_000_000,
    show: (x: any) => (shown.push(x), { close() {} }),
  });
  const sink = (k: string, id: string, o: any) => n.notify(k, id, o);
  for (const [kind, id] of [first, second]) chat(kind, undefined, id, sink).run('end_turn', null);
  return { last: shown.at(-1), target: notificationTarget(null, shown.at(-1).chatId) };
}

test('a machine chat finishing beside a local one merges and clicks exactly as two local chats do', () => {
  const local = merged(['acp:kimi', 'a'], ['acp:kimi', 'b']);
  const mixed = merged(['acp:host-codex', 'a'], ['acp:kimi', 'b']);
  const reverse = merged(['acp:kimi', 'a'], ['acp:host-codex', 'b']);
  assert.equal(local.last.title, '2 chats finished');
  for (const r of [mixed, reverse]) {
    assert.equal(r.last.title, local.last.title, 'one merged note, whichever chats ran on a machine');
    assert.deepEqual(r.target, ['open-chat', r.last.chatId], 'the click opens the chat that finished last');
  }
  assert.deepEqual(local.target, ['open-chat', 'b']);
});

test('a local Claude Code chat is titled with its chat name like a Codex chat (#5193)', () => {
  const said: any[] = [];
  const rec = { id: 'cl1', segments: [{ kind: 'claude', nativeId: 'cl1' }] };
  const state = new SessionStore();
  const c = new ChatController({
    state,
    chats: { record: () => rec, records: new Map([['cl1', rec]]) },
    codex: {},
    claudeTurns: {},
    acpTurns: {},
    labelOf: label,
    notify: (_k: string, _id: string, o: any) => said.push({ title: o.title, chatTitle: o.chatTitle }),
  });
  state.patch('cl1', { turn: 'running' });
  c.end('cl1');
  assert.deepEqual(said.at(-1), { title: 'Claude Code', chatTitle: undefined }, 'nobody named it yet: the agent');
  c.onClaudeEvent({ key: 'claude:cl1', kind: 'threadName', chatId: 'cl1', name: 'Fix the build', provisional: 'Fix' });
  state.patch('cl1', { turn: 'running' });
  c.end('cl1');
  assert.deepEqual(said.at(-1), { title: 'Fix the build', chatTitle: 'Fix the build' });
});

test('a machine chat the Host has not named yet is titled by its first words, as a local chat is (#5238)', () => {
  const user = { id: 'u', content: [{ type: 'text', text: 'Fix the flaky login test in the billing service' }] };
  const m = chat('acp:host-codex');
  const first = m.run('end_turn', null, undefined, user);
  assert.deepEqual(
    [first.title, first.chatTitle],
    ['Fix the flaky login test in the billing service', 'Fix the flaky login test in the billing service'],
  );
  m.name('Flaky login test');
  assert.equal(
    m.run('end_turn', null, undefined, { id: 'u2', content: [{ type: 'text', text: 'and more' }] }).title,
    'Flaky login test',
    'the Host’s name wins, and a later message never replaces it',
  );
});

test('a first message with no text (a picture, or content the Host did not send) names nothing, and the agent stays the title', () => {
  for (const user of [{ id: 'u', content: [{ type: 'image' }, null] }, { id: 'u' }]) {
    const a = chat('acp:host-codex').run('end_turn', null, undefined, user);
    assert.deepEqual([a.title, a.chatTitle], ['Codex', undefined]);
  }
});

/** What an app restart leaves a chat: its saved name only in the transcript, no event that tells it, the turn's user message first. */
const WORDS = 'Write exactly one sentence about a lighthouse';
const user = (text: string) => ({ id: 'u', content: [{ type: 'text', text }] });
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

test('after a restart a chat that has a name is titled by it, never by the latest message’s first words, even when the turn ends before the name is read (#5238)', async () => {
  let release!: (v: unknown) => void;
  const m = chat('acp:host-claude', undefined, 'c1', undefined, () => new Promise((r) => (release = r)));
  const key = 'acp:host-claude:c1';
  // the first event after the restart is the user's message; the turn fails within the same tick, before the saved name is read
  m.c.onAcpEvent({ key, kind: 'turnStart', turnId: 't0', user: user(WORDS) });
  m.c.onAcpEvent({ key, kind: 'turnEnd', turnId: 't0', stopReason: 'error', error: 'killed' });
  await flush();
  assert.equal(m.said().length, 0, 'the notification waits for the name rather than guess one');
  release({ t: 'title', name: 'Lighthouse keeper', auto: true });
  await flush();
  assert.deepEqual(
    m.said().map((x: any) => [x.title, x.chatTitle]),
    [['Lighthouse keeper', 'Lighthouse keeper']],
  );
});

test('the saved name is told as the chat’s own name, so it replaces the first words the turn’s user message set, in either order', async () => {
  const m = chat('acp:host-claude', undefined, 'c1', undefined, async () => ({ name: 'Lighthouse keeper' }));
  const key = 'acp:host-claude:c1';
  m.c.onAcpEvent({ key, kind: 'turnStart', turnId: 't0', user: user(WORDS) });
  await flush();
  m.c.onAcpEvent({ key, kind: 'turnEnd', turnId: 't0', stopReason: 'end_turn' });
  assert.equal(m.said().at(-1).title, 'Lighthouse keeper');
  // the Host's own name told by a frame after the user's message is the same
  const f = chat('acp:host-claude', undefined, 'c2');
  f.c.onAcpEvent({ key: 'acp:host-claude:c2', kind: 'turnStart', turnId: 't0', user: user(WORDS) });
  f.name('Saved name');
  f.c.onAcpEvent({ key: 'acp:host-claude:c2', kind: 'turnEnd', turnId: 't0', stopReason: 'end_turn' });
  assert.equal(f.said().at(-1).title, 'Saved name');
});

test('a chat nobody named, a saved name that cannot be read, and a name told meanwhile keep the right title', async () => {
  const none = chat('acp:host-claude', undefined, 'c1', undefined, async () => null);
  none.c.onAcpEvent({ key: 'acp:host-claude:c1', kind: 'turnStart', turnId: 't0', user: user(WORDS) });
  none.c.onAcpEvent({ key: 'acp:host-claude:c1', kind: 'turnEnd', turnId: 't0', stopReason: 'end_turn' });
  await flush();
  assert.equal(none.said().at(-1).title, 'Write exactly one sentence about a lighthouse', 'no name yet: the first words');
  const broken = chat('acp:host-claude', undefined, 'c1', undefined, async () => Promise.reject(new Error('unreadable')));
  broken.c.onAcpEvent({ key: 'acp:host-claude:c1', kind: 'turnStart', turnId: 't0', user: user(WORDS) });
  broken.c.onAcpEvent({ key: 'acp:host-claude:c1', kind: 'turnEnd', turnId: 't0', stopReason: 'end_turn' });
  await flush();
  assert.equal(broken.said().length, 1, 'the notification still comes');
  // a name an event told while the saved one was being read is newer
  let release!: (v: unknown) => void;
  const racing = chat('acp:host-claude', undefined, 'c1', undefined, () => new Promise((r) => (release = r)));
  racing.c.onAcpEvent({ key: 'acp:host-claude:c1', kind: 'turnStart', turnId: 't0', user: user(WORDS) });
  racing.name('Renamed meanwhile');
  await flush();
  release({ name: 'Old saved name' });
  await flush();
  racing.c.onAcpEvent({ key: 'acp:host-claude:c1', kind: 'turnEnd', turnId: 't0', stopReason: 'end_turn' });
  assert.equal(racing.said().at(-1).title, 'Renamed meanwhile');
});

test('a needs-you card that is the first event after a restart carries the saved name as its body', async () => {
  const m = chat('acp:host-claude', undefined, 'c1', undefined, async () => ({ name: 'Lighthouse keeper' }));
  m.c.onAcpEvent({ key: 'acp:host-claude:c1', kind: 'permission', requestId: 'r1', toolName: 'Bash', input: {}, options: [] });
  await flush();
  const card = m.said().find((x: any) => x.kind === 'approval');
  assert.equal(card?.body, 'Lighthouse keeper');
});
