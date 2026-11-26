// MoMo's phone home screens stay invisible unless the account is invited and its computer serves them; the transport checks every answer before a screen sees it.
import assert from 'node:assert/strict';
import { test } from 'node:test';

const typesPath = '../mobile/src/momoPhone/types';
const gatePath = '../mobile/src/momoPhone/gate';
const transportPath = '../mobile/src/momoPhone/transport';
const fxPath = '../mobile/src/momoPhone/fixtures';
await import(typesPath); // the contract file holds types only; loading it keeps it in the coverage report
const { momoHomeAllowed, listsVoice, MOMO_VOICE_METHOD } = await import(gatePath);
const { createRuntimeTransport, parseHomeView, parseIntentResult, VIEW_METHOD, INTENT_METHOD, CHANGED_EVENT } = await import(transportPath);
const { fixtureShared } = await import(fxPath);

test('an uninvited account, or a computer that does not serve the home, sees nothing', () => {
  assert.equal(momoHomeAllowed({ capabilities: { momo: true, momoHome: true } }), true);
  // a Host's hello offers the home in its feature list: the same one rule reads both
  assert.equal(momoHomeAllowed({ capabilities: { momo: true }, features: ['momoHome'] }), true);
  assert.equal(momoHomeAllowed({ capabilities: { momo: true }, features: ['other'] }), false);
  for (const hello of [
    null,
    undefined,
    'x',
    {},
    { capabilities: {} },
    { capabilities: { momoHome: true } },
    { capabilities: { momo: false, momoHome: true } },
    { capabilities: { momo: true } },
    { capabilities: { momo: true, momoHome: 'yes' } },
    { capabilities: { momo: 'true', momoHome: true } },
  ]) {
    assert.equal(momoHomeAllowed(hello), false, JSON.stringify(hello));
  }
});

const reply = () => ({ view: fixtureShared() });

test('the view reply is read leniently: unknown states stay, missing parts are empty, only no home is no view', () => {
  const ok = parseHomeView(reply(), 7);
  assert.deepEqual([ok.now, ok.waking, ok.view.home.state], [7, false, 'running']);
  const { signals: _s, problems: _p, ...older } = fixtureShared();
  const filled = parseHomeView({ view: older }, 1).view;
  assert.deepEqual([filled.signals, filled.problems], [[], []]);
  // a newer home: a state this phone has never heard of is kept as it is
  const newer = fixtureShared() as Record<string, any>;
  newer.home.state = 'hibernating';
  assert.equal(parseHomeView({ view: newer }, 1).view.home.state, 'hibernating');
  // an older home leaves parts out: each is empty or the design's default, never a crash
  const bare = parseHomeView({ view: { home: { state: 'running' } } }, 1).view;
  assert.deepEqual(
    [
      bare.home.machines,
      bare.home.sources,
      bare.home.move,
      bare.home.movedAway,
      bare.home.homeMachineId,
      bare.chat,
      bare.tasks,
      bare.notes,
      bare.rules,
      bare.signals,
      bare.problems,
    ],
    [[], [], null, null, null, [], [], [], [], [], []],
  );
  assert.deepEqual([bare.setup.step, bare.settings.dailyCap, bare.settings.quietHours], ['done', 6, { from: '22:00', to: '08:00' }]);
  const odd = parseHomeView({ view: { home: { state: 'asleep', machines: 'x' }, setup: 3, settings: [], chat: {}, tasks: null } }, 1).view;
  assert.deepEqual([odd.home.machines, odd.setup.step, odd.settings.dailyCap, odd.chat, odd.tasks], [[], 'done', 6, [], []]);
  for (const value of [
    null,
    'x',
    [],
    {},
    { view: null },
    { view: [] },
    { view: {} },
    { view: { home: null } },
    { view: { home: { state: 3 } } },
  ]) {
    assert.throws(() => parseHomeView(value, 1), /Could not read MoMo\./);
  }
});

test('an intent answer is ok with the new view, or the real cause with a fix the user can tap', () => {
  assert.deepEqual(parseIntentResult({ ok: true }, 1), { ok: true });
  assert.equal(parseIntentResult({ ok: true, view: fixtureShared() }, 2).view.now, 2);
  assert.deepEqual(parseIntentResult({ ok: false, cause: 'Studio is asleep.', fix: { kind: 'wake' }, fixLabel: 'Wake Studio' }, 1), {
    ok: false,
    cause: 'Studio is asleep.',
    fix: { kind: 'wake' },
    fixLabel: 'Wake Studio',
  });
  assert.deepEqual(parseIntentResult({ ok: false, cause: 'No.', fix: { kind: 'wake' } }, 1), { ok: false, cause: 'No.' });
  assert.deepEqual(parseIntentResult({ ok: false, cause: 'No.', fix: 'wake', fixLabel: 'x' }, 1), { ok: false, cause: 'No.' });
  assert.equal(parseIntentResult({ ok: false }, 1).cause, 'MoMo could not do that.');
  assert.equal(parseIntentResult({ ok: false, cause: '' }, 1).cause, 'MoMo could not do that.');
  for (const value of [null, 'x', {}, { ok: 'yes' }]) assert.throws(() => parseIntentResult(value, 1), /Could not read the answer\./);
});

test('the transport asks the computer for the view and each intent, and turns its change event into a patch', async () => {
  const calls: [string, unknown][] = [];
  let listener: ((e: { ev?: string }) => void) | null = null;
  let removed = 0;
  const transport = createRuntimeTransport(
    {
      async request(method: string, params: unknown) {
        calls.push([method, params]);
        return method === VIEW_METHOD ? reply() : { ok: true };
      },
      onEvent(l: (e: { ev?: string }) => void) {
        listener = l;
        return () => removed++;
      },
    },
    () => 9,
  );
  assert.equal((await transport.load()).now, 9);
  assert.deepEqual((await transport.send({ kind: 'wake' })).ok, true);
  assert.deepEqual(calls, [
    [VIEW_METHOD, {}],
    [INTENT_METHOD, { intent: { kind: 'wake' } }],
  ]);
  const seen: object[] = [];
  const off = transport.subscribe((p: object) => seen.push(p));
  listener!({ ev: 'something.else' });
  listener!({ ev: CHANGED_EVENT });
  listener!({ ev: CHANGED_EVENT, ...reply() });
  assert.equal(seen.length, 1);
  assert.equal((seen[0] as { now: number }).now, 9);
  off();
  assert.equal(removed, 1);
});

test('a computer lists the voice method or it does not', () => {
  assert.equal(MOMO_VOICE_METHOD, 'momo.chat.transcribe');
  assert.equal(listsVoice({ capabilities: { methods: ['a', MOMO_VOICE_METHOD] } }), true);
  for (const hello of [
    null,
    undefined,
    {},
    { capabilities: {} },
    { capabilities: { methods: 'x' } },
    { capabilities: { methods: ['a'] } },
  ]) {
    assert.equal(listsVoice(hello), false, JSON.stringify(hello));
  }
});
