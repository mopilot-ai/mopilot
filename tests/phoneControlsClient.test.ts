// The phone's client for a running chat's controls (model, effort, permission, agent, pin) and the scheduled list: what it reads, what it never offers, and what it says of a Mac that lacks a method.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/phone/register.ts';
const clientPath = '../mobile/src/remote/client.ts';
const controlsPath = '../mobile/src/remote/controls.ts';
const scheduledPath = '../mobile/src/remote/scheduled.ts';
const client = await import(clientPath);
const controls = await import(controlsPath);
const scheduled = await import(scheduledPath);

const SET = ['options.get', 'options.set', 'chat.switch', 'chats.pin', 'scheduled.list'];
const options = (over: Record<string, unknown> = {}) => ({
  models: [
    { id: 'm1', label: 'M1', efforts: [{ id: 'low', label: 'Low' }], defaultEffort: 'low' },
    { id: 'm2', label: 'M2', efforts: [{ id: 'high', label: 'High' }], defaultEffort: 'high' },
  ],
  model: 'm1',
  effort: 'low',
  harness: 'Claude Code',
  harnessId: 'claude',
  switching: false,
  permission: {
    value: 'default',
    rows: [
      { id: 'read-only', label: 'Read-only', detail: 'd' },
      { id: 'default', label: 'Ask', detail: 'd' },
      { id: 'auto-review', label: 'Auto', detail: 'd' },
      { id: 'full-access', label: 'Full access', detail: 'd' },
    ],
  },
  ...over,
});
/** A runtime answering for a Mac that offers `methods` (null: it does not say) with a permission ceiling. */
function mac(methods: string[] | null, answers: Record<string, unknown> = {}, ceiling = 'auto-review') {
  const calls: [string, any][] = [];
  const runtime: any = {
    snapshot: () => ({ selectedPair: 'p', generation: 1 }),
    request: async (method: string, params: any) => {
      calls.push([method, params]);
      if (method === 'machine.hello') {
        if (answers.hello instanceof Error) throw answers.hello;
        return { capabilities: { ...(methods ? { methods } : {}), permissionCeiling: ceiling, ...(answers.caps as object) } };
      }
      const given = answers[method];
      if (given instanceof Error) throw given;
      return given;
    },
  };
  return { request: client.ownedRequest(runtime), calls };
}
const HARNESSES = { harnesses: [{ id: 'claude', label: 'Claude Code' }, { id: 'codex', label: 'Codex' }, { id: '' }, { id: 'acp:x' }] };

test('a chat’s controls come from one options read and the agents list, with full access and anything above the ceiling left out', async () => {
  const { request, calls } = mac(SET, { 'options.get': options(), 'harnesses.list': HARNESSES }, 'default');
  const c = await controls.loadChatControls(request, 'claude:1');
  assert.deepEqual(
    calls.map((x) => x[0]),
    ['machine.hello', 'options.get', 'harnesses.list'],
  );
  assert.deepEqual(calls[1][1], { chatId: 'claude:1' });
  assert.deepEqual(
    c.options.permissions.map((p: any) => p.id),
    ['read-only', 'default'],
  );
  assert.equal(c.options.permission, 'default');
  assert.equal(c.options.model, 'm1');
  assert.deepEqual(c.harness, { id: 'claude', label: 'Claude Code' });
  assert.equal(c.switching, false);
  assert.deepEqual(c.harnesses, [
    { id: 'claude', label: 'Claude Code' },
    { id: 'codex', label: 'Codex' },
    { id: 'acp:x', label: 'acp:x' },
  ]);
  assert.deepEqual(c.methods, {
    pick: 'options.set',
    permit: 'options.set',
    agent: true,
    account: false,
    pin: true,
    rename: false,
    archive: false,
    sideChat: false,
  });
});

