// Remote Run P6, the unit-level run of the Host path with fakes: a real Host process over the fake ACP agent, a local relay, and a fake
// phone that enrolls and answers through it. The app is killed once the agent has raised its card, so only the phone can answer, and the
// agent goes on. tests/support/hostPhoneKit.ts is the scenario; scripts/host-phone-check.mjs runs this file for the VM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runHostPhoneScenario } from './support/hostPhoneKit.ts';

test('the app is killed, the agent raises a card, the phone answers through the relay and the agent continues', async (t) => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hp-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const r = await runHostPhoneScenario(base);
  t.after(() => r.close());
  assert.deepEqual(r.answered, { replayed: false, result: { answered: true } });
  assert.equal(r.turn.text, 'fake-acp: PERMIT it');
  assert.equal(r.turn.state, 'ended');
  assert.equal(r.turn.stopReason, 'end_turn');
  assert.deepEqual(r.left, [], 'the answered card is gone from the Host');
  let before = 0;
  for (const [step, at] of Object.entries(r.timings)) {
    console.log(`host-phone: ${step.padEnd(16)} ${String(at).padStart(6)} ms (+${at - before})`);
    before = at;
  }
  const steps = ['hostUp', 'phoneEnrolled', 'appKilled', 'phoneConnected', 'cardSeen', 'answered', 'agentContinued'];
  assert.deepEqual(Object.keys(r.timings), steps);
  steps.reduce((before, step) => (assert.ok(r.timings[step] >= before, `${step} comes after the step before it`), r.timings[step]), 0);
});
