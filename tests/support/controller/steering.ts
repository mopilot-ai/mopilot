// Steer/turn-end races and fallback message preservation scenarios.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, tick, codex } from './fixture';

export function registerSteeringCases() {
  /* -- Steer now racing the end of the turn (tests/e2e/cuj-daily-chat-loop.spec.ts flake) ---------- */
  test("Steer now racing the turn's end on Codex: a steer the app-server refused is the next turn, sent once", async () => {
    const { c, execs, s } = setup({ auto: false });
    c.send('t1', { text: 'take it SLOW', opts: { human: true } }, 1);
    execs[0].done({ started: true, turnId: 'turn-1' });
    await tick();
    const q = c.send('t1', { text: 'also check the docs', opts: { human: true } }, 1);
    c.send('t1', { text: 'after that', opts: {} }, 1);
    assert.equal(c.sendNow('t1', q.id, 1), true);
    await tick();
    assert.equal(execs[1].kind, 'steer');
    // the turn ends while turn/steer is on its way: the queue waits for the steer to settle
    c.onCodexMessage(codex('turn/completed', { threadId: 't1', turn: { id: 'turn-1', status: 'completed' } }));
    assert.equal(s('t1').turn, 'idle');
    assert.equal(execs.length, 2);
    // the app-server refuses it (expectedTurnId is no longer the active turn): it is the next turn, once
    execs[1].done({ started: false, error: 'no active turn to steer' });
    await tick();
    assert.deepEqual(
      execs.slice(2).map((x) => [x.kind, x.item.text]),
      [['turn', 'also check the docs']],
    );
    assert.equal(s('t1').activeTurn.id, `pending-${q.id}`);
    assert.deepEqual(
      s('t1').queue.map((x: any) => x.text),
      ['after that'],
    );
    // and the rest of the queue after it
    execs[2].done({ started: true, turnId: 'turn-2' });
    await tick();
    c.onCodexMessage(codex('turn/completed', { threadId: 't1', turn: { id: 'turn-2', status: 'completed' } }));
    assert.deepEqual(
      execs.slice(1).map((x) => [x.kind, x.item.text]),
      [
        ['steer', 'also check the docs'],
        ['turn', 'also check the docs'],
        ['turn', 'after that'],
      ],
    );
  });

  test("Steer now racing the turn's end: a steer the harness took is never sent again", async () => {
    for (const chat of ['t1', 'claude:s1']) {
      const { c, execs, s } = setup({ auto: false });
      c.send(chat, { text: 'take it SLOW', opts: { human: true } }, 1);
      execs[0].done({ started: true, turnId: 'turn-1' });
      await tick();
      const q = c.send(chat, { text: 'also check the docs', opts: { human: true } }, 1);
      c.send(chat, { text: 'after that', opts: {} }, 1);
      c.sendNow(chat, q.id, 1);
      await tick();
      c.end(chat);
      execs[1].done({ started: true });
      await tick();
      // the next turn is the queue's, not the steered message again
      assert.deepEqual(
        execs.slice(1).map((x) => x.item.text),
        ['also check the docs', 'after that'],
      );
      assert.equal(s(chat).queue.length, 0);
    }
  });

  test("Steer now racing the turn's end: a turn that ended before the steer went out is not steered into", async () => {
    for (const [chat, steerKind, turnKind] of [
      ['t1', 'steer', 'turn'],
      ['claude:s1', 'claude-steer', 'claude-turn'],
    ]) {
      const { c, execs, s } = setup({ auto: false });
      c.send(chat, { text: 'take it SLOW', opts: { human: true } }, 1);
      execs[0].done({ started: true, turnId: 'turn-1' });
      await tick();
      const q = c.send(chat, { text: 'also check the docs', opts: { human: true } }, 1);
      // the delivery hook (peer journal) still runs when the turn ends
      let open!: () => void;
      c.beforeDispatch = () => new Promise<void>((r) => (open = r));
      c.sendNow(chat, q.id, 1);
      c.end(chat);
      c.beforeDispatch = null;
      open();
      await tick();
      await tick();
      assert.deepEqual(
        execs.slice(1).map((x) => [x.kind, x.item.text]),
        [[turnKind, 'also check the docs']],
      );
      assert.equal(
        execs.some((x) => x.kind === steerKind),
        false,
      );
      assert.equal(s(chat).activeTurn.id, `pending-${q.id}`);
    }
  });

  test('a steer refused while the turn still runs waits first in line; a followUp steer too', async () => {
    const { c, execs, s } = setup({ auto: false });
    const chat = 'claude:s1';
    c.send(chat, { text: 'first', opts: { human: true } }, 1);
    execs[0].done({ started: true });
    await tick();
    c.send(chat, { text: 'older', opts: {} }, 1);
    c.send(chat, { text: 'steer me', followUp: 'steer', opts: { human: true } }, 1);
    execs[1].done({ started: false, error: 'send failed' });
    await tick();
    assert.deepEqual(
      s(chat).queue.map((x: any) => x.text),
      ['steer me', 'older'],
    );
    c.end(chat);
    assert.deepEqual(
      execs.slice(2).map((x) => [x.kind, x.item.text]),
      [['claude-turn', 'steer me']],
    );
  });

  test('a steer that fails after Stop or a crash is kept first in the queue, not sent', async () => {
    for (const how of ['stop', 'crash']) {
      const { c, execs, s } = setup({ auto: false });
      c.send('t1', { text: 'first', opts: { human: true } }, 1);
      execs[0].done({ started: true, turnId: 'turn-1' });
      await tick();
      c.send('t1', { text: 'older', opts: {} }, 1);
      c.send('t1', { text: 'steer me', followUp: 'steer', opts: { human: true } }, 1);
      if (how === 'stop') c.onCodexMessage(codex('turn/completed', { threadId: 't1', turn: { id: 'turn-1', status: 'interrupted' } }));
      else c.crash('t1', 'gone');
      execs[1].done({ started: false });
      await tick();
      assert.equal(execs.length, 2);
      assert.deepEqual(
        s('t1').queue.map((x: any) => x.text),
        ['steer me', 'older'],
      );
    }
    // two steers on their way: the queue waits for both
    const { c, execs, s } = setup({ auto: false });
    c.send('t1', { text: 'first', opts: { human: true } }, 1);
    execs[0].done({ started: true, turnId: 'turn-1' });
    await tick();
    c.send('t1', { text: 'a', followUp: 'steer', opts: {} }, 1);
    c.send('t1', { text: 'b', followUp: 'steer', opts: {} }, 1);
    c.end('t1');
    execs[1].done({ started: true });
    await tick();
    assert.equal(execs.length, 3);
    execs[2].done({ started: false });
    await tick();
    assert.deepEqual(
      execs.slice(3).map((x) => [x.kind, x.item.text]),
      [['turn', 'b']],
    );
    assert.equal(s('t1').queue.length, 0);
  });

  test('a peer steer that failed keeps its own delivery record; a queued fallback is not queued twice', async () => {
    const { c, execs, s } = setup({ auto: false });
    c.send('t1', { text: 'first', opts: { human: true } }, 1);
    execs[0].done({ started: true, turnId: 'turn-1' });
    await tick();
    c.send('t1', { text: 'peer', followUp: 'steer', peer: { messageId: 'p', sourceChatId: 'o' }, opts: {} }, null);
    execs[1].done({ started: false });
    await tick();
    assert.equal(s('t1').queue.length, 0);
    // the delivery hook queued it itself
    c.beforeDispatch = (d: any) => {
      c.state.patch('t1', { queue: [...s('t1').queue, d.item] });
      throw Object.assign(new Error('approval_pending'), { queuedFallback: true });
    };
    c.send('t1', { text: 'held', followUp: 'steer', opts: {} }, 1);
    await tick();
    assert.deepEqual(
      s('t1').queue.map((x: any) => x.text),
      ['held'],
    );
  });

  test("Steer now on ACP racing the turn's end: the message is the next turn, sent once", async () => {
    const { c, execs, s } = setup();
    const chat = 'acp:kimi:k1';
    for (const before of [true, false]) {
      c.send(chat, { text: 'one', opts: { human: true } }, 1);
      await tick();
      c.onAcpEvent({ key: chat, kind: 'turnStart', turnId: `at-${before}`, human: true });
      const q = c.send(chat, { text: `steer ${before}`, opts: { human: true } }, 1);
      const n = execs.length;
      if (before) c.sendNow(chat, q.id, 1);
      c.onAcpEvent({ key: chat, kind: 'turnEnd', turnId: `at-${before}`, stopReason: 'end_turn' });
      if (!before) c.sendNow(chat, q.id, 1);
      await tick();
      assert.deepEqual(
        execs.slice(n).map((x) => [x.kind, x.item.text]),
        [['acp-turn', `steer ${before}`]],
      );
      assert.equal(s(chat).queue.length, 0);
      c.end(chat);
    }
  });
}
