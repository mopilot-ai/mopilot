// The dev host's stand-in for a Mac that records MoMo's sent line late (scripts/mobile-dev-host/scenariosMomoEcho.mjs, `momo-late-echo [ms|off]`): the send is taken at once and recorded only after the delay.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { momoEchoScenario, withLateEcho, withMomoEcho } from '../scripts/mobile-dev-host/scenariosMomoEcho.mjs';

test('with a delay set the send is taken at once and recorded later; with none it is recorded at once', async () => {
  const recorded: string[] = [];
  const bench: { echoMs?: number } = {};
  const timers: [() => void, number][] = [];
  const momo = withLateEcho(
    { send: async (_chat: string, p: { id: string; text: string }) => void recorded.push(p.text) },
    bench,
    (fn, ms) => void timers.push([fn, ms]),
  );
  await momo.send('c', { id: '1', text: 'now' });
  assert.deepEqual(recorded, ['now']);
  bench.echoMs = 8000;
  assert.equal(await momo.send('c', { id: '2', text: 'late' }), null);
  assert.deepEqual(recorded, ['now'], 'taken, not recorded yet');
  assert.equal(timers[0][1], 8000);
  timers[0][0]();
  await Promise.resolve();
  assert.deepEqual(recorded, ['now', 'late']);
});

test('the default timer is a real, unreferenced one', async () => {
  const recorded: string[] = [];
  const momo = withLateEcho({ send: async (_c: string, p: { id: string; text: string }) => void recorded.push(p.text) }, { echoMs: 1 });
  await momo.send('c', { id: '1', text: 'soon' });
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(recorded, ['soon']);
});

test('momo-late-echo sets, defaults and clears the delay and refuses anything else', () => {
  const bench: { echoMs?: number } = {};
  const s = momoEchoScenario(bench);
  assert.match(s.run([]) as string, /8000 ms/);
  assert.equal(bench.echoMs, 8000);
  assert.match(s.run(['1500']) as string, /1500 ms/);
  assert.equal(bench.echoMs, 1500);
  assert.match(s.run(['off']) as string, /at once/);
  assert.equal(bench.echoMs, 0);
  for (const bad of ['x', '0', '-5', '1.5']) assert.throws(() => s.run([bad]), /Usage: momo-late-echo/);
});

test('withMomoEcho lists the scenario and runs it by name, leaving the others to the scenarios it wraps', () => {
  const bench: { echoMs?: number } = {};
  const ran: string[] = [];
  const wrapped = withMomoEcho(
    { list: () => [{ usage: 'a', about: 'A' }], run: (name: string, args: string[] = []) => void ran.push(`${name}:${args.join()}`) },
    bench,
  );
  assert.deepEqual(
    wrapped.list().map((x) => x.usage),
    ['a', 'momo-late-echo [ms|off]'],
  );
  wrapped.run('a', ['1']);
  assert.deepEqual(ran, ['a:1']);
  wrapped.run('momo-late-echo', ['250']);
  assert.equal(bench.echoMs, 250);
  wrapped.run('a');
  assert.deepEqual(ran, ['a:1', 'a:']);
});