test('a permission only the Mac can set is named but not offered, and the agent label falls back to its id', async () => {
  const { request } = mac(
    SET,
    {
      'options.get': options({
        harness: undefined,
        switching: true,
        permission: { value: 'full-access', rows: options().permission.rows },
      }),
      'harnesses.list': HARNESSES,
    },
    'full-access',
  );
  const c = await controls.loadChatControls(request, 'claude:1');
  assert.equal(c.options.permission, null);
  assert.equal(c.options.permissionLabel, 'Full access');
  assert.ok(!c.options.permissions.some((p: any) => p.id === 'full-access'));
  assert.deepEqual(c.harness, { id: 'claude', label: 'claude' });
  assert.equal(c.switching, true);
  // a permission the Mac names by an id with no row is shown by that id
  const bare = mac(SET, { 'options.get': options({ permission: { value: 'plan', rows: [] } }), 'harnesses.list': HARNESSES });
  const b = await controls.loadChatControls(bare.request, 'claude:1');
  assert.equal(b.options.permissionLabel, 'plan');
  // a current row with no label is named by its id
  const unnamed = mac(SET, {
    'options.get': options({ permission: { value: 'default', rows: [{ id: 'default' }] } }),
    'harnesses.list': HARNESSES,
  });
  assert.equal((await controls.loadChatControls(unnamed.request, 'claude:1')).options.permissionLabel, 'default');
  const none = mac(SET, { 'options.get': options({ permission: null }), 'harnesses.list': HARNESSES });
  assert.equal((await controls.loadChatControls(none.request, 'claude:1')).options.permissionLabel, null);
});

test('a Mac without options.get is too old for the whole screen, and one that does not answer hello is tried', async () => {
  const old = mac(['chats.pin']);
  await assert.rejects(
    controls.loadChatControls(old.request, 'c'),
    (e: Error) => e instanceof client.Unavailable && /Update MoPilot/.test(e.message),
  );
  assert.ok(!old.calls.some((c) => c[0] === 'options.get'));
  const silent = mac(null, { hello: new Error('no hello'), 'options.get': options(), 'harnesses.list': HARNESSES });
  const c = await controls.loadChatControls(silent.request, 'c');
  assert.deepEqual(c.methods, {
    pick: 'options.set',
    permit: 'options.set',
    agent: true,
    account: true,
    pin: true,
    rename: false,
    archive: false,
    sideChat: false,
  });
  const unsaid = mac(null, { 'options.get': options(), 'harnesses.list': HARNESSES });
  assert.equal((await controls.loadChatControls(unsaid.request, 'c')).methods.agent, true);
});

test('each control falls back to its older method, and reports a missing one so the screen says to update', async () => {
  const older = mac(['options.get', 'card.choose', 'card.permit'], { 'options.get': options() });
  const c = await controls.loadChatControls(older.request, 'c');
  assert.deepEqual(c.methods, {
    pick: 'card.choose',
    permit: 'card.permit',
    agent: false,
    account: false,
    pin: false,
    rename: false,
    archive: false,
    sideChat: false,
  });
  // no agents are read from a Mac that cannot switch them
  assert.ok(!older.calls.some((x) => x[0] === 'harnesses.list'));
  assert.deepEqual(c.harnesses, []);
  const bare = mac(['options.get'], { 'options.get': options() });
  assert.deepEqual((await controls.loadChatControls(bare.request, 'c')).methods, {
    pick: null,
    permit: null,
    agent: false,
    account: false,
    pin: false,
    rename: false,
    archive: false,
    sideChat: false,
  });
  assert.match(controls.UPDATE.pick, /change the model/);
  assert.match(controls.UPDATE.permit, /change permissions/);
  assert.match(controls.UPDATE.agent, /switch agents/);
  assert.match(controls.UPDATE.pin, /pin chats/);
});

