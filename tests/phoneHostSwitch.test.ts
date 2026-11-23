// Moving a machine chat to another agent and setting its permission from the phone (#4859 step 2): the Host's own chat.switch and chat.permit through the phone's session, the machine's agents as the controls the phone's sheets read, and the divider a settled switch leaves in the chat.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPhoneChats } from '../shared/remote/phoneChats.mjs';
import { createFold } from '../shared/host/fold.mjs';
import { createThreadRows } from '../shared/host/threadRows.mjs';
import { PHONE_FEATURES } from '../shared/remote/phoneHost.mjs';
import { hostChatId } from '../shared/host/chatIds.mjs';
import { hostControls, wireOf } from '../mobile/src/remote/hostControls.ts';
import { rig } from './support/phone/host-chat-rig.ts';
import './support/phone/register.ts';

// the phone's own client reads Expo: loaded after the registration that stands it in
const controlsPath = '../mobile/src/remote/controls.ts';
const clientPath = '../mobile/src/remote/client.ts';
const { loadChatControls } = await import(controlsPath);
const { ownedRequest } = await import(clientPath);

const AGENTS = [
  { id: 'claude', label: 'Claude Code', state: 'ready', via: 'own' },
  { id: 'codex', label: 'Codex', state: 'ready', via: 'own' },
  { id: 'kimi', label: 'Kimi Code', state: 'signin', via: null, reason: 'Sign in on Studio: login' },
  { id: 'gemini', label: 'Gemini', state: 'ready', via: 'own' },
];

test('the phone declares the switch feature, so a Host that can settle a switch is not refused it', () => {
  assert.ok(PHONE_FEATURES.includes('switch'));
});

test('the machine’s agents are the chat’s controls: built-in agents by their id, the others as ACP agents, a held move and the permission modes of Claude Code and Codex only', () => {
  assert.equal(wireOf('claude'), 'claude');
  assert.equal(wireOf('kimi'), 'acp:kimi');
  const claude = hostControls({
    machineName: 'Studio',
    agents: AGENTS as never,
    current: 'claude',
    pending: undefined,
    permission: undefined,
  });
  assert.deepEqual([claude.harnessId, claude.harness, claude.current, claude.switching], ['claude', 'Claude Code', 'claude', false]);
  assert.deepEqual(
    claude.machine.agents.map((a) => [a.id, a.state, a.reason]),
    [
      ['claude', 'ready', ''],
      ['codex', 'ready', ''],
      ['acp:kimi', 'signin', 'Sign in on Studio: login'],
      ['acp:gemini', 'ready', ''],
    ],
  );
  assert.deepEqual(
    claude.permission.rows.map((r) => r.id),
    ['read-only', 'default', 'auto-review'],
  );
  // `read-only` is a sandbox and approval mode, not Plan: Codex asks no question cards in it, so the row must not be called Plan
  assert.deepEqual(
    claude.permission.rows.map((r) => [r.id, r.label]),
    [
      ['read-only', 'Read-only'],
      ['default', 'Manual'],
      ['auto-review', 'Auto'],
    ],
  );
  assert.equal(claude.permission.value, null);
  // a move held for the next message: the agent shown is the one it goes to, the one running stays named
  const held = hostControls({ machineName: 'Studio', agents: AGENTS as never, current: 'claude', pending: 'codex', permission: 'default' });
  assert.deepEqual(
    [held.harnessId, held.harness, held.current, held.switching, held.permission.value],
    ['codex', 'Codex', 'claude', true, 'default'],
  );
  // an ACP agent's modes are its own: none offered; no agents known yet
  const acp = hostControls({ machineName: 'Studio', agents: null, current: 'acp:kimi', pending: undefined, permission: undefined });
  assert.deepEqual([acp.machine.agents, acp.permission.rows, acp.harness], [[], [], 'acp:kimi']);
  assert.deepEqual(
    hostControls({ machineName: 'Studio', agents: null, current: undefined, pending: undefined, permission: undefined }).machine.agents,
    [],
  );
});

