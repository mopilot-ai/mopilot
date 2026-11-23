// The dev host's stand-in for MoMo's suggestions (scripts/mobile-dev-host/fakeMomoSuggestions.mjs, `momo-suggestions [on|off|empty]`): the fake Mac keeps three made-up suggestions in the real store, a phone reads them and takes Add, Hide and Start through the Mac's own act, Start puts the first step into MoMo's fake chat as the user's message and is held while MoMo is paused, `empty` lists none and `off` is an older Mac that lists neither method.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startPhone, until } from './support/mobileStack.ts';
import { startHost } from '../scripts/mobile-dev-host/host.mjs';
import { createFakeSuggestions, SEEDS } from '../scripts/mobile-dev-host/fakeMomoSuggestions.mjs';
import { createControls } from '../scripts/mobile-dev-host/controls.mjs';
import { momoSuggestionsScenario } from '../scripts/mobile-dev-host/scenariosMomoSuggestions.mjs';

const scratch = mkdtempSync(path.join(tmpdir(), 'dev-host-sug-'));
after(() => rmSync(scratch, { recursive: true, force: true }));
const NOW = new Date(2026, 10, 16, 9, 0).getTime();

function fake(o: { paused?: boolean } = {}) {
  const told: string[] = [];
  const sent: string[] = [];
  const gate = { paused: o.paused ?? false };
  const s = createFakeSuggestions({
    now: () => NOW,
    changed: (a: string) => void told.push(a),
    send: async (text: string) => void sent.push(text),
    paused: () => gate.paused,
  });
  return { s, told, sent, gate };
}

test('on seeds three made-up suggestions, the best first, each with its source line; empty has none; both tell the phones', async () => {
  const { s, told } = fake();
  assert.deepEqual(((await s.list()) as any).suggestions, []);
  await s.setMode('on');
  const res: any = await s.list();
  assert.deepEqual([res.v, res.shown, res.now], [1, 6, NOW]);
  assert.equal(res.suggestions.length, SEEDS.length);
  assert.deepEqual(
    res.suggestions.map((x: any) => x.source),
    ['Your promise, Tuesday', 'Mail: Sam, Lease renewal', 'Calendar: Offsite, Thu 10:00'],
  );
  await s.setMode('empty');
  assert.deepEqual(((await s.list()) as any).suggestions, []);
  assert.deepEqual(told, ['memory', 'memory']);
});

test('Start sends the first step as MoMo’s message and takes the suggestion out; Add and Hide change the store; a gone one says so', async () => {
  const { s, sent, told } = fake();
  await s.setMode('on');
  const [a, b, c]: any[] = ((await s.list()) as any).suggestions;
  assert.deepEqual(await s.act(a.id, 'start'), { id: a.id, action: 'start', channel: 'main' });
  assert.deepEqual(sent, [`Start: ${a.title}\nFirst step: ${a.step}\n(From your suggestion, ${a.source})`]);
  await s.act(b.id, 'add');
  await s.act(c.id, 'hide');
  assert.deepEqual(
    ((await s.list()) as any).suggestions.map((x: any) => [x.id, x.status]),
    [[b.id, 'added']],
  );
  await assert.rejects(s.act('nope', 'hide'), (e: any) => e.code === 'failed' && /gone/.test(e.message));
  assert.equal(told.length, 4);
});

test('Start is held while MoMo is paused and the suggestion stays, with the Mac’s own words', async () => {
  const { s, sent } = fake({ paused: true });
  await s.setMode('on');
  const [a]: any[] = ((await s.list()) as any).suggestions;
  await assert.rejects(s.act(a.id, 'start'), (e: any) => e.code === 'forbidden' && /paused\. Resume it first/.test(e.message));
  assert.deepEqual(sent, []);
  assert.equal(((await s.list()) as any).suggestions.length, 3);
});

test('the scenario takes on, off or empty (on by default) and says what it did; anything else shows the usage', async () => {
  const seen: string[] = [];
  const sc = momoSuggestionsScenario(() => ({ momoSuggestions: (m: any) => (seen.push(m), `did ${m}`) }));
  assert.equal(sc.usage, 'momo-suggestions [on|off|empty]');
  assert.equal(sc.run([]), 'did on');
  assert.equal(sc.run(['off']), 'did off');
  assert.equal(sc.run(['empty']), 'did empty');
  assert.deepEqual(seen, ['on', 'off', 'empty']);
  assert.throws(() => sc.run(['maybe']), /momo-suggestions \[on\|off\|empty\]/);
});

