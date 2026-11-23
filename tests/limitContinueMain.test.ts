// electron/session/limitContinue.cjs: a chat whose turn ended on its harness's usage limit goes on by itself in main, on
// every harness and with no window open: on the other first-tier harness when one can run, else when its quota is back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { setup, tick, codex, selectSegment } from './support/controller/fixture.ts';
import { rig, clock, CHAT, BASE, SEGMENTS } from './support/limit-continuation-harness.ts';

const require = createRequire(import.meta.url);
const { LimitContinuation, SETTLE_MS, RESET_GRACE_MS } = require('../electron/session/limitContinue.cjs');
const { assertInputCurrent } = require('../electron/session/contract/inputGuard.cjs');

test('a turn that ended on the limit switches to the other harness and sends Continue, with no window open', async () => {
  const t = await rig({ make: true });
  await t.limited();
  assert.equal(t.sent.length, 0, 'main waits for the account pool to move the chat first');
  await t.settle();
  assert.deepEqual(t.chosen, [[CHAT, 'codex']]);
  assert.equal(t.sent.length, 1);
  assert.equal(t.sent[0].item.text, 'Continue');
  assert.equal(t.sent[0].item.id, 'authored-1');
  assert.deepEqual(t.sent[0].ps, { harness: 'claude', model: 'opus', modelLabel: 'Opus', mode: 'auto' });
  assert.deepEqual(t.limit.own.size, 0, 'the item is only its own while it is being sent');
});

test('an older continuation caller with no preference reader captures the destination native default', async () => {
  const t = await rig({ prefs: false });
  await t.limited();
  await t.settle();
  assert.deepEqual(t.sent[0].ps, { harness: 'claude', model: null, modelLabel: '', mode: 'auto' });
  assert.equal(t.sent[0].item.text, 'Continue');
});

for (const kind of ['codex', 'claude', 'acp:kimi']) {
  test(`${kind}: the chat's own harness is the one it leaves`, async () => {
    const t = await rig({ kind, to: 'codex' });
    await t.limited();
    await t.settle();
    assert.deepEqual(t.chosen, [[CHAT, kind]]);
    assert.equal(t.sent[0].ps.harness, 'codex');
    assert.equal(t.sent[0].ps.model, 'gpt-6.1-sol');
    assert.equal(t.sent[0].ps.modelLabel, 'GPT-6.1 Sol');
  });
}

test('an item made without an authored input still gets an id of its own', async () => {
  const t = await rig();
  await t.limited();
  await t.settle();
  assert.match(t.sent[0].item.id, /^[0-9a-f-]{36}$/);
  assert.doesNotThrow(() => assertInputCurrent(t.sent[0].item));
});

test('with Settings → General off, nothing is sent (the note and its button stay)', async () => {
  const t = await rig({ enabled: false, switchEnabled: false });
  await t.limited();
  await t.settle();
  assert.deepEqual([t.chosen, t.sent], [[], []]);
  assert.equal(clock.pending, 0);
});

test('turning it off while a chat waits stops the Continue', async () => {
  const t = await rig();
  await t.limited();
  t.settings.enabled = false;
  t.settings.switchEnabled = false;
  await t.settle();
  assert.deepEqual(t.sent, []);
});

test('a turn that ended some other way is not taken up, and its limit mark does not outlive it', async () => {
  const t = await rig();
  t.c.send(CHAT, { text: 'work', opts: { human: true } }, null);
  await tick();
  t.c.end(CHAT, { outcome: 'failed' });
  await t.settle();
  assert.deepEqual(t.sent, []);
  t.c.onLimit(CHAT);
  await t.c.beforeDispatch({ chatId: CHAT, item: { id: 'user-next' } });
  t.c.send(CHAT, { text: 'again', opts: { human: true } }, null);
  await tick();
  t.c.end(CHAT, { outcome: 'completed' });
  await t.settle();
  assert.deepEqual(t.sent, [], 'a new message cleared the earlier limit');
});

