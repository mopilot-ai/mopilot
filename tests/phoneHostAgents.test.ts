// What a Host reports of its agents, as the phone reads it over its own path (shared/remote/phoneHosts.mjs): ready, signed out or missing, and how long a report stands.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AGENTS_MS, AGENTS_RETRY_MS } from '../shared/remote/phoneHosts.mjs';
import { rig } from './support/phone/host-rig.ts';
import { waitFor } from './support/waitFor.ts';

test('the Host reports its agents: each as ready, signed out or missing (a missing one nobody runs left out, as on the Mac), an unknown id by its own name; a report stands for a minute and a silent Host keeps the last', async () => {
  let clock = 1_000;
  let harnesses: any = [
    { id: 'claude', detected: true, signedIn: true },
    { id: 'codex', detected: true, signedIn: false },
    { id: 'gemini', detected: false, signedIn: false },
    { id: 'acp:made-up', detected: true, signedIn: true },
  ];
  let fail = false;
  const r = rig({
    status: () => (fail ? { error: 'No.' } : { result: { harnesses } }),
    timers: { setInterval: () => 0, clearInterval: () => undefined, now: () => clock },
  });
  await r.phones.load();
  assert.equal(r.phones.agents('ssh:box'), null, 'nothing before the Host is read');
  // the cards are read first and answered; the agents are asked after, so a slow report never holds the cards back
  const again = async (until: () => boolean, label = new Error().stack!.split('\n')[2]) => {
    const ok = await r.settle(r.phones.refresh('ssh:box'));
    await waitFor(() => (r.pump(), until()), `the Host’s agents ${label}`);
    return ok;
  };
  assert.equal(await again(() => r.phones.agents('ssh:box') !== null), true);
  assert.deepEqual(
    r.phones.agents('ssh:box')!.map((a: any) => [a.id, a.label, a.state]),
    [
      ['claude', 'Claude Code', 'ready'],
      ['codex', 'Codex', 'signin'],
      ['acp:made-up', 'acp:made-up', 'ready'],
    ],
  );
  const asked = () => r.seen.filter((m) => m.method === 'host.status').length;
  assert.equal(asked(), 1);
  clock += AGENTS_MS - 1;
  await r.settle(r.phones.refresh('ssh:box'));
  assert.equal(asked(), 1, 'a report younger than a minute stands');
  clock += 1;
  harnesses = [{ id: 'codex', detected: true, signedIn: true }];
  await again(() => r.phones.agents('ssh:box')!.length === 1);
  assert.deepEqual(
    r.phones.agents('ssh:box')!.map((a: any) => [a.id, a.state]),
    [['codex', 'ready']],
  );
  clock += AGENTS_MS;
  fail = true;
  assert.equal(
    await again(() => r.phones.agentsFailure('ssh:box') === 'No.'),
    true,
    'a Host that cannot say its agents still gives its cards',
  );
  assert.equal(r.phones.agents('ssh:box')!.length, 1, 'the last report stays');
  assert.equal(r.phones.agentsFailure('ssh:box'), 'No.', 'and the caller can tell why it is not newer');
  assert.equal(asked(), 3);
  clock += AGENTS_RETRY_MS - 1;
  await r.settle(r.phones.refresh('ssh:box'));
  assert.equal(asked(), 3, 'a failed read is not asked again at once');
  clock += 1;
  await again(() => asked() === 4);
  assert.equal(asked(), 4, 'but soon');
  for (let i = 0; i < 5; i++) r.pump(), await new Promise((done) => setTimeout(done, 10));
  clock += AGENTS_MS;
  fail = false;
  harnesses = undefined;
  await again(() => r.phones.agentsFailure('ssh:box') === null);
  assert.deepEqual(r.phones.agents('ssh:box'), [], 'a report with no list says none');
  await r.phones.forget('ssh:box');
  assert.equal(r.phones.agents('ssh:box'), null, 'giving the path up forgets what the Host said');
  assert.equal(r.phones.agentsFailure('ssh:box'), null);
  assert.equal(r.phones.agentsFailure('nobody'), null);
});

test('a Host that cannot say its agents the first time has none to show, says why, and is asked again soon', async () => {
  let clock = 1_000;
  const r = rig({
    status: () => ({ error: 'Not now.' }),
    timers: { setInterval: () => 0, clearInterval: () => undefined, now: () => clock },
  });
  await r.phones.load();
  assert.equal(await r.settle(r.phones.refresh('ssh:box')), true, 'its cards are still read');
  await waitFor(() => (r.pump(), r.phones.agentsFailure('ssh:box') === 'Not now.'), 'the failure');
  assert.equal(r.phones.agents('ssh:box'), null);
  clock += AGENTS_RETRY_MS;
  await r.settle(r.phones.refresh('ssh:box'));
  await waitFor(() => (r.pump(), r.seen.filter((m) => m.method === 'host.status').length === 2), 'the second ask');
});

test('a signed-out ACP agent keeps the logins the Host lists on the phone’s own list, as host/src/harnessState.mjs reports them (#4861)', async () => {
  // the shape listHarnesses gives: `signIn` only on an installed ACP agent that cannot run without a login and lists some
  const harnesses = [
    { id: 'claude', detected: true, signedIn: true },
    { id: 'dsh', detected: true, signedIn: false },
    { id: 'kimi', detected: true, signedIn: false, signIn: ['login'] },
    { id: 'qwen', detected: true, signedIn: false, signIn: ['qwen-oauth', 'openai', 'anthropic', 'gemini'] },
    { id: 'gemini', detected: true, signedIn: false, signIn: ['oauth-personal', 'gemini-api-key'] },
  ];
  const r = rig({ status: () => ({ result: { harnesses } }) });
  await r.phones.load();
  await r.settle(r.phones.refresh('ssh:box'));
  await waitFor(() => (r.pump(), r.phones.agents('ssh:box') !== null), 'the Host’s agents');
  assert.deepEqual(
    r.phones.agents('ssh:box')!.map((a: any) => [a.id, a.reason]),
    [
      ['claude', ''],
      ['dsh', 'Sign in on build-box'],
      ['kimi', 'Sign in on build-box: login'],
      ['qwen', 'Sign in on build-box: qwen-oauth or openai or anthropic'],
      ['gemini', 'Sign in on build-box: oauth-personal or gemini-api-key'],
    ],
  );
});
