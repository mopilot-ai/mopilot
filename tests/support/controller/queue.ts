// Queue/start/stop/switch acceptance scenarios.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unattendedReason, setup, tick, codex } from './fixture';

export function registerQueueCases() {
  test("a goal queued on Codex goes to the harness the chat switched to as that harness's /goal command", async () => {
    const { c, chats, execs } = setup();
    chats.setSegments('t1', [
      { harness: 'codex', nativeId: 't1', start: 0, count: 2 },
      { harness: 'claude', nativeId: 'claude:s2', start: 2, count: null },
    ]);
    c.invalidate();
    c.send('t1', { text: 'ship it', attachments: [], opts: { goal: 'ship it', model: 'm' } }, 1);
    await tick();
    const sent = execs.find((e: any) => e.kind === 'claude-turn')!;
    assert.equal(sent.item.text, '/goal ship it');
    // the provenance it was queued with: no human wrote it, so it is not the user's word (#2249)
    assert.deepEqual(sent.item.opts, { model: 'm' });
    // an ACP harness gets it the same way
    c.send('acp:kimi:g1', { text: 'k', attachments: [], opts: { goal: 'k' } }, 1);
    await tick();
    assert.equal(execs.find((e: any) => e.kind === 'acp-turn')!.item.text, '/goal k');
    // on Codex it stays a Codex goal
    c.send('t9', { text: 'g', attachments: [], opts: { goal: 'g' } }, 1);
    await tick();
    assert.deepEqual(execs.at(-1)!.kind, 'goal');
    assert.equal(execs.at(-1)!.item.opts.goal, 'g');
  });

  test('NativeRef: a chat goes to its last segment, from the v2 file', () => {
    const { c, chats } = setup();
    assert.deepEqual(c.ref('t1'), { kind: 'codex', id: 't1', instance: null, key: 't1' });
    chats.setSegments('t1', [
      { harness: 'codex', nativeId: 't1', start: 0, count: 2 },
      { harness: 'claude', nativeId: 'claude:s2', start: 2, count: null },
    ]);
    c.invalidate();
    assert.deepEqual(c.ref('t1'), { kind: 'claude', id: 's2', instance: null, key: 'claude:s2' });
    // events from either native session belong to the chat
    assert.equal(c.chatOf('claude:s2'), 't1');
    assert.equal(c.chatOf('t1'), 't1');
    assert.equal(c.chatOf('other'), 'other');
  });

  test('idle: a message starts a turn in the window it came from', async () => {
    const { c, execs, s } = setup();
    const r = c.send('t1', { text: 'hi', attachments: [], opts: { human: true } }, 7);
    assert.equal(r.action, 'started');
    assert.equal(s('t1').turn, 'running');
    assert.deepEqual(s('t1').activeTurn, { id: `pending-${r.id}`, human: true });
    assert.equal(execs.length, 1);
    assert.equal(execs[0].kind, 'turn');
    assert.equal(execs[0].origin, 7);
    assert.equal(execs[0].item.text, 'hi');
  });

  test('a start that throws keeps the message first in the queue, from a send and from the drain', async () => {
    const { c, s } = setup();
    c.start = () => Promise.reject(new Error('start broke'));
    c.send('t1', { text: 'hi', opts: { human: true } }, 1);
    await tick();
    assert.deepEqual(
      s('t1').queue.map((q: any) => q.text),
      ['hi'],
    );
    // the drain takes it off the queue to start it, and puts it back when the start throws
    const r = await c.drain('t1');
    assert.deepEqual(r, { started: false, error: 'start broke' });
    assert.deepEqual(
      s('t1').queue.map((q: any) => q.text),
      ['hi'],
    );
  });

  test('running: messages queue once each, keeping their SendOptions, and go out in order', async () => {
    const { c, execs, s } = setup();
    c.send('t1', { text: 'first', opts: { human: true } }, 1);
    c.onCodexMessage(codex('turn/started', { threadId: 't1', turn: { id: 'turn-1' } }));
    assert.equal(s('t1').activeTurn.id, 'turn-1');
    // two windows send at once: each is queued, nothing is sent
    const a = c.send('t1', { text: 'plan this', opts: { plan: true, human: true } }, 1);
    const b = c.send('t1', { text: 'and this', opts: { goal: 'ship', model: 'm2', effort: 'high' } }, 2);
    assert.equal(a.action, 'queued');
    assert.equal(b.action, 'queued');
    assert.equal(execs.length, 1);
    assert.deepEqual(
      s('t1').queue.map((q: any) => [q.text, q.opts, q.origin]),
      [
        ['plan this', { plan: true, human: true }, 1],
        ['and this', { goal: 'ship', model: 'm2', effort: 'high' }, 2],
      ],
    );
    c.onCodexMessage(codex('turn/completed', { threadId: 't1', turn: { id: 'turn-1', status: 'completed' } }));
    assert.equal(execs.length, 2);
    assert.deepEqual(execs[1].item.opts, { plan: true, human: true });
    assert.equal(execs[1].origin, 1);
    assert.equal(s('t1').queue.length, 1);
    assert.equal(s('t1').turn, 'running');
    await tick();
    c.onCodexMessage(codex('turn/started', { threadId: 't1', turn: { id: 'turn-2' } }));
    c.onCodexMessage(codex('turn/completed', { threadId: 't1', turn: { id: 'turn-2', status: 'completed' } }));
    assert.equal(execs.length, 3);
    assert.deepEqual(execs[2].item.opts, { goal: 'ship', model: 'm2', effort: 'high' });
    assert.equal(execs[2].origin, 2);
    assert.equal(s('t1').activeTurn.human, false);
  });

  test('steer follow-ups go into the running turn, but not ones with plan, goal or a pending switch', () => {
    const { c, execs, s, state } = setup();
    c.send('t1', { text: 'first' }, 1);
    assert.equal(c.send('t1', { text: 'nudge', followUp: 'steer', opts: {} }, 1).action, 'steered');
    assert.equal(execs[1].kind, 'steer');
    assert.equal(c.send('t1', { text: 'p', followUp: 'steer', opts: { plan: true } }, 1).action, 'queued');
    assert.equal(c.send('t1', { text: 'g', followUp: 'steer', opts: { goal: 'x' } }, 1).action, 'queued');
    state.clientPatch('t1', { pendingSwitch: { harness: 'claude', model: 'm', modelLabel: 'M', mode: 'auto' } });
    assert.equal(c.send('t1', { text: 's', followUp: 'steer', opts: {} }, 1).action, 'queued');
    assert.equal(s('t1').queue.length, 3);
  });

  test('human steering joins an automatic turn without changing its original provenance', async () => {
    for (const chat of ['t1', 'claude:attended']) {
      const { c, s, execs } = setup();
      c.send(chat, { text: 'Background work', opts: { human: false } }, null);
      await tick();
      assert.equal(unattendedReason({ turn: s(chat).activeTurn }), 'a turn MoPilot started');
      c.send(chat, { text: 'I approve computer use', followUp: 'steer', opts: { human: true } }, 1);
      // Tools can run before the adapter ACK, so attendance is visible during submission.
      assert.equal(s(chat).activeTurn.human, false);
      assert.equal(unattendedReason({ turn: s(chat).activeTurn, idleMs: 0 }), null);
      assert.equal(unattendedReason({ turn: s(chat).activeTurn, subagent: true }), 'a sub-agent');
      assert.equal(unattendedReason({ turn: s(chat).activeTurn, idleMs: 600000 }), 'no input for 10 minutes');
      await tick();
      assert.equal(execs[1].kind, chat === 't1' ? 'steer' : 'claude-steer');
      c.end(chat, { drain: false });
      c.send(chat, { text: 'Next automatic round', opts: {} }, null);
      assert.equal(unattendedReason({ turn: s(chat).activeTurn }), 'a turn MoPilot started');
    }
  });

  test('queued human input and peer steering cannot mark the current automatic turn attended', async () => {
    for (const chat of ['t1', 'claude:queued', 'acp:test:queued']) {
      const { c, s } = setup();
      c.send(chat, { text: 'Background work', opts: {} }, null);
      await tick();
      c.send(chat, { text: 'Later human input', opts: { human: true } }, 1);
      assert.equal(unattendedReason({ turn: s(chat).activeTurn }), 'a turn MoPilot started');
      c.send(chat, { text: 'Peer input', followUp: 'steer', peer: { messageId: 'p', sourceChatId: 'other' }, opts: { human: true } }, null);
      assert.equal(unattendedReason({ turn: s(chat).activeTurn }), 'a turn MoPilot started');
    }
  });

  test('rejected human steers restore attendance while accepted overlapping steers keep it', async () => {
    for (const acceptSecond of [false, true]) {
      const { c, s, execs } = setup({ auto: false });
      c.send('t1', { text: 'Automatic', opts: {} }, null);
      execs[0].done({ started: true });
      await tick();
      c.send('t1', { text: 'First', followUp: 'steer', opts: { human: true } }, 1);
      c.send('t1', { text: 'Second', followUp: 'steer', opts: { human: true } }, 1);
      execs[1].done({ started: false });
      await tick();
      assert.equal(unattendedReason({ turn: s('t1').activeTurn }), null);
      execs[2].done({ started: acceptSecond });
      await tick();
      assert.equal(unattendedReason({ turn: s('t1').activeTurn }), acceptSecond ? null : 'a turn MoPilot started');
    }
  });

  test('a harness switch chosen during a run waits for completion, then sends the future prompt on the target', async () => {
    const { c, execs, s, state, chats } = setup({ auto: false });
    c.send('t1', { text: 'current prompt', opts: { model: 'old' } }, 1);
    execs[0].done({ started: true, turnId: 'turn-1' });
    await tick();
    state.clientPatch('t1', { pendingSwitch: { harness: 'claude', model: 'new', modelLabel: 'New', mode: 'auto' } });
    assert.equal(c.send('t1', { text: 'future prompt', followUp: 'steer', opts: { model: 'new' } }, 1).action, 'queued');
    assert.equal(execs.length, 1);
    assert.equal(s('t1').activeTurn.id, 'turn-1');
    assert.equal(execs[0].item.opts.model, 'old');
    c.onCodexMessage(codex('turn/completed', { threadId: 't1', turn: { id: 'turn-1', status: 'completed' } }));
    assert.equal(execs[1].kind, 'handoff');
    assert.equal(execs[1].item.model, 'new');
    chats.setSegments('t1', [
      { harness: 'codex', nativeId: 't1', start: 0, count: 1 },
      { harness: 'claude', nativeId: 'claude:s2', start: 1, count: null },
    ]);
    execs[1].done({ ready: true });
    await tick();
    assert.equal(execs[2].kind, 'claude-turn');
    assert.equal(execs[2].item.text, 'future prompt');
    assert.equal(execs[2].item.opts.model, 'new');
    execs[2].done({ started: true });
    await tick();
  });

  test('a pending switch is settled first: main writes the handoff, then the turn goes to the new segment with it', async () => {
    const { c, execs, s, state, chats } = setup({ auto: false });
    state.clientPatch('t1', { pendingSwitch: { harness: 'claude', model: 'm', modelLabel: 'M', mode: 'auto' } });
    c.send('t1', { text: 'go on', opts: { human: true } }, 1);
    assert.equal(execs[0].kind, 'handoff');
    // the switcher gets the choice, and the chip is gone as soon as the message is on its way
    assert.equal(execs[0].item.harness, 'claude');
    assert.equal(s('t1').pendingSwitch, null);
    // the switcher opened the Claude segment before answering
    chats.setSegments('t1', [
      { harness: 'codex', nativeId: 't1', start: 0, count: 1 },
      { harness: 'claude', nativeId: 'claude:s2', start: 1, count: null },
    ]);
    execs[0].done({ ready: true, prefix: '<sage-handoff/>', note: { kind: 'switch', text: 'Codex → Claude' } });
    await tick();
    assert.equal(s('t1').pendingSwitch, null);
    // a Claude segment: the adapter starts the message, carrying the record and the divider
    assert.equal(execs[1].kind, 'claude-turn');
    assert.equal(execs[1].ref.key, 'claude:s2');
    assert.deepEqual(execs[1].item.opts, { human: true, prefix: '<sage-handoff/>', note: { kind: 'switch', text: 'Codex → Claude' } });
  });

  test('a goal the switch sets again waits behind the message and goes out when its turn ends', async () => {
    const { c, execs, s, state, chats } = setup({ auto: false });
    state.clientPatch('t1', { pendingSwitch: { harness: 'claude', model: 'm', modelLabel: 'M', mode: 'auto', goal: 'tests pass' } });
    c.send('t1', { text: 'go on', opts: { human: true } }, 1);
    chats.setSegments('t1', [
      { harness: 'codex', nativeId: 't1', start: 0, count: 1 },
      { harness: 'claude', nativeId: 'claude:s2', start: 1, count: null },
    ]);
    execs[0].done({ ready: true, prefix: '<h/>', after: [{ text: '/goal tests pass', opts: {} }] });
    await tick();
    assert.equal(execs[1].item.text, 'go on');
    assert.deepEqual(
      s('t1').queue.map((q: any) => q.text),
      ['/goal tests pass'],
    );
    execs[1].done({ started: true });
    await tick();
  });

  test('a switch that could not be made ends the turn without sending', async () => {
    const { c, execs, s, state } = setup({ auto: false });
    state.clientPatch('t1', { pendingSwitch: { harness: 'claude', model: 'm', modelLabel: 'M', mode: 'auto' } });
    c.send('t1', { text: 'go on' }, 1);
    execs[0].done({ ready: false });
    await tick();
    assert.equal(execs.length, 1);
    assert.equal(s('t1').turn, 'crashed');
    assert.equal(s('t1').crashed, 'The switch did not finish. Your message is kept in the queue.');
    // the switch is still chosen: the message kept in the queue goes through it when sent again
    assert.equal(s('t1').pendingSwitch?.harness, 'claude');
  });

  test('Codex: turns, goals and steers go to the adapter in main, which names the turn', async () => {
    const { c, execs, s } = setup({ auto: false });
    c.send('t1', { text: 'hi' }, 3);
    assert.equal(execs[0].kind, 'turn');
    assert.equal(execs[0].ref.id, 't1');
    execs[0].done({ started: true, turnId: 'turn-1' });
    await tick();
    assert.equal(s('t1').activeTurn.id, 'turn-1');
    c.send('t1', { text: 'nudge', followUp: 'steer', opts: {} }, 3);
    assert.equal(execs[1].kind, 'steer');
    c.onCodexMessage(codex('turn/completed', { threadId: 't1', turn: { id: 'turn-1', status: 'completed' } }));
    c.send('t1', { text: '', opts: { goal: 'ship it' } }, 3);
    assert.equal(execs[2].kind, 'goal');
  });

  test('Stop: an interrupted turn ends without sending the queue; the next turn end sends it', async () => {
    const { c, execs, s } = setup();
    c.send('t1', { text: 'first' }, 1);
    c.onCodexMessage(codex('turn/started', { threadId: 't1', turn: { id: 'turn-1' } }));
    c.send('t1', { text: 'later' }, 1);
    c.onCodexMessage(codex('turn/completed', { threadId: 't1', turn: { id: 'turn-1', status: 'interrupted' } }));
    assert.equal(s('t1').turn, 'idle');
    assert.equal(s('t1').queue.length, 1);
    assert.equal(execs.length, 1);
    // "Send now" on the queued message starts it
    assert.equal(c.sendNow('t1', s('t1').queue[0].id, 1), true);
    assert.equal(execs.length, 2);
    assert.equal(s('t1').queue.length, 0);
  });

  test("a message a window took to hold (another Codex app has the chat) isn't also kept in the queue", async () => {
    const { c, execs, s } = setup({ auto: false });
    c.send('t1', { text: 'first' }, 1);
    c.send('t1', { text: 'queued' }, 1);
    execs[0].done({ started: false, held: true });
    await tick();
    assert.equal(s('t1').turn, 'idle');
    // the window sends 'first' when the lock is let go; queued here too, it would go twice
    assert.deepEqual(
      s('t1').queue.map((q: any) => q.text),
      ['queued'],
    );
  });

  test('a turn that did not start (turn/start failed, chat held) returns the chat to idle and keeps the queue', async () => {
    const { c, execs, s } = setup({ auto: false });
    c.send('t1', { text: 'first' }, 1);
    c.send('t1', { text: 'queued' }, 1);
    execs[0].done({ started: false });
    await tick();
    assert.equal(s('t1').turn, 'idle');
    assert.equal(s('t1').activeTurn, null);
    assert.deepEqual(
      s('t1').queue.map((q: any) => q.text),
      ['first', 'queued'],
    );
  });

  test('a Codex turn that never names itself stops counting as running', async () => {
    const { c, s } = setup({ graceMs: 5 });
    c.send('t1', { text: 'first' }, 1);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(s('t1').turn, 'idle');
  });

  test('only a harness that names its turn later times an unnamed start out: Claude Code and ACP starts keep running', async () => {
    const { c, s } = setup({ graceMs: 5 });
    // the fake adapters answer { started: true } without a turn id, as a Codex goal does
    c.send('claude:s1', { text: 'claude' }, 1);
    c.send('acp:kimi:a1', { text: 'acp' }, 1);
    c.send('t1', { text: 'codex' }, 1);
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(
      ['claude:s1', 'acp:kimi:a1', 't1'].map((id) => s(id).turn),
      ['running', 'running', 'idle'],
    );
  });

  test('a fast turn that ends before the window answers is not reopened by the late answer', async () => {
    const { c, execs, s } = setup({ auto: false });
    c.send('t1', { text: 'quick' }, 1);
    c.onCodexMessage(codex('turn/started', { threadId: 't1', turn: { id: 'turn-1' } }));
    c.onCodexMessage(codex('turn/completed', { threadId: 't1', turn: { id: 'turn-1', status: 'completed' } }));
    execs[0].done({ started: true });
    await tick();
    assert.equal(s('t1').turn, 'idle');
  });

  test('a turn the harness starts itself is running, and unattended', () => {
    const { c, s } = setup();
    c.state.get('t1');
    c.onCodexMessage(codex('turn/started', { threadId: 't1', turn: { id: 'goal-round' } }));
    assert.equal(s('t1').turn, 'running');
    assert.deepEqual(s('t1').activeTurn, { id: 'goal-round', human: false });
    // hidden helper threads no window follows are left alone
    c.onCodexMessage(codex('turn/started', { threadId: 'helper', turn: { id: 'x' } }));
    assert.equal(c.state.has('helper'), false);
  });
}