test('a reply without the chat’s agent keeps the other controls and leaves only the agent switch out, never guessing it', async () => {
  const { request, calls } = mac(SET, { 'options.get': options({ harnessId: undefined }), 'harnesses.list': HARNESSES });
  const c = await controls.loadChatControls(request, 'c');
  assert.equal(c.harness, null);
  assert.equal(c.methods.agent, false);
  assert.deepEqual(c.harnesses, [], 'the agents are not even asked for');
  assert.equal(
    calls.some(([m]) => m === 'harnesses.list'),
    false,
  );
  assert.equal(c.options.model, 'm1');
  const garbled = mac(SET, { 'options.get': 'nope' });
  await assert.rejects(controls.loadChatControls(garbled.request, 'c'), /Could not read the options/);
});

test('picks go to the Mac with the method it has, the chat and exactly what was picked', async () => {
  const { request, calls } = mac(SET, { 'chats.pin': { pinned: true }, 'chat.switch': { switched: true } });
  await controls.setModel(request, 'options.set', 'c1', 'm2', 'high');
  await controls.setModel(request, 'card.choose', 'c1', 'm2', null);
  await controls.setPermission(request, 'options.set', 'c1', 'default');
  await controls.setPermission(request, 'card.permit', 'c1', 'read-only');
  await controls.switchAgent(request, 'c1', 'codex');
  await controls.pinChat(request, 'c1', true);
  assert.deepEqual(calls, [
    ['options.set', { chatId: 'c1', model: 'm2', effort: 'high' }],
    ['card.choose', { chatId: 'c1', model: 'm2', effort: null }],
    ['options.set', { chatId: 'c1', value: 'default' }],
    ['card.permit', { chatId: 'c1', value: 'read-only' }],
    ['chat.switch', { chatId: 'c1', harness: 'codex' }],
    ['chats.pin', { chatId: 'c1', pinned: true }],
  ]);
});

test('a pin the Mac did not apply is an error, and a refusal reaches the caller', async () => {
  const { request } = mac(SET, { 'chats.pin': { pinned: false }, 'options.set': new Error('Full access can only be set on your Mac.') });
  await assert.rejects(controls.pinChat(request, 'c1', true), /Could not read the pin/);
  await assert.rejects(controls.setPermission(request, 'options.set', 'c1', 'full-access'), /Full access can only be set on your Mac/);
  const none = mac(SET, { 'chats.pin': undefined });
  await assert.rejects(controls.pinChat(none.request, 'c1', false), /Could not read the pin/);
});

test('the scheduled list keeps what the Mac sent, drops rows with no id and says to update a Mac without it', async () => {
  const rows = {
    tasks: [{ id: 'a', name: 'Nightly', next: 5000 }, { id: 'b', next: null }, { name: 'no id' }, { id: 'c', name: '', next: -1 }],
  };
  const { request, calls } = mac(SET, { 'scheduled.list': rows });
  assert.deepEqual(await scheduled.loadScheduled(request), {
    tasks: [
      { id: 'a', name: 'Nightly', next: 5000, hostId: null },
      { id: 'b', name: 'b', next: null, hostId: null },
      { id: 'c', name: 'c', next: null, hostId: null },
    ],
  });
  assert.deepEqual(
    calls.map((c) => c[0]),
    ['machine.hello', 'scheduled.list'],
  );
  const old = mac(['chats.pin']);
  const reply = await scheduled.loadScheduled(old.request);
  assert.match(reply.old, /Update MoPilot on your computer to see scheduled tasks/);
  assert.ok(!old.calls.some((c) => c[0] === 'scheduled.list'));
  const silent = mac(null, { hello: new Error('x'), 'scheduled.list': { tasks: [] } });
  assert.deepEqual(await scheduled.loadScheduled(silent.request), { tasks: [] });
  const bad = mac(SET, { 'scheduled.list': { tasks: 'x' } });
  await assert.rejects(scheduled.loadScheduled(bad.request), /Could not read the scheduled tasks/);
  const gone = mac(SET, { 'scheduled.list': null });
  await assert.rejects(scheduled.loadScheduled(gone.request), /Could not read the scheduled tasks/);
});