test("the user's own message cancels the continuation, even one without an id", async () => {
  for (const item of [{ id: 'user-1', text: 'hi' }, { text: 'no id' }]) {
    const t = await rig();
    await t.limited();
    await t.c.beforeDispatch({ chatId: CHAT, item });
    await t.settle();
    assert.deepEqual(t.sent, []);
    assert.equal(clock.pending, 0);
  }
});

test('a running turn, a queued message or a pending switch at the time cancels it', async () => {
  for (const [name, patch] of [
    ['running', { turn: 'running', activeTurn: { id: 'x' } }],
    ['queued', { queue: [{ id: 'q', text: 'later', attachments: [], opts: {} }] }],
    ['switch', { pendingSwitch: { harness: 'claude', model: '', modelLabel: 'Claude Code', mode: 'auto' } }],
  ] as const) {
    const t = await rig();
    await t.limited();
    t.state.patch(CHAT, patch as any);
    await t.settle();
    assert.deepEqual(t.sent, [], name);
  }
});

test('a Stop, a crash or an interrupt retires it', async () => {
  for (const hook of ['onStopped', 'onInterrupt', 'onCrash']) {
    const t = await rig();
    await t.limited();
    t.c[hook](CHAT);
    await t.settle();
    assert.deepEqual(t.sent, [], hook);
  }
});

test('a chat that moved to another harness meanwhile is left alone', async () => {
  const t = await rig();
  await t.limited();
  selectSegment(t.c, t.chats, CHAT, SEGMENTS.claude);
  await t.settle();
  assert.deepEqual(t.sent, []);
});

test('a chat deleted or switched while the harness is chosen is left alone', async () => {
  const t = await rig();
  t.limit.choose = async () => {
    t.limit.retire(CHAT);
    return 'claude';
  };
  await t.limited();
  await t.settle();
  assert.deepEqual(t.sent, []);
});

test('every harness reports a limit more than once: one owner per chat and limit turn', async () => {
  const t = await rig();
  t.limit.hit(CHAT);
  t.limit.finished({ chatId: CHAT, turnId: 'T' });
  t.limit.hit(CHAT);
  t.limit.finished({ chatId: CHAT, turnId: 'T' });
  assert.equal(clock.pending, 1);
  await t.settle();
  assert.equal(t.sent.length, 1);
  // a newer limit turn replaces the owner
  t.limit.hit(CHAT);
  t.limit.finished({ chatId: CHAT, turnId: 'T2' });
  t.limit.hit(CHAT);
  t.limit.finished({ chatId: CHAT, turnId: 'T3' });
  assert.equal(clock.pending, 1);
});

test('one automatic switch per limit: a limit in the Continue it sent waits for the reset instead of switching back', async () => {
  const t = await rig({ resetAt: () => BASE + 60_000 });
  await t.limited();
  await t.settle();
  assert.equal(t.sent.length, 1);
  // the Continue's turn ends on the limit too
  t.limit.hit(CHAT);
  t.limit.finished({ chatId: CHAT, turnId: 'second' });
  await t.settle();
  assert.equal(t.chosen.length, 1, 'the other harness is not tried again');
  assert.equal(t.sent.length, 1);
  clock.advance(60_000 + RESET_GRACE_MS - 2 * SETTLE_MS - 1);
  await tick();
  assert.equal(t.sent.length, 1);
  clock.advance(1);
  await tick();
  assert.equal(t.sent.length, 2);
  assert.equal(t.sent[1].ps, null, 'no second switch');
});

test('a Continue turn that ended well lets the next limit switch again', async () => {
  const t = await rig();
  await t.limited();
  await t.settle();
  t.limit.finished({ chatId: CHAT, turnId: 'fine' });
  t.limit.hit(CHAT);
  t.limit.finished({ chatId: CHAT, turnId: 'later-limit' });
  await t.settle();
  assert.equal(t.chosen.length, 2);
});

test('no harness can run: it waits for the quota the registry names, and sends Continue then', async () => {
  const t = await rig({ to: null, resetAt: () => BASE + 10 * 60_000 });
  await t.limited();
  await t.settle();
  assert.equal(t.sent.length, 0);
  clock.advance(10 * 60_000 + RESET_GRACE_MS - SETTLE_MS);
  await tick();
  assert.equal(t.sent.length, 1);
  assert.equal(t.sent[0].item.text, 'Continue');
  assert.equal(t.sent[0].ps, null);
});

