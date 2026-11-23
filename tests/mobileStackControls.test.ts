// Mobile Remote end to end, running-chat controls: the phone's client changes a chat's model, effort, permission and agent, pins it and reads the scheduled tasks through the real relay and Mac service; full access never gets through.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRelay, startMac, startPhone, until, client, type Relay } from './support/mobileStack.ts';

const controlsPath = '../mobile/src/remote/controls.ts';
const scheduledPath = '../mobile/src/remote/scheduled.ts';
const controls = await import(controlsPath);
const scheduled = await import(scheduledPath);

const ROWS = [
  { id: 'read-only', label: 'Read-only', detail: 'd' },
  { id: 'default', label: 'Ask', detail: 'd' },
  { id: 'auto-review', label: 'Approve for me', detail: 'd' },
  { id: 'full-access', label: 'Full access', detail: 'd' },
];
const MODELS = [
  {
    id: 'gpt-a',
    label: 'GPT A',
    efforts: [
      { id: 'low', label: 'Low' },
      { id: 'high', label: 'High' },
    ],
    defaultEffort: 'low',
  },
  { id: 'gpt-b', label: 'GPT B', efforts: [{ id: 'medium', label: 'Medium' }], defaultEffort: 'medium' },
];

/** A Mac whose chat `c1` has a model, an effort, a permission and an agent that the phone's picks change. */
function chatOps() {
  const st = { model: 'gpt-a', effort: 'low', permission: 'default', harness: 'codex', pinned: false };
  const log: [string, any][] = [];
  return {
    st,
    log,
    ops: {
      options: async (p: any) => {
        log.push(['options', p]);
        return {
          models: MODELS,
          model: st.model,
          effort: st.effort,
          harness: st.harness === 'codex' ? 'Codex' : 'Claude Code',
          harnessId: st.harness,
          switching: false,
          permission: { value: st.permission, rows: ROWS },
        };
      },
      choose: async (p: any) => void (log.push(['choose', p]), Object.assign(st, { model: p.model, effort: p.effort })),
      permit: async (p: any) => void (log.push(['permit', p]), (st.permission = p.value)),
      switchHarness: async (p: any) => void (log.push(['switch', p]), (st.harness = p.harness)),
      // the Mac pins only the chat it has
      pin: (chatId: string, pinned: boolean) => (log.push(['pin', { chatId, pinned }]), chatId === 'c1' && ((st.pinned = pinned), true)),
      harnesses: async () => [
        { id: 'codex', label: 'Codex' },
        { id: 'claude', label: 'Claude Code' },
      ],
      scheduled: async () => [
        { id: 't1', name: 'Nightly', next: 4_000_000_000_000 },
        { id: 't2', name: 'Weekly', next: null },
      ],
    },
  };
}

async function online(relay: Relay, o: Parameters<typeof startMac>[1] = {}) {
  const mac = await startMac(relay, o);
  const phone = await startPhone(relay);
  await phone.pair(await mac.qr());
  await until(() => phone.snap().pairs.length === 1 && phone.snap().safetyNumber === null, 'the pair to commit');
  await phone.runtime.connect(phone.snap().pairs[0].pairId);
  return { mac, phone, request: client.ownedRequest(phone.runtime) };
}

test('the phone reads a chat’s settings and changes the model, effort, permission and agent on the Mac', async () => {
  const chat = chatOps();
  const { request } = await online(await startRelay(), { ops: chat.ops });
  const read = await controls.loadChatControls(request, 'c1');
  assert.deepEqual(chat.log.at(-1), ['options', { chatId: 'c1' }]);
  assert.equal(read.options.model, 'gpt-a');
  assert.deepEqual(
    read.harnesses.map((h: any) => h.id),
    ['codex', 'claude'],
  );
  // the Mac's own ceiling is what the real hello carries; full access is not in the phone's list
  assert.deepEqual(
    read.options.permissions.map((p: any) => p.id),
    ['read-only', 'default', 'auto-review'],
  );
  // renaming and archiving follow what this Mac declares in its hello (the flags arrive with the Mac's own change)
  const { rename, archive, sideChat, ...settable } = read.methods;
  assert.deepEqual(settable, { pick: 'options.set', permit: 'options.set', agent: true, account: true, pin: true });
  assert.equal(typeof rename, 'boolean');
  assert.equal(typeof sideChat, 'boolean', 'Start a side chat is offered only where the Mac says it has it');
  assert.equal(typeof archive, 'boolean');

  await controls.setModel(request, read.methods.pick, 'c1', 'gpt-b', 'medium');
  assert.deepEqual(chat.log.at(-1), ['choose', { chatId: 'c1', model: 'gpt-b', effort: 'medium' }]);
  await controls.setPermission(request, read.methods.permit, 'c1', 'auto-review');
  assert.deepEqual(chat.log.at(-1), ['permit', { chatId: 'c1', value: 'auto-review' }]);
  await controls.switchAgent(request, 'c1', 'claude');
  assert.deepEqual(chat.log.at(-1), ['switch', { chatId: 'c1', harness: 'claude' }]);

  const after = await controls.loadChatControls(request, 'c1');
  assert.equal(after.options.model, 'gpt-b');
  assert.equal(after.options.effort, 'medium');
  assert.equal(after.options.permission, 'auto-review');
  assert.equal(after.harness.id, 'claude');
});

test('a phone can never set full access or a permission above the Mac’s ceiling, whatever it sends', async () => {
  const chat = chatOps();
  const { request, phone } = await online(await startRelay(), { ops: chat.ops });
  await assert.rejects(controls.setPermission(request, 'options.set', 'c1', 'full-access'), /Full access can only be set on your Mac/);
  await assert.rejects(
    controls.setPermission(request, 'card.permit', 'c1', 'bypassPermissions'),
    /Full access can only be set on your Mac/,
  );
  await assert.rejects(phone.ask('options.set', { chatId: 'c1', value: 'full-access' }), /Full access/);
  assert.equal(chat.st.permission, 'default');
  assert.ok(!chat.log.some((e) => e[0] === 'permit'));
});

test('pinning and unpinning reach the Mac, and a chat the Mac does not have is refused', async () => {
  const chat = chatOps();
  const { request } = await online(await startRelay(), { ops: chat.ops });
  await controls.pinChat(request, 'c1', true);
  assert.equal(chat.st.pinned, true);
  await controls.pinChat(request, 'c1', false);
  assert.equal(chat.st.pinned, false);
  await assert.rejects(controls.pinChat(request, 'gone', true), /isn't in MoPilot/);
});

test('the scheduled list comes back soonest first as the Mac sent it, read only', async () => {
  const chat = chatOps();
  const { request, phone } = await online(await startRelay(), { ops: chat.ops });
  const list = await scheduled.loadScheduled(request);
  assert.deepEqual(list.tasks, [
    { id: 't1', name: 'Nightly', next: 4_000_000_000_000, hostId: null },
    { id: 't2', name: 'Weekly', next: null, hostId: null },
  ]);
  // the phone has no method to change a schedule
  const hello = await phone.ask('machine.hello');
  assert.deepEqual(
    hello.capabilities.methods.filter((m: string) => m.startsWith('scheduled.')),
    ['scheduled.list'],
  );
});
