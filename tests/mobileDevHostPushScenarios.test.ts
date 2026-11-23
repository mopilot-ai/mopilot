// The bench scenarios that make the Mac push (scripts/mobile-dev-host/scenariosPush.mjs): titles and push-body take on or off, push and push-payload pass their arguments to the host's controls (a routine name may have spaces).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pushScenarios } from '../scripts/mobile-dev-host/scenariosPush.mjs';

test('each scenario names its usage and passes its arguments to the controls; on or off must be said', async () => {
  const calls: unknown[][] = [];
  const controls = {
    titles: async (on: boolean) => (calls.push(['titles', on]), 'titles done'),
    pushBody: (on: boolean) => (calls.push(['pushBody', on]), 'body done'),
    push: async (kind: string, chat: string, name?: string) => (calls.push(['push', kind, chat, name]), 'pushed'),
    pushPayload: (kind: string, chat: string, card?: string, name?: string) => (
      calls.push(['pushPayload', kind, chat, card, name]), 'payload'
    ),
  };
  const onOff = (arg: string | undefined, usage: string) => {
    if (arg !== 'on' && arg !== 'off') throw new Error(`Say on or off: run ${usage}`);
    return arg === 'on';
  };
  const all = pushScenarios({ need: () => controls, onOff }) as Record<
    string,
    { usage: string; about: string; run: (a: string[]) => unknown }
  >;
  assert.deepEqual(Object.keys(all), ['titles', 'push-body', 'push', 'push-payload']);
  for (const s of Object.values(all)) assert.ok(s.usage && s.about.length > 10);
  assert.equal(await all.titles.run(['on']), 'titles done');
  assert.equal(all['push-body'].run(['on']), 'body done');
  assert.equal(all['push-body'].run(['off']), 'body done');
  assert.throws(() => all['push-body'].run([]), /Say on or off: run push-body on\|off/);
  assert.equal(await all.push.run([]), 'pushed');
  assert.equal(await all.push.run(['momoNeedsYou', 'c1', 'Morning', 'brief']), 'pushed');
  assert.equal(all['push-payload'].run([]), 'payload');
  assert.equal(all['push-payload'].run(['momoNeedsYou', 'c1', 'k1', 'Morning', 'brief']), 'payload');
  assert.deepEqual(calls, [
    ['titles', true],
    ['pushBody', true],
    ['pushBody', false],
    ['push', 'needsYou', 'dev-seed-waiting', undefined],
    ['push', 'momoNeedsYou', 'c1', 'Morning brief'],
    ['pushPayload', 'needsYou', 'dev-seed-waiting', undefined, undefined],
    ['pushPayload', 'momoNeedsYou', 'c1', 'k1', 'Morning brief'],
  ]);
});
