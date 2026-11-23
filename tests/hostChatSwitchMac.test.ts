// The Mac follows a machine chat's switch from the Host's state lane (electron/host/remoteChatState.cjs, wiring.cjs `laneOf`): the agent the chat runs on after a switch settled is kept with the chat (A), a held choice reaches the session store the chip is drawn from only when it differs from what is there, and a choice that is gone clears the chip (W), and a Host that says nothing changes nothing (B).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { CHAT, FakeItems, createRemoteChats, fakeHost, tick } from './support/host/remoteChatsKit.ts';

const require = createRequire(import.meta.url);
const { laneOf } = require('../electron/host/wiring.cjs');

function mirror(held: any = null, withAgent = true) {
  const patched: any[] = [];
  const agents: any[] = [];
  const host = fakeHost();
  const chats = createRemoteChats({
    items: new FakeItems(),
    hostFor: () => host,
    ownerOf: () => ({ hostId: 'm1', folder: '/srv/work' }),
    emit: () => undefined,
    state: () => ({ get: () => ({ pendingSwitch: held }), patch: (id: string, p: object) => patched.push([id, p]) }),
    ...(withAgent ? { agent: (id: string, harness: string) => agents.push([id, harness]) } : {}),
    now: () => 1000,
    report: () => undefined,
  });
  host.reply = { snapshot: { rev: 0, items: [] }, patches: null, generation: 'g1', inflight: [] };
  chats.follow(CHAT);
  const tell = async (patch: object) => {
    host.fire.frame(CHAT, { t: 'state', patch });
    await tick();
    await chats.settled(CHAT);
  };
  return { chats, tell, patched, agents, setHeld: (h: any) => (held = h) };
}

test('A: the agent a settled switch moved the chat to is kept with the chat, and a state that names none keeps nothing', async () => {
  const m = mirror();
  await m.chats.settled(CHAT);
  await m.tell({ harness: 'codex', pendingSwitch: null });
  assert.deepEqual(m.agents, [[CHAT, 'codex']]);
  await m.tell({ goal: null });
  assert.equal(m.agents.length, 1);
});

test('A: a Mac with nowhere to keep the agent still follows a lane that names one', async () => {
  const m = mirror(null, false);
  await m.chats.settled(CHAT);
  await m.tell({ harness: 'codex', pendingSwitch: null });
  assert.deepEqual(m.agents, []);
});

test('W: a held choice made elsewhere shows on the chip, a choice made here is not written over, and one the Host no longer holds clears it', async () => {
  const m = mirror();
  await m.chats.settled(CHAT);
  // the phone's choice: no model label, so the chip names the agent only
  await m.tell({ pendingSwitch: { harness: 'acp:kimi', model: 'k2' } });
  assert.deepEqual(m.patched.at(-1), [CHAT, { pendingSwitch: { harness: 'acp:kimi', model: 'k2', modelLabel: '', mode: 'auto' } }]);
  await m.tell({ pendingSwitch: { harness: 'codex' } });
  assert.deepEqual(m.patched.at(-1), [CHAT, { pendingSwitch: { harness: 'codex', model: null, modelLabel: '', mode: 'auto' } }]);
  // this window made it: the chip keeps its model label
  m.setHeld({ harness: 'codex', model: 'gpt', modelLabel: 'GPT', mode: 'auto' });
  const before = m.patched.length;
  await m.tell({ pendingSwitch: { harness: 'codex', model: 'gpt' } });
  await m.tell({ pendingSwitch: { harness: 'codex' } });
  assert.equal(m.patched.length, before, 'the same choice is not written again');
  await m.tell({ pendingSwitch: { harness: 'codex', model: 'other' } });
  assert.equal(m.patched.length, before + 1, 'another model of the same agent is a different choice');
  // the Host holds none (a restart, or the switch settled): the chip goes
  await m.tell({ pendingSwitch: null });
  assert.deepEqual(m.patched.at(-1), [CHAT, { pendingSwitch: null }]);
  m.setHeld(null);
  const kept = m.patched.length;
  await m.tell({ pendingSwitch: null });
  assert.equal(m.patched.length, kept, 'nothing to clear');
});

test('B: the lane’s agent is written into the chat’s own config and every window is told; a chat main cannot change tells no one', () => {
  const told: any[] = [];
  const record = { meta: { config: { model: 'm', hostSelection: { hostId: 'box' } } } };
  const written: any[] = [];
  const chats = {
    record: () => record,
    patchMeta: (id: string, patch: any) => (written.push([id, patch]), id !== 'gone'),
    get: (id: string) => ({ id }),
  };
  const lane = laneOf({ handle: () => undefined }, () => true, { live: { chats }, broadcastAll: (...a: any[]) => told.push(a) });
  lane.agent('c1', 'acp:kimi');
  assert.deepEqual(written, [['c1', { config: { model: 'm', hostSelection: { hostId: 'box' }, hostAgent: 'acp:kimi' } }]]);
  assert.deepEqual(told, [['chats:changed', { id: 'c1', chat: { id: 'c1' } }]]);
  lane.agent('gone', 'codex');
  assert.equal(told.length, 1);
  // sessions not up yet: nothing to keep it in
  const early = laneOf({ handle: () => undefined }, () => true, { live: {}, broadcastAll: () => undefined });
  assert.doesNotThrow(() => early.agent('c1', 'codex'));
  assert.equal(typeof lane.attention, 'function');
});

test('B: the picks a message carries follow the agent the Host said after a switch, else this Mac’s own reading of the chat', () => {
  const { kindOfChat } = require('../electron/host/wiring.cjs');
  const live = {
    chats: { get: (id: string) => (id === 'moved' ? { meta: { config: { hostAgent: 'codex' } } } : id === 'plain' ? { meta: {} } : null) },
    controller: { ref: () => ({ kind: 'acp:host-claude' }) },
  };
  assert.equal(kindOfChat(live, 'moved'), 'codex');
  assert.equal(kindOfChat(live, 'plain'), 'claude');
  assert.equal(kindOfChat(live, 'unknown'), 'claude');
  assert.equal(kindOfChat({}, 'x'), undefined);
  assert.equal(kindOfChat(undefined, 'x'), undefined);
});