test('the control sets the bench, asks the fake for on and empty only, and says whether MoMo itself is off', async () => {
  const asked: string[] = [];
  const bench: any = { momo: false, brain: false, tasks: true, voice: 'on' };
  const logs: string[] = [];
  const controls = createControls({
    bench,
    relayClient: () => null,
    cutMac: () => undefined,
    restartRelay: async () => undefined,
    devices: () => [],
    unpair: async () => true,
    changed: () => undefined,
    after: () => undefined,
    log: (l: string) => void logs.push(l),
    momoSwitched: () => undefined,
    momoSuggestions: async (m: string) => void asked.push(m),
    pushRequest: async () => 'ok',
    seal: () => null,
    setTitles: async () => undefined,
    chatTitle: () => null,
  } as any);
  assert.match(await controls.momoSuggestions('on'), /on \(three made-up suggestions in Up next\).*MoMo itself is off/);
  assert.match(await controls.momoSuggestions('empty'), /empty \(Up next has none\)/);
  bench.momo = true;
  assert.doesNotMatch(await controls.momoSuggestions('off'), /MoMo itself is off/);
  assert.deepEqual([bench.suggestions, asked], ['off', ['on', 'empty']]);
  assert.ok(
    logs.some((l) => /does not list momo\.suggestions/.test(l)) && logs.some((l) => /lists momo\.suggestions\.\*, with none/.test(l)),
  );
  // the default does nothing and never throws
  const plain = createControls({
    bench: { momo: true },
    log: () => undefined,
    changed: () => undefined,
    momoSwitched: () => undefined,
  } as any);
  assert.match(await plain.momoSuggestions('on'), /on/);
});

test('on a real phone the Mac lists the methods, Start puts the step into MoMo’s chat, empty lists none and off hides the methods', async () => {
  const lines: string[] = [];
  const host = await startHost({
    dir: path.join(scratch, 'host'),
    advertise: '127.0.0.1',
    bind: '127.0.0.1',
    port: 0,
    out: (l: string) => lines.push(l),
    sleep: async () => undefined,
  });
  after(() => host.stop());
  const relay = {
    wsUrl: host.relayUrl,
    keys: { sign: (_u: string, d: string, o?: { aud?: 'desktop' | 'relay' }) => host.account.sign(d, true, o?.aud ?? 'relay') },
  } as any;
  const phone = await startPhone(relay, { userId: 'dev-user', relayUrl: host.relayUrl });
  await phone.pair((await host.pair()).qr);
  await until(() => phone.snap().pairs.length === 1 && phone.snap().safetyNumber === null, 'the pair to commit');
  await phone.runtime.connect(phone.snap().pairs[0].pairId);
  await host.scenarios.run('momo', ['on']);
  const listed = async () =>
    (await phone.ask('machine.hello')).capabilities.methods.filter((m: string) => m.startsWith('momo.suggestions.'));
  assert.deepEqual(await listed(), ['momo.suggestions.list', 'momo.suggestions.act']);
  const first = (await phone.ask('momo.suggestions.list')).suggestions;
  assert.equal(first.length, 3);
  const started = await phone.ask('momo.suggestions.act', { id: first[0].id, action: 'start' });
  assert.equal(started.action, 'start');
  const chat = await phone.ask('momo.chat.follow', { items: 20 });
  // the fake MoMo answers it, quoting what it was sent
  assert.ok(chat.items.some((r: any) => /Start: Send the invoice/.test(r.text ?? '')));
  assert.equal((await phone.ask('momo.suggestions.list')).suggestions.length, 2);
  assert.match(await host.scenarios.run('momo-suggestions', ['empty']), /empty/);
  assert.equal((await phone.ask('momo.suggestions.list')).suggestions.length, 0);
  assert.match(await host.scenarios.run('momo-suggestions', ['off']), /off/);
  assert.deepEqual(await listed(), []);
  await assert.rejects(phone.ask('momo.suggestions.list'));
  assert.match(await host.scenarios.run('momo-suggestions', ['on']), /three made-up/);
  assert.equal((await phone.ask('momo.suggestions.list')).suggestions.length, 3);
});