test('a phone-started chat reads its controls from the Host: the agent sheet lists the machine’s agents, a switch is held by the Host and shown, taking it back clears it, and permission is set on the Host', async () => {
  const r = rig({ agents: AGENTS });
  const begun = r.kit.begin('claude');
  await r.kit.start('m1', begun, { text: 'hello' });
  r.startedOn('claude');
  const chatId = begun.chatId;
  const loaded = await loadChatControls(ownedRequest(r.runtime), chatId);
  assert.deepEqual(
    [loaded.harness, loaded.machine?.name, loaded.machine?.current, loaded.methods.agent],
    [{ id: 'claude', label: 'Claude Code' }, 'Studio', 'claude', true],
  );
  assert.deepEqual(
    loaded.harnesses.map((h) => [h.id, !!h.unavailable]),
    [
      ['claude', false],
      ['codex', false],
      ['acp:kimi', true],
      ['acp:gemini', false],
    ],
  );
  assert.equal(loaded.harnesses[2].detail, 'Sign in on Studio: login');
  // Claude Code to Codex: the Host is asked once, under a key per tap, and holds the move
  assert.deepEqual(await r.runtime.request('chat.switch', { chatId, harness: 'codex' }), { pending: { harness: 'codex' } });
  assert.equal(r.moves.length, 1);
  assert.deepEqual([r.moves[0].harness, typeof r.moves[0].key, r.moves[0].chatId], ['codex', 'string', hostChatId(chatId)]);
  const held = await loadChatControls(ownedRequest(r.runtime), chatId);
  assert.deepEqual([held.harness?.id, held.switching, held.machine?.current], ['codex', true, 'claude']);
  // back to the agent it runs on: the choice is taken back
  assert.deepEqual(await r.runtime.request('chat.switch', { chatId, harness: 'claude' }), { pending: null });
  assert.equal((await loadChatControls(ownedRequest(r.runtime), chatId)).switching, false);
  assert.notEqual(r.moves[0].key, r.moves[1].key, 'two taps are two requests');
  // permission through the Host
  await r.runtime.request('options.set', { chatId, value: 'auto-review' });
  assert.deepEqual([r.permits[0].value, typeof r.permits[0].key], ['auto-review', 'string']);
  assert.equal((await loadChatControls(ownedRequest(r.runtime), chatId)).options.permission, 'auto-review');
  // the model is not the Host's to set from the phone yet
  await assert.rejects(
    r.runtime.request('options.set', { chatId, model: 'x' }),
    (e: any) => e.code === 'unsupported' && /Studio/.test(e.message),
  );
});

test('a refusal the Host gives for a switch reaches the person in its own words', async () => {
  const r = rig({
    agents: AGENTS,
    switchError: () => Object.assign(new Error('Sign in to Kimi Code on this machine first.'), { code: 'agent_signed_out' }),
  });
  const begun = r.kit.begin('claude');
  await r.kit.start('m1', begun, { text: 'hello' });
  await assert.rejects(r.runtime.request('chat.switch', { chatId: begun.chatId, harness: 'acp:kimi' }), /Sign in to Kimi Code/);
});

function chatsRig() {
  const calls: any[] = [];
  const session: any = {
    switchTo: async (p: any) => (calls.push(['switch', p]), { pending: { harness: p.harness } }),
    permit: async (p: any) => (calls.push(['permit', p]), { permission: p.value }),
  };
  const chats = createPhoneChats({ host: async () => session, hostKeyOf: () => 'a'.repeat(64), emit: () => undefined });
  return { chats, calls };
}

