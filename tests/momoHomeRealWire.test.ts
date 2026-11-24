// MoMo's real home over the Host's own wire rules (shared/momoHomeReal.mjs): every call passes the Host's veil as an owner desktop and is parsed as JSON, and the Hosts begin with no grant. The look answers without one; the app sends the grant for the signed-in account and the home then works, where a Host that veils the rest of MoMo says "Unknown request" until then.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world } from './support/momoHomeRealWorld.ts';

test('Hosts with no grant: the look answers, the app sends the real grant, and the first choice and a message go through the Host’s veil', async (t) => {
  const w = await world(t, { second: true, wire: true });
  assert.equal(w.a.home.granted(), false);
  const v = await w.view();
  assert.equal(v.setup.step, 'where', 'both Hosts said they hold none, without a grant');
  assert.deepEqual([...w.granted].sort(), ['mini', 'studio'], 'a look that says its grant lapsed is answered with the grant');
  assert.equal(w.a.home.granted(), true, 'the real Host holds it now');
  const made = await w.intent({ kind: 'choose-home', machineId: 'studio' });
  assert.equal(made.ok, true, JSON.stringify(made));
  assert.equal((await w.view()).home.machineName, 'Studio');
  const sent = await w.intent({ kind: 'send', turnId: 'turn-00000009', text: 'Hello' });
  assert.equal(sent.ok, true, JSON.stringify(sent));
});

test('a Host whose grant never comes back veils its start: the choice says why and nothing is made', async (t) => {
  const w = await world(t, { wire: true });
  w.overrides.set('studio', (method) => {
    if (method === 'host.momoGrant') throw new Error('The machine did not answer in time.');
    return undefined;
  });
  const done = await w.intent({ kind: 'choose-home', machineId: 'studio' });
  assert.equal(done.ok, false);
  assert.equal(w.a.home.status().home?.state ?? 'none', 'none');
});
