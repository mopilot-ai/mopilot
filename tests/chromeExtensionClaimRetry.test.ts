// A claim the native host handed over that fails to trade, or an answer that refused the host this time, is asked for again at once, not at the 30 s reconnect alarm (#2582).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { background, FakeWs, tick, until } from './support/extension-background/fixture.ts';
import { RECONNECT_ALARM } from './support/extension-background/fixture.ts';

const { ASK_AGAIN_MS, ASK_FOR_MS, CLAIM_TRIES, RETRY, askHost } = await import('../electron/chrome-extension/src/background.mjs');

const CLAIM = `mopilot-claim:1:47615:${'c'.repeat(32)}`;
const PAIRED = `mopilot-chrome:1:47615:${'S'.repeat(43)}`;

test('a failed claim trade asks the host again after ASK_AGAIN_MS and a good trade pairs', async () => {
  // the start waits for its first claim trade (ten fake seconds), so the trade is failed before it is awaited
  const started = background({ host: async () => ({ type: 'claim', code: CLAIM }) });
  await tick(5);
  const before = FakeWs.all.length;
  // the first trade fails (the app's socket is not taking connections yet): the host is asked again shortly
  FakeWs.all.at(-1)!.onclose();
  const { chrome, timers, warn } = await started;
  try {
    const asks = () => timers.timeouts.filter((t: any) => t.ms === ASK_AGAIN_MS);
    assert.equal(asks().length, 1, 'the next ask is scheduled, not left to the alarm');
    asks()[0].f();
    await tick(5);
    assert.ok(FakeWs.all.length > before, 'the second ask traded the claim again');
    // that trade works: the pairing is kept and no further ask is scheduled
    const ws = FakeWs.all.at(-1)!;
    await ws.from({ type: 'hello', protocol: 1, nonce: 'a'.repeat(32) });
    await ws.from({ type: 'paired', code: PAIRED });
    await tick(5);
    assert.equal(chrome.store.local.pairing, PAIRED);
    assert.equal(asks().length, 1);
  } finally {
    warn.mock.restore();
  }
});

test('a claim that never trades stops asking after CLAIM_TRIES', async () => {
  const started = background({ host: async () => ({ type: 'claim', code: CLAIM }) });
  await tick(5);
  FakeWs.all.at(-1)!.onclose();
  const { timers, warn } = await started;
  try {
    const asks = () => timers.timeouts.filter((t: any) => t.ms === ASK_AGAIN_MS);
    let scheduled = 0;
    for (let i = 0; i < CLAIM_TRIES + 2; i++) {
      const next = asks()[scheduled];
      if (!next) break;
      scheduled++;
      next.f();
      await tick(5);
      FakeWs.all.at(-1)!.onclose();
      await tick(5);
    }
    assert.equal(scheduled, CLAIM_TRIES - 1, 'the last failure waits for the reconnect alarm');
  } finally {
    warn.mock.restore();
  }
});

test('an empty answer ends the wait; PENDING keeps its single ask timer', async () => {
  let answer: any = { pending: true };
  const { timers, warn } = await background({ host: async () => answer });
  try {
    await tick(2);
    const asks = () => timers.timeouts.filter((t: any) => t.ms === ASK_AGAIN_MS);
    assert.equal(asks().length, 1);
    answer = null;
    asks()[0].f();
    await tick(2);
    assert.equal(asks().length, 1, 'an empty answer ends the wait');
  } finally {
    warn.mock.restore();
  }
});

test('askHost: a refused or failed check is RETRY, a plain none stays null', async () => {
  const via = (answer: any) => askHost({ runtime: { sendNativeMessage: async () => answer } }, { auto: true });
  assert.equal(await via({ type: 'refused', reason: 'the host was not started by Google Chrome' }), RETRY);
  assert.equal(await via({ type: 'error', reason: 'MoPilot could not check the host' }), RETRY);
  assert.equal(await via({ type: 'none', reason: 'MoPilot is not offering a pairing now' }), null);
});

test('a refused ask while the user answers asks again every ASK_AGAIN_MS, pairs on the next good answer, and gives up after ASK_FOR_MS', async () => {
  // the user's Allow came while Chrome was updating on disk: the check refused the host once, and the next ask must not wait for the alarm
  let now = 1_000;
  let answer: any = { type: 'refused', reason: 'the host was not started by Google Chrome' };
  let asked = 0;
  const { chrome, timers, warn } = await background({ host: async () => (asked++, answer), now: () => now });
  try {
    const asks = () => timers.timeouts.filter((t: any) => t.ms === ASK_AGAIN_MS);
    assert.equal(asks().length, 1, 'a refusal schedules the next ask, not the alarm');
    const fire = async () => {
      const t = asks()[0];
      timers.timeouts.splice(timers.timeouts.indexOf(t), 1);
      const before = asked;
      t.f();
      await until(() => asked === before + 1);
      await tick(2);
    };
    await fire();
    assert.equal(asks().length, 1, 'still refused: asked again');
    now += ASK_FOR_MS;
    await fire();
    assert.equal(asks().length, 0, 'ASK_FOR_MS after the first refusal it stops, and the alarm asks');
    // a later good answer starts a new run of retries from its own first refusal
    now += 1;
    answer = { type: 'refused' };
    chrome.alarms.onAlarm.fire({ name: RECONNECT_ALARM });
    await until(() => asked === 3);
    await tick(2);
    assert.equal(asks().length, 0, 'the budget of the first refusal is spent');
    answer = { type: 'none' };
    now += 1;
    chrome.alarms.onAlarm.fire({ name: RECONNECT_ALARM });
    await until(() => asked === 4);
    await tick(2);
    assert.equal(asks().length, 0, 'a plain none ends it');
  } finally {
    warn.mock.restore();
  }
});

test('a refusal keeps the page saying MoPilot is asking, and the next ask that is a claim pairs', async () => {
  const answers: any[] = [{ type: 'none', pending: true }, { type: 'refused' }, { type: 'claim', code: CLAIM }];
  const { chrome, timers, warn } = await background({ host: async () => answers.shift() });
  try {
    const asks = () => timers.timeouts.filter((t: any) => t.ms === ASK_AGAIN_MS);
    for (let i = 0; i < 2; i++) {
      await tick(5);
      const t = asks()[0];
      timers.timeouts.splice(timers.timeouts.indexOf(t), 1);
      t.f();
      await tick(5);
    }
    assert.equal(answers.length, 0);
    const ws = FakeWs.all.at(-1)!;
    await ws.from({ type: 'hello', protocol: 1, nonce: 'a'.repeat(32) });
    await ws.from({ type: 'paired', code: PAIRED });
    await tick(5);
    assert.equal(chrome.store.local.pairing, PAIRED);
  } finally {
    warn.mock.restore();
  }
});
