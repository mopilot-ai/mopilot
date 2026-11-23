// Independent reset/switch settings gate the real usage-limit controller across harnesses and pending work.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { tick } from './support/controller/fixture.ts';
import { rig, clock, CHAT, BASE, SEGMENTS } from './support/limit-continuation-harness.ts';

const require = createRequire(import.meta.url);
const { RESET_GRACE_MS } = require('../electron/session/limitContinue.cjs');
const { assertInputCurrent } = require('../electron/session/contract/inputGuard.cjs');

test('reset continuation and harness switching are independent on every harness', async () => {
  for (const kind of Object.keys(SEGMENTS)) {
    for (const enabled of [false, true]) {
      for (const switchEnabled of [false, true]) {
        const at = clock.now() + 60_000;
        const t = await rig({ kind, enabled, switchEnabled, resetAt: () => at });
        await t.limited();
        await t.settle();
        assert.equal(t.chosen.length, Number(switchEnabled), `${kind}: only the switch preference chooses another harness`);
        assert.equal(t.sent.length, Number(switchEnabled));
        clock.advance(60_000 + RESET_GRACE_MS);
        await tick();
        assert.equal(t.sent.length, Number(enabled || switchEnabled));
        if (!switchEnabled && enabled) assert.equal(t.sent[0].ps, null, 'a quota reset keeps the current harness');
        t.abort.abort();
      }
    }
  }
});

test('switching alone never schedules a quota reset when no other harness can run', async () => {
  const t = await rig({ enabled: false, switchEnabled: true, to: null, resetAt: () => clock.now() + 60_000 });
  await t.limited();
  await t.settle();
  assert.equal(t.chosen.length, 1);
  assert.equal(clock.pending, 0);
  assert.deepEqual(t.sent, []);
});

test('a source account regaining quota while the destination is chosen prevents the switch', async () => {
  const t = await rig();
  let exhausted = true;
  t.limit.exhausted = () => exhausted;
  t.limit.choose = async () => {
    exhausted = false;
    return 'claude';
  };
  await t.limited();
  await t.settle();
  assert.deepEqual(t.sent, []);
  assert.equal(t.s(CHAT).pendingSwitch, null);
});

test('turning off switching during a harness lookup keeps reset continuation independent', async () => {
  for (const enabled of [false, true]) {
    const at = clock.now() + 60_000;
    const t = await rig({ enabled, resetAt: () => at });
    let chosen!: (harness: string) => void;
    t.limit.choose = () => new Promise((resolve) => (chosen = resolve));
    await t.limited();
    await t.settle();
    t.settings.switchEnabled = false;
    chosen('claude');
    await tick();
    assert.deepEqual(t.sent, []);
    assert.equal(t.s(CHAT).pendingSwitch, null);
    clock.advance(60_000 + RESET_GRACE_MS);
    await tick();
    assert.equal(t.sent.length, Number(enabled));
    t.abort.abort();
  }
});

test('turning off reset continuation while waiting prevents resuming even with switching enabled', async () => {
  const t = await rig({ to: null, resetAt: () => BASE + 60_000 });
  await t.limited();
  await t.settle();
  t.settings.enabled = false;
  clock.advance(60_000 + RESET_GRACE_MS);
  await tick();
  assert.deepEqual(t.sent, []);
  assert.equal(clock.pending, 0);
});

test('a queued continuation checks its own setting again before dispatch', async () => {
  for (const mode of ['switch', 'reset']) {
    const t = await rig({ to: mode === 'switch' ? 'claude' : null, resetAt: () => BASE });
    await t.limited();
    await t.settle();
    if (mode === 'reset') {
      clock.advance(RESET_GRACE_MS);
      await tick();
    }
    const item = t.sent[0].item;
    assert.doesNotThrow(() => assertInputCurrent(item));
    if (mode === 'switch') t.settings.switchEnabled = false;
    else t.settings.enabled = false;
    assert.throws(() => assertInputCurrent(item));
    t.abort.abort();
  }
});