test('no reset time known: nothing is waited for (the note keeps its button)', async () => {
  const t = await rig({ to: null });
  await t.limited();
  await t.settle();
  assert.equal(clock.pending, 0);
  assert.deepEqual(t.sent, []);
});

test('the wait follows a later reset, and gives up when the user went on', async () => {
  let at = 0;
  const t = await rig({ to: null, resetAt: () => at });
  at = clock.now() + 1000;
  await t.limited();
  await t.settle();
  // limited again for longer when the time comes
  at = clock.now() + 5 * 60_000;
  clock.advance(1000 + RESET_GRACE_MS);
  await tick();
  assert.deepEqual(t.sent, []);
  // the user went on meanwhile
  t.c.send(CHAT, { text: 'mine', opts: { human: true } }, null);
  await tick();
  clock.advance(5 * 60_000 + RESET_GRACE_MS);
  await tick();
  assert.deepEqual(t.sent, []);
});

test('a wait longer than a timer can hold is armed again until its time', async () => {
  const day = 24 * 3600_000;
  const t = await rig({ to: null, resetAt: () => BASE + 40 * day });
  await t.limited();
  await t.settle();
  clock.advance(30 * day);
  await tick();
  assert.deepEqual(t.sent, []);
  clock.advance(10 * day + RESET_GRACE_MS - SETTLE_MS);
  await tick();
  assert.equal(t.sent.length, 1);
});

test('a quota that is back but whose reset is already past is read as back', async () => {
  let at: number | null = null;
  const t = await rig({ to: null, resetAt: () => at });
  at = clock.now() + 1000;
  await t.limited();
  await t.settle();
  at = clock.now() - 5;
  clock.advance(1000 + RESET_GRACE_MS);
  await tick();
  assert.equal(t.sent.length, 1);
});

test('the harness refusing the Continue leaves no switch behind', async () => {
  const t = await rig({ receipt: async () => ({ action: 'failed' }) });
  await t.limited();
  await t.settle();
  assert.equal(t.sent.length, 1);
  assert.equal(t.s(CHAT).pendingSwitch, null);
  assert.equal(t.limit.switched.size, 0);
});

test('a refused Continue after someone else changed the switch leaves theirs', async () => {
  const mine = { harness: 'codex', model: 'x', modelLabel: 'X', mode: 'auto' };
  const t = await rig({
    receipt: async () => {
      t.state.patch(CHAT, { pendingSwitch: mine });
      return { action: 'failed' };
    },
  });
  await t.limited();
  await t.settle();
  assert.deepEqual(t.s(CHAT).pendingSwitch, mine);
});

test('a send that throws is noted, never thrown out of the timer', async () => {
  const boom = await rig({
    receipt: async () => {
      throw new Error('boom');
    },
  });
  await boom.limited();
  await boom.settle();
  const wait = await rig({
    to: null,
    resetAt: () => BASE + 1000,
    receipt: async () => {
      throw new Error('boom');
    },
  });
  await wait.limited();
  await wait.settle();
  clock.advance(1000 + RESET_GRACE_MS);
  await tick();
  assert.equal(wait.sent.length, 1);
});

test('the guard on the Continue fails once the owner is retired', async () => {
  const t = await rig();
  await t.limited();
  await t.settle();
  assert.doesNotThrow(() => assertInputCurrent(t.sent[0].item));
  t.limit.retire(CHAT);
  assert.throws(() => assertInputCurrent(t.sent[0].item));
});

test('a chat whose harness cannot be read is not marked, and an aborted service takes up nothing', async () => {
  const t = await rig();
  t.limit.controller = {
    ...t.c,
    ref: () => {
      throw new Error('gone');
    },
  };
  t.limit.hit('unknown-chat');
  assert.equal(t.limit.hits.size, 0);
  t.limit.controller = t.c;
  await t.limited();
  t.abort.abort();
  assert.equal(clock.pending, 0, 'abort retires every owner');
  t.limit.hit(CHAT);
  t.limit.finished({ chatId: CHAT, turnId: 'after' });
  await t.settle();
  assert.deepEqual(t.sent, []);
});