test('the next run reads as a countdown soon, a day and time later, and none as no upcoming run', () => {
  const now = Date.UTC(2026, 9, 29, 12, 0, 0);
  const min = 60_000;
  assert.equal(scheduled.nextRunLine(null, now), 'No upcoming run');
  assert.equal(scheduled.nextRunLine(now - 5 * min, now), 'Due now');
  assert.equal(scheduled.nextRunLine(now, now), 'Due now');
  assert.equal(scheduled.nextRunLine(now + 1, now), 'In 1 min');
  assert.equal(scheduled.nextRunLine(now + 59 * min, now), 'In 59 min');
  assert.equal(scheduled.nextRunLine(now + 60 * min, now), 'In 1 h');
  assert.equal(scheduled.nextRunLine(now + 185 * min, now), 'In 3 h 5 min');
  const later = now + 30 * 60 * min;
  const at = new Date(later);
  assert.equal(
    scheduled.nextRunLine(later, now),
    `${at.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}, ${at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`,
  );
});

test('rename keeps the title the Mac returns, archive asks to archive, and a reply without them is refused', async () => {
  const ok = mac(SET, { 'chats.rename': { title: 'Fix the login' }, 'chats.archive': { archived: true } });
  assert.equal(await controls.renameChat(ok.request, 'c', ' Fix  the login '), 'Fix the login');
  await controls.archiveChat(ok.request, 'c');
  assert.deepEqual(ok.calls, [
    ['chats.rename', { chatId: 'c', title: ' Fix  the login ' }],
    ['chats.archive', { chatId: 'c', archived: true }],
  ]);
  const odd = mac(SET, { 'chats.rename': {}, 'chats.archive': { archived: false } });
  await assert.rejects(controls.renameChat(odd.request, 'c', 'x'), /Could not read the new title/);
  await assert.rejects(controls.archiveChat(odd.request, 'c'), /Could not read the archive/);
  // the Mac says it renames and archives in its hello
  const flags = mac(SET, { 'options.get': options(), 'harnesses.list': HARNESSES });
  const rich = await controls.loadChatControls(
    {
      ...flags,
      request: client.ownedRequest({
        snapshot: () => ({ selectedPair: 'p', generation: 1 }),
        request: async (m: string) =>
          m === 'machine.hello'
            ? { capabilities: { methods: SET, renameChats: true, archiveChats: true } }
            : m === 'options.get'
              ? options()
              : HARNESSES,
      } as any),
    }.request,
    'c',
  );
  assert.equal(rich.methods.rename, true);
  assert.equal(rich.methods.archive, true);
});

test('switching agent sends the login only when one was named, null meaning the agent’s own choice', async () => {
  const m = mac(['chat.switch'], { 'chat.switch': { switched: true } });
  await controls.switchAgent(m.request, 'c', 'codex');
  await controls.switchAgent(m.request, 'c', 'codex', 'a');
  await controls.switchAgent(m.request, 'c', 'codex', null);
  assert.deepEqual(
    m.calls.filter((c: any) => c[0] === 'chat.switch').map((c: any) => c[1]),
    [
      { chatId: 'c', harness: 'codex' },
      { chatId: 'c', harness: 'codex', account: 'a' },
      { chatId: 'c', harness: 'codex', account: null },
    ],
  );
});

test('a chat’s controls say whether the Mac starts side chats: only when it says so, never from an older Mac that says nothing', async () => {
  const read = async (caps?: object) => {
    const { request } = mac(SET, { 'options.get': options(), 'harnesses.list': HARNESSES, caps });
    return (await controls.loadChatControls(request, 'claude:1')).methods.sideChat;
  };
  assert.equal(await read({ sideChats: true }), true);
  assert.equal(await read({ sideChats: false }), false);
  assert.equal(await read(), false);
});
