// A machine chat moves to another agent (D13, #4278, S2): the choice is held on the chat, settles with its next message on the Host's own families, and the chat keeps its id, journal and folder. A: both directions of Claude, Codex and ACP pairs with the handoff the new agent is sent; W: held while a turn runs, the state lane; B: a start or a family that cannot be reached.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { type Agent, AGENTS, base, openAll, until } from './support/host/switchKit.ts';

const pairs: [Agent, Agent][] = [
  ['claude', 'codex'],
  ['codex', 'claude'],
  ['claude', 'acp'],
  ['acp', 'claude'],
  ['codex', 'acp'],
  ['acp', 'codex'],
];

for (const [from, to] of pairs) {
  test(`A: a ${from} chat moves to ${to} with its next message: same chat, handoff record sent, the lane names the new agent`, async () => {
    const dir = fs.mkdtempSync(path.join(base, 'a-'));
    const cwd = fs.realpathSync(fs.mkdtempSync(path.join(base, 'cwd-')));
    const h = await openAll(dir);
    try {
      const chatId = AGENTS[from].id();
      await h.call('chat.subscribe', chatId);
      await h.call('chat.start', chatId, { harness: AGENTS[from].harness, text: 'FIRSTWORDS about the plan', cwd });
      await h.idle(chatId, 1);
      assert.equal(h.sessions.controller.ref(chatId).kind, AGENTS[from].harness);

      // the choice is held: it reads on the lane and nothing has moved yet
      const held: any = await h.call('chat.switch', chatId, { harness: AGENTS[to].harness });
      assert.deepEqual(held.result, { pending: { harness: AGENTS[to].harness } });
      assert.equal(h.sessions.controller.ref(chatId).kind, AGENTS[from].harness);
      assert.deepEqual(h.lane(chatId).at(-1), { pendingSwitch: { harness: AGENTS[to].harness } });

      await h.call('chat.send', chatId, { text: 'SECONDWORDS please continue' });
      await h.idle(chatId, 2);

      // the chat is the same chat, now on the new agent, with both agents' sessions in its record
      assert.equal(h.sessions.controller.ref(chatId).kind, AGENTS[to].harness);
      const segments = h.sessions.chats.record(chatId).segments;
      assert.deepEqual(
        segments.map((s: any) => s.kind),
        [AGENTS[from].harness, AGENTS[to].harness],
      );
      // the new agent was sent the handoff record and the message, in its first turn
      const sent = h.prompts[to]().at(-1) as string;
      assert.match(sent, /FIRSTWORDS about the plan/);
      assert.match(sent, /SECONDWORDS please continue/);
      assert.match(segments[1].handoff.text, /FIRSTWORDS/);
      // the lane says where the chat is now and that no choice is held
      assert.deepEqual(h.lane(chatId).at(-1), { harness: AGENTS[to].harness, pendingSwitch: null });
      // a client that subscribes afterwards is told the same in its Hello
      const seen = await h.hello(chatId);
      assert.equal(seen.find((m: any) => m.frame?.t === 'hello')?.frame.chatState.harness, AGENTS[to].harness);
      assert.equal(seen.find((m: any) => m.frame?.t === 'hello')?.frame.chatState.pendingSwitch, null);
    } finally {
      await h.close();
    }
  });
}

test('W: a choice made while a turn runs is held and settles with the next message, once the turn is over', async () => {
  const dir = fs.mkdtempSync(path.join(base, 'w-'));
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(base, 'cwd-')));
  const h = await openAll(dir);
  try {
    const chatId = AGENTS.codex.id();
    await h.call('chat.subscribe', chatId);
    await h.call('chat.start', chatId, { harness: 'codex', text: 'slow please', cwd });
    await until(() => h.sessions.state.snapshot(chatId).turn === 'running');
    // the turn is still running: the choice is held, the turn goes on as it was
    await h.call('chat.switch', chatId, { harness: 'claude' });
    assert.equal(h.sessions.controller.ref(chatId).kind, 'codex');
    assert.equal(h.sessions.state.snapshot(chatId).pendingSwitch.harness, 'claude');
    await h.call('chat.stop', chatId);
    await until(() => h.sessions.state.snapshot(chatId).turn === 'idle');
    // a second choice replaces the first, and choosing the chat's own agent drops it
    await h.call('chat.switch', chatId, { harness: 'acp:fake' });
    assert.equal(h.sessions.state.snapshot(chatId).pendingSwitch.harness, 'acp:fake');
    await h.call('chat.switch', chatId, { harness: 'codex' });
    assert.equal(h.sessions.state.snapshot(chatId).pendingSwitch, null);
    assert.deepEqual(h.lane(chatId).at(-1), { pendingSwitch: null });
    // a message with no choice held stays on the agent the chat runs on
    await h.call('chat.send', chatId, { text: 'still here' });
    await until(() => h.prompts.codex().some((t) => t.includes('still here')));
    assert.equal(h.sessions.controller.ref(chatId).kind, 'codex');
  } finally {
    await h.close();
  }
});
