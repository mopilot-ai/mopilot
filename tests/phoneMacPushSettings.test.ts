// The phone's client for the Mac's notification settings against the Mac's own schema and ops: what the phone sends the Mac accepts, what the phone refuses the Mac refuses, and what the Mac returns the phone reads.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { parseParams } from '../shared/remote/schema.mjs';
import '../tests/support/phone/register.ts';

// loaded after the native-module aliases are registered
const clientPath = '../mobile/src/remote/client.ts';
const macPath = '../mobile/src/push/macSettings.ts';
const { Unavailable } = await import(clientPath);
const { checkPatch, loadMacSettings, parseSettings, saveMacSettings } = await import(macPath);

const require = createRequire(import.meta.url);
const { createPushSettingsOps } = require('../electron/remote/pushSettingsOps.cjs');

/** A phone request wired straight to the Mac's real schema parser and settings ops. */
function mac(o: { flag?: boolean; momo?: boolean; prefs?: any } = {}) {
  const state = { prefs: o.prefs ?? {}, on: false, calls: [] as string[] };
  const ops = createPushSettingsOps({
    prefs: () => state.prefs,
    patchPrefs: (set: any) => (state.prefs = { ...state.prefs, ...set }),
    titles: () => ({
      get enabled() {
        return state.on;
      },
      setEnabled: async (on: boolean) => void (state.on = on),
    }),
    momoOn: () => o.momo !== false,
  });
  const request: any = async (method: string, params: any = {}) => {
    state.calls.push(method);
    if (method === 'machine.hello')
      return {
        capabilities: o.flag === false ? {} : { pushSettings: true, ...(o.momo !== false && { momo: true }) },
      };
    if (method === 'push.settings.get') return ops.get();
    return ops.set(parseParams(method, params));
  };
  return { request, state };
}

test('the phone reads the Mac defaults, and what is saved, as full settings', async () => {
  const fresh = mac();
  assert.deepEqual(await loadMacSettings(fresh.request), {
    titlesInPush: false,
    mode: 'unfocused',
    kinds: { turn: false, approval: true, scheduled: true, goal: false, auth: true, computer: true },
    quietHours: null,
    momoQuietHours: { start: '22:00', end: '07:00' },
    momo: true,
  });
  const saved = mac({ prefs: { notifyOnComplete: 'never', notifyKinds: { turn: false }, momo: { routines: { quietHours: null } } } });
  const s = await loadMacSettings(saved.request);
  assert.equal(s.mode, 'never');
  assert.equal(s.kinds.turn, false);
  assert.equal(s.kinds.goal, false);
  assert.equal(s.momoQuietHours, null);
});

test('every patch the phone builds is accepted by the Mac and comes back as the new settings', async () => {
  const m = mac();
  assert.equal((await saveMacSettings(m.request, { mode: 'always' })).mode, 'always');
  assert.equal((await saveMacSettings(m.request, { kinds: { goal: false } })).kinds.goal, false);
  assert.equal((await saveMacSettings(m.request, { kinds: { turn: false } })).kinds.goal, false, 'kinds merge into what is saved');
  assert.equal((await saveMacSettings(m.request, { titlesInPush: true })).titlesInPush, true);
  assert.deepEqual((await saveMacSettings(m.request, { momoQuietHours: { start: '23:00', end: '06:30' } })).momoQuietHours, {
    start: '23:00',
    end: '06:30',
  });
  assert.equal((await saveMacSettings(m.request, { momoQuietHours: null })).momoQuietHours, null);
});

test('what the phone refuses before asking, the Mac refuses too', () => {
  const bad: any[] = [
    {},
    { mode: 'sometimes' },
    { titlesInPush: 'yes' },
    { kinds: {} },
    { kinds: { nope: true } },
    { kinds: { turn: 'on' } },
    { momoQuietHours: { start: '22:00', end: '22:00' } },
    { momoQuietHours: { start: '25:00', end: '07:00' } },
    { momoQuietHours: { start: '22:00' } },
  ];
  for (const patch of bad) {
    assert.throws(() => checkPatch(patch), Error, JSON.stringify(patch));
    assert.throws(() => parseParams('push.settings.set', patch), Error, JSON.stringify(patch));
  }
});

test('a Mac that does not advertise the methods gets the update message; a MoMo-less account is told by the Mac', async () => {
  const old = mac({ flag: false });
  await assert.rejects(loadMacSettings(old.request), Unavailable);
  assert.deepEqual(old.state.calls, ['machine.hello']);
  const noMomo = mac({ momo: false });
  await assert.rejects(saveMacSettings(noMomo.request, { momoQuietHours: { start: '22:00', end: '07:00' } }));
});

test('an account MoMo is not on for gets no MoMo row: the Mac sends none, and an older Mac that does is not believed', async () => {
  const none = await loadMacSettings(mac({ momo: false }).request);
  assert.equal(none.momo, false);
  assert.equal(none.momoQuietHours, undefined);
  assert.ok(!('momo' in none.kinds));
  const ok = {
    titlesInPush: false,
    mode: 'unfocused',
    kinds: {},
    momoQuietHours: { start: '22:00', end: '07:00' },
  };
  assert.equal(parseSettings(ok, false).momoQuietHours, undefined, 'an older Mac still sends hours, hello says no MoMo');
  assert.equal(parseSettings({ titlesInPush: false, mode: 'unfocused' }).momoQuietHours, undefined, 'absent stays absent');
  assert.equal((await saveMacSettings(mac({ momo: false }).request, { mode: 'always' }, false)).momoQuietHours, undefined);
});

test('the phone reads a Mac answer defensively', () => {
  const ok = { titlesInPush: true, mode: 'needed', kinds: { turn: false, extra: true }, momoQuietHours: { start: '01:00', end: '02:00' } };
  assert.deepEqual(parseSettings(ok).kinds, {
    turn: false,
    approval: true,
    scheduled: true,
    goal: true,
    auth: true,
    computer: true,
  });
  assert.equal(parseSettings({ ...ok, kinds: undefined }).kinds.turn, true);
  assert.equal(parseSettings({ ...ok, momoQuietHours: { start: 'x', end: '02:00' } }).momoQuietHours, null);
  assert.equal(parseSettings({ ...ok, momoQuietHours: 'late' }).momoQuietHours, null);
  assert.equal(parseSettings(ok).quietHours, undefined, 'a Mac that says nothing of quiet hours has none to show');
  assert.deepEqual(parseSettings({ ...ok, quietHours: { start: '23:00', end: '06:00' } }).quietHours, { start: '23:00', end: '06:00' });
  assert.equal(parseSettings({ ...ok, quietHours: { start: '23', end: '06:00' } }).quietHours, null);
  for (const junk of [null, 'x', [], { ...ok, mode: 'loud' }, { ...ok, titlesInPush: 'yes' }])
    assert.throws(() => parseSettings(junk), /Could not read/);
});

test('the phone sets and clears the Mac’s quiet hours through the Mac’s own schema, and refuses what the Mac would', async () => {
  const m = mac({ momo: false });
  assert.deepEqual((await saveMacSettings(m.request, { quietHours: { start: '23:00', end: '06:30' } })).quietHours, {
    start: '23:00',
    end: '06:30',
  });
  assert.deepEqual(m.state.prefs.notifyQuietHours, { start: '23:00', end: '06:30' });
  assert.equal((await saveMacSettings(m.request, { quietHours: null })).quietHours, null);
  for (const bad of [{ start: '22:00', end: '22:00' }, { start: '25:00', end: '07:00' }, { start: '22:00' }])
    assert.throws(() => checkPatch({ quietHours: bad }), /two different times/);
});