test('the service works without a signal of its own', () => {
  const h = setup();
  const limit = new LimitContinuation({
    controller: h.c,
    resumeEnabled: () => true,
    switchEnabled: () => false,
    exhausted: () => false,
    choose: async () => null,
    resetAt: () => null,
    send: async () => undefined,
  });
  assert.equal(limit.signal.aborted, false);
});

test('a limit that finishes after the turn id is unknown is still taken up once', async () => {
  const t = await rig();
  t.limit.hit(CHAT);
  t.limit.finished({ chatId: CHAT });
  t.limit.hit(CHAT);
  t.limit.finished({ chatId: CHAT });
  assert.equal(clock.pending, 1, 'two reports with no turn id are one limit');
});

/* ---- where the controller reports a limit ---------------------------------------------------------------------- */

async function running(kind: string) {
  const t = await rig({ kind });
  const hits: string[] = [];
  t.c.onLimit = ((prev) => (chatId: string) => (hits.push(chatId), prev(chatId)))(t.c.onLimit);
  t.c.send(CHAT, { text: 'work', opts: { human: true } }, null);
  await tick();
  return { ...t, hits };
}

test('Codex: usageLimitExceeded is a limit, a rate-limit pause and any other failure are not', async () => {
  for (const [info, hit] of [
    ['usageLimitExceeded', true],
    ['rateLimitExceeded', false],
    [undefined, false],
  ] as const) {
    const t = await running('codex');
    t.c.onCodexMessage(codex('turn/started', { threadId: 'native-thread', turn: { id: 'T' } }));
    t.c.onCodexMessage(
      codex('turn/completed', {
        threadId: 'native-thread',
        turn: { id: 'T', status: 'failed', ...(info ? { error: { codexErrorInfo: info } } : {}) },
      }),
    );
    assert.deepEqual(t.hits, hit ? [CHAT] : [], String(info));
    await t.settle();
    assert.equal(t.sent.length, hit ? 1 : 0, String(info));
  }
});

test('Codex: a Stop that carries the limit error is not a limit', async () => {
  const t = await running('codex');
  t.c.onCodexMessage(codex('turn/started', { threadId: 'native-thread', turn: { id: 'T' } }));
  t.c.onCodexMessage(
    codex('turn/completed', {
      threadId: 'native-thread',
      turn: { id: 'T', status: 'interrupted', error: { codexErrorInfo: 'usageLimitExceeded' } },
    }),
  );
  assert.deepEqual(t.hits, []);
});

test('ACP: a prompt that failed on a usage limit is one; a cancel or another failure is not', async () => {
  for (const [stopReason, error, hit] of [
    ['error', 'You have hit your usage limit', true],
    ['cancelled', 'You have hit your usage limit', false],
    ['error', 'the model fell over', false],
    ['end_turn', undefined, false],
  ] as const) {
    const t = await running('acp:kimi');
    t.c.onAcpEvent({ kind: 'turnStart', key: 'acp:kimi:native-acp', turnId: 'A' });
    t.c.onAcpEvent({ kind: 'turnEnd', key: 'acp:kimi:native-acp', turnId: 'A', stopReason, error });
    assert.deepEqual(t.hits, hit ? [CHAT] : [], `${stopReason} ${error}`);
  }
});

test('#4278: a chat on a machine that ran out there is not a limit this Mac goes on from', async () => {
  const t = await running('acp:kimi');
  t.c.onAcpEvent({ kind: 'turnStart', key: 'acp:kimi:native-acp', turnId: 'A' });
  t.c.onAcpEvent({
    kind: 'turnEnd',
    key: 'acp:kimi:native-acp',
    turnId: 'A',
    stopReason: 'error',
    error: 'You have hit your usage limit',
    turnErrorCode: 'rate_limit',
    onMachine: true,
  });
  assert.deepEqual(t.hits, []);
});

test('a harness that gives no receipt did not take the Continue', async () => {
  const t = await rig({ receipt: async () => undefined });
  await t.limited();
  await t.settle();
  assert.equal(t.sent.length, 1);
  assert.equal(t.s(CHAT).pendingSwitch, null);
});