test('a switch or a permission goes to the Host under a key that is the same for one tap and different for the next', async () => {
  const { chats, calls } = chatsRig();
  await chats.switchTo('m1', 'c1', 'tap1', { harness: 'codex', model: 'm' });
  await chats.switchTo('m1', 'c1', 'tap1', { harness: 'codex', model: 'm' });
  await chats.switchTo('m1', 'c1', 'tap2', { harness: 'codex' });
  await chats.permit('m1', 'c1', 'tap3', 'default');
  assert.equal(calls[0][1].key, calls[1][1].key);
  assert.notEqual(calls[1][1].key, calls[2][1].key);
  assert.deepEqual([calls[0][1].harness, calls[0][1].model, calls[3][0], calls[3][1].value], ['codex', 'm', 'permit', 'default']);
});

test('a settled switch the Host journals is the divider of its turn: a note row first in it, nothing for a malformed item', () => {
  const fold = createFold({ hostId: 'h' });
  const rows = createThreadRows();
  const turn = (id: string, text: string) => ({
    t: 'event',
    family: 'acp',
    event: { kind: 'turnStart', turnId: id, user: { id: `u-${id}`, content: [{ type: 'text', text }] } },
  });
  const done = (id: string) => ({ t: 'event', family: 'acp', event: { kind: 'turnEnd', turnId: id, stopReason: 'end_turn' } });
  const push = (item: object) => fold.push(item).records.flatMap((rec: any) => rows.push(rec));
  push(turn('t1', 'hi'));
  push(done('t1'));
  push(turn('t2', 'now on codex'));
  push({ t: 'switch', from: 'claude', to: 'codex', text: 'Moved from Claude Code to Codex. It continues from here.', at: 5, turnId: 't2' });
  push(done('t2'));
  const all = rows.rows();
  assert.deepEqual(
    all.map((r: any) => [r.role, r.text]),
    [
      ['user', 'hi'],
      ['note', 'Moved from Claude Code to Codex. It continues from here.'],
      ['user', 'now on codex'],
    ],
  );
  assert.equal(all[1].id, 'n-t2');
  assert.deepEqual(fold.push({ t: 'switch', turnId: 't2', text: '' }), { events: [], records: [], refused: null });
  assert.deepEqual(fold.push({ t: 'switch', text: 'x' }).records, []);
  // a note longer than the divider allows is cut
  assert.equal(fold.push({ t: 'switch', turnId: 't3', text: 'x'.repeat(500) }).records[0].text.length, 300);
});

test('a switch the Host has settled is the agent the chat runs on: the pill and the Agent sheet move to it and the held choice is gone (#4859)', async () => {
  const r = rig({ agents: AGENTS });
  const begun = r.kit.begin('claude');
  await r.kit.start('m1', begun, { text: 'hello' });
  r.startedOn('claude');
  const chatId = begun.chatId;
  await r.runtime.request('chat.follow', { chatId });
  await r.runtime.request('chat.switch', { chatId, harness: 'codex' });
  const held = await loadChatControls(ownedRequest(r.runtime), chatId);
  assert.deepEqual([held.harness?.id, held.switching, held.machine?.current], ['codex', true, 'claude']);
  // the next message settles it: the Host's journal says so, and the chat runs on Codex
  r.kit.chats.onEvent('m1', {
    event: 'frame',
    chatId,
    frame: {
      t: 'durable',
      seq: 1,
      rev: 1,
      item: { t: 'switch', from: 'claude', to: 'codex', text: 'Claude Code → Codex ›', at: 1, turnId: 't2' },
    },
  });
  const settled = await loadChatControls(ownedRequest(r.runtime), chatId);
  assert.deepEqual([settled.harness?.id, settled.switching, settled.machine?.current], ['codex', false, 'codex']);
  // the other way, again: a new move is held against the agent it now runs on
  r.startedOn('codex'); // the Host's own view: it runs on Codex now
  await r.runtime.request('chat.switch', { chatId, harness: 'claude' });
  const back = await loadChatControls(ownedRequest(r.runtime), chatId);
  assert.deepEqual([back.harness?.id, back.switching, back.machine?.current], ['claude', true, 'codex']);
  assert.equal(r.kit.chats.agentOf('nobody'), undefined);
});
