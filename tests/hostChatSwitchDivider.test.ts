// A settled switch of a machine chat is a typed item of the Host's journal (#4775, D13): `{ t: 'switch', from, to, text, at, turnId }`, written once when the switch settles and naming the turn that settled it, replayed to a client that subscribes later or again, and never written for a choice the person took back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { type Agent, AGENTS, base, openAll } from './support/host/switchKit.ts';

const pairs: [Agent, Agent][] = [
  ['claude', 'codex'],
  ['codex', 'claude'],
  ['claude', 'acp'],
  ['acp', 'claude'],
  ['codex', 'acp'],
  ['acp', 'codex'],
];
/** The durable items of a chat the first client was told, in order. */
const items = (h: any, chatId: string) =>
  h.frames.filter((m: any) => m.chatId === chatId && m.frame?.t === 'durable').map((m: any) => m.frame.item);
const switches = (list: any[]) => list.filter((i) => i.t === 'switch');
/** The items a client that subscribes now is handed in its Hello. */
const snapshotOf = (seen: any[]) => seen.find((m: any) => m.frame?.t === 'hello')?.frame.snapshot?.items ?? [];

for (const [from, to] of pairs) {
  test(`A: a ${from} chat that moved to ${to} journals one switch item naming the turn that moved it`, async () => {
    const dir = fs.mkdtempSync(path.join(base, 'd-'));
    const cwd = fs.realpathSync(fs.mkdtempSync(path.join(base, 'cwd-')));
    const h = await openAll(dir);
    try {
      const chatId = AGENTS[from].id();
      await h.call('chat.subscribe', chatId);
      await h.call('chat.start', chatId, { harness: AGENTS[from].harness, text: 'FIRSTWORDS about the plan', cwd });
      await h.idle(chatId, 1);
      assert.equal(switches(items(h, chatId)).length, 0, 'a chat that never moved has none');
      await h.call('chat.switch', chatId, { harness: AGENTS[to].harness });
      assert.equal(switches(items(h, chatId)).length, 0, 'a held choice is not a switch yet');
      const key = `key-resend-${from}-${to}`;
      await h.conn.call('chat.send', { chatId, epoch: 1, key, text: 'SECONDWORDS please continue' });
      await h.idle(chatId, 2);
      // a resend of the same message under its key settles nothing again
      await h.conn.call('chat.send', { chatId, epoch: 1, key, text: 'SECONDWORDS please continue' });
      const all = items(h, chatId);
      const moved = switches(all);
      assert.equal(moved.length, 1);
      assert.deepEqual([moved[0].from, moved[0].to], [AGENTS[from].harness, AGENTS[to].harness]);
      assert.equal(typeof moved[0].text, 'string');
      assert.ok(moved[0].text.length > 0 && moved[0].text.length <= 300);
      assert.equal(typeof moved[0].at, 'number');
      // it names the turn that settled it: the second turn of the chat, wherever the agent's own events put its start (a Claude Code turn opens before its switch settles, the others after)
      const turnStarts = all.filter((i: any) => i.t === 'event' && i.event?.kind === 'turnStart').map((i: any) => i.event.turnId);
      assert.equal(turnStarts.length, 2);
      assert.equal(moved[0].turnId, turnStarts[1]);
      // a client that subscribes afterwards is told it too, once
      const late = await h.hello(chatId);
      assert.equal(switches(snapshotOf(late)).length, 1);
      assert.deepEqual(switches(snapshotOf(late))[0], moved[0]);
    } finally {
      await h.close();
    }
  });
}

test('B: a choice the person took back writes no switch item, and the next message stays on its agent', async () => {
  const dir = fs.mkdtempSync(path.join(base, 'u-'));
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(base, 'cwd-')));
  const h = await openAll(dir);
  try {
    const chatId = AGENTS.claude.id();
    await h.call('chat.subscribe', chatId);
    await h.call('chat.start', chatId, { harness: 'claude', text: 'FIRST', cwd });
    await h.idle(chatId, 1);
    await h.call('chat.switch', chatId, { harness: 'codex' });
    await h.call('chat.switch', chatId, { harness: 'claude' });
    await h.call('chat.send', chatId, { text: 'SECOND' });
    await h.idle(chatId, 2);
    assert.equal(switches(items(h, chatId)).length, 0);
    assert.equal(h.sessions.controller.ref(chatId).kind, 'claude');
  } finally {
    await h.close();
  }
});

test('W: the item survives the Host: a new Host on the same data tells it once to a client that subscribes, and a second switch makes a second item', async () => {
  const dir = fs.mkdtempSync(path.join(base, 'r-'));
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(base, 'cwd-')));
  const chatId = AGENTS.claude.id();
  const one = await openAll(dir);
  try {
    await one.call('chat.subscribe', chatId);
    await one.call('chat.start', chatId, { harness: 'claude', text: 'FIRST', cwd });
    await one.idle(chatId, 1);
    await one.call('chat.switch', chatId, { harness: 'codex' });
    await one.call('chat.send', chatId, { text: 'SECOND' });
    await one.idle(chatId, 2);
    await one.call('chat.switch', chatId, { harness: 'claude' });
    await one.call('chat.send', chatId, { text: 'THIRD' });
    await one.idle(chatId, 3);
    const told = switches(items(one, chatId));
    assert.deepEqual(
      told.map((i: any) => [i.from, i.to]),
      [
        ['claude', 'codex'],
        ['codex', 'claude'],
      ],
    );
  } finally {
    await one.close();
  }
  const two = await openAll(dir);
  try {
    const seen = await two.hello(chatId);
    assert.deepEqual(
      switches(snapshotOf(seen)).map((i: any) => [i.from, i.to]),
      [
        ['claude', 'codex'],
        ['codex', 'claude'],
      ],
      'the restarted Host still has both, once each',
    );
  } finally {
    await two.close();
  }
});
