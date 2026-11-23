// A tool call's time spans (contract/callPhases.cjs) and the operation log entry that keeps them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const callPhases = require('../electron/capabilities/contract/callPhases.cjs');
const { Registry } = require('../electron/capabilities/contract/registry.cjs');

test('spans add up by name inside a collector, with their counts', async () => {
  const phases: Record<string, [number, number]> = {};
  await callPhases.within(phases, async () => {
    callPhases.note('a', 10);
    callPhases.note('a', 5.26);
    await callPhases.span(
      'b',
      async () => 1,
      () => 0,
    );
  });
  assert.deepEqual(phases, { a: [15.3, 2], b: [0, 1] });
});

test('a span outside a collector, or with a bad length, is dropped', async () => {
  callPhases.note('a', 10);
  const phases: Record<string, [number, number]> = {};
  callPhases.within(phases, () => {
    callPhases.note('a', -1);
    callPhases.note('a', Number.NaN);
  });
  assert.deepEqual(phases, {});
  // the default clock times a rejected span too, and rethrows
  await callPhases.within(phases, () =>
    assert.rejects(
      callPhases.span('c', () => Promise.reject(new Error('x'))),
      /x/,
    ),
  );
  assert.equal(phases.c[1], 1);
});

test('the operation log entry of a call carries its spans, and none when it had none', async () => {
  const r = new Registry({ screen: null });
  r.register({ name: 'plain', policy: 'observe', handler: () => 'ok' });
  r.register({
    name: 'acts',
    policy: 'act',
    handler: async () => {
      callPhases.note('helper:app.click', 7);
      return 'ok';
    },
  });
  r.setApprover(async () => true);
  assert.equal((await r.invoke('c', 's', 'plain', {})).ok, true);
  assert.equal((await r.invoke('c', 's', 'acts', {})).ok, true);
  const [plain, acts] = r.log.recent();
  assert.equal('phases' in plain, false);
  assert.deepEqual(Object.keys(acts.phases).sort(), ['approval', 'helper:app.click']);
  assert.deepEqual(acts.phases['helper:app.click'], [7, 1]);
});

test('a result screen is a span of the call', async () => {
  const r = new Registry({ screen: async (x: any) => x.content });
  r.register({ name: 'plain', policy: 'observe', handler: () => 'ok' });
  assert.equal((await r.invoke('c', 's', 'plain', {})).ok, true);
  assert.deepEqual(Object.keys(r.log.recent()[0].phases), ['screen']);
});

test('a call made without arguments still runs and logs its spans', async () => {
  const r = new Registry({ screen: null });
  r.register({ name: 'bare', policy: 'observe', handler: () => 'ok' });
  assert.equal((await r.invoke('c', 's', 'bare', undefined)).ok, true);
  assert.deepEqual(r.log.recent()[0].argKeys, []);
});
