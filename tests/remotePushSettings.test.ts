// A phone reads and changes the Mac's notification settings (electron/remote/methods/push.cjs, pushSettingsOps.cjs, the push.settings.* schema): the same prefs Settings writes, titles in push through the remote's switch, MoMo's quiet hours read-only, phone-only, and every bad input refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { rig } from './support/remote-kit.ts';
import { parseParams } from '../shared/remote/schema.mjs';

const require = createRequire(import.meta.url);
const { createPushSettingsOps, pushSettingsFor } = require('../electron/remote/pushSettingsOps.cjs');

const ok = (r: any) => (assert.equal(r.ok, true, JSON.stringify(r.error)), r.result);
const fail = (r: any, code: string) => (assert.equal(r.ok, false), assert.equal(r.error.code, code, r.error.message));

function ops(o: { prefs?: any; titles?: any; saves?: boolean; momo?: boolean } = {}) {
  const state = { prefs: o.prefs ?? {}, patches: [] as any[], on: false };
  const titles =
    o.titles === null
      ? null
      : {
          get enabled() {
            return state.on;
          },
          setEnabled: async (on: boolean) => void (state.on = on),
        };
  return {
    state,
    ops: createPushSettingsOps({
      prefs: () => state.prefs,
      patchPrefs: (set: any) => (state.patches.push(set), o.saves === false ? null : (state.prefs = { ...state.prefs, ...set })),
      titles: () => titles,
      momoOn: () => o.momo !== false,
    }),
  };
}

test('get returns the defaults of a fresh Mac, and what is saved', async () => {
  const a = ops();
  assert.deepEqual(a.ops.get(), {
    titlesInPush: false,
    mode: 'unfocused',
    kinds: { turn: false, goal: false },
    quietHours: null,
    momoQuietHours: { start: '22:00', end: '07:00' },
  });
  const b = ops({ prefs: { notifyOnComplete: 'never', notifyKinds: { turn: false }, momo: { routines: { quietHours: null } } } });
  assert.deepEqual(b.ops.get(), {
    titlesInPush: false,
    mode: 'never',
    kinds: { turn: false, goal: false },
    quietHours: null,
    momoQuietHours: null,
  });
  assert.equal(ops({ prefs: { notifyOnComplete: 'loud' } }).ops.get().mode, 'unfocused');
  assert.equal(ops({ titles: null }).ops.get().titlesInPush, false);
});

test('set saves the mode and merges the kinds into what is saved, and returns the new settings', async () => {
  const a = ops({ prefs: { notifyKinds: { turn: false } } });
  const out = await a.ops.set({ mode: 'needed', kinds: { goal: false } });
  assert.deepEqual(a.state.patches, [{ notifyOnComplete: 'needed', notifyKinds: { turn: false, goal: false } }]);
  assert.deepEqual([out.mode, out.kinds], ['needed', { turn: false, goal: false }]);
});

test('a switch saved for the retired pull request kind is neither shown to the phone nor kept by its changes (#3661)', async () => {
  const a = ops({ prefs: { notifyKinds: { turn: false, pr: false } } });
  assert.deepEqual(a.ops.get().kinds, { turn: false, goal: false });
  await a.ops.set({ kinds: { goal: false } });
  assert.deepEqual(a.state.patches, [{ notifyKinds: { turn: false, goal: false } }]);
  assert.throws(() => parseParams('push.settings.set', { kinds: { pr: true } }), /known kind/);
});

test("titles in push go through the remote's switch, which needs Mobile Remote running; nothing is saved for it", async () => {
  const a = ops();
  const out = await a.ops.set({ titlesInPush: true });
  assert.equal(out.titlesInPush, true);
  assert.deepEqual(a.state.patches, []);
  const off = ops({ titles: null });
  await assert.rejects(off.ops.set({ titlesInPush: true }), /not running/);
});

test('an account MoMo is not allowed for is sent no MoMo field: no quiet hours, no momo kind', () => {
  const a = ops({
    momo: false,
    prefs: { notifyKinds: { momo: false, turn: true } },
  }).ops.get();
  assert.ok(!('momoQuietHours' in a));
  assert.ok(!('momo' in a.kinds));
  assert.equal(a.kinds.turn, true);
  const b = ops({ prefs: { notifyKinds: { momo: false } } }).ops.get();
  assert.equal(b.kinds.momo, false, 'an invited account keeps its switch');
  assert.ok('momoQuietHours' in b);
});

test('a refused patch changes nothing: titles are not switched when the quiet hours are refused or the save fails', async () => {
  const a = ops({ momo: false });
  await assert.rejects(a.ops.set({ titlesInPush: true, momoQuietHours: null }), /not on for this account/);
  assert.equal(a.state.on, false);
  const b = ops({ saves: false });
  await assert.rejects(b.ops.set({ titlesInPush: true, mode: 'always' }), /could not be saved/);
  assert.equal(b.state.on, false);
});

test('a save that did not happen is an error, not a success', async () => {
  const a = ops({ saves: false });
  await assert.rejects(a.ops.set({ mode: 'always' }), /could not be saved/);
});

test('the schema accepts a good patch and refuses an empty or bad one', () => {
  assert.deepEqual(parseParams('push.settings.set', { titlesInPush: false, mode: 'always', kinds: { turn: true } }), {
    titlesInPush: false,
    mode: 'always',
    kinds: { turn: true },
  });
  assert.deepEqual(parseParams('push.settings.get', {}), {});
  for (const bad of [
    {},
    { titlesInPush: 'yes' },
    { mode: 'loud' },
    { kinds: {} },
    { kinds: { nope: true } },
    { kinds: { turn: 'on' } },
    { kinds: null },
    { surprise: 1 },
    { mode: 'always', surprise: 1 },
    { momoQuietHours: { start: '25:00', end: '07:00' } },
    { momoQuietHours: { start: '22:00', end: '22:00' } },
    { momoQuietHours: 'night' },
    { quietHours: { start: '25:00', end: '07:00' } },
    { quietHours: { start: '22:00', end: '22:00' } },
    { quietHours: 'night' },
  ])
    assert.throws(
      () => parseParams('push.settings.set', bad),
      (e: any) => e.code === 'invalid',
      JSON.stringify(bad),
    );
});

test('MoMo quiet hours: a phone sets or clears them for an account MoMo is on for, others are refused', async () => {
  const a = ops({ prefs: { momo: { paused: false } } });
  const out = await a.ops.set({ momoQuietHours: { start: '23:00', end: '06:30' } });
  assert.deepEqual(out.momoQuietHours, { start: '23:00', end: '06:30' });
  assert.equal(a.state.patches[0].momo.paused, false, "the rest of MoMo's prefs stays");
  assert.equal((await a.ops.set({ momoQuietHours: null })).momoQuietHours, null);
  await assert.rejects(ops({ momo: false }).ops.set({ momoQuietHours: null }), /not on for this account/);
  await assert.rejects(a.ops.set({ momoQuietHours: { start: '07:00', end: '07:00' } }), /valid value/);
  assert.deepEqual(parseParams('push.settings.set', { momoQuietHours: null }), { momoQuietHours: null });
  assert.deepEqual(parseParams('push.settings.set', { momoQuietHours: { start: '22:00', end: '07:00', x: 1 } }), {
    momoQuietHours: { start: '22:00', end: '07:00' },
  });
});

test("with no prefs at all the defaults read and a kind switch saves alone; the late-bound ops read main's live", async () => {
  const patches: any[] = [];
  const bare = createPushSettingsOps({
    prefs: () => null,
    patchPrefs: (set: any) => (patches.push(set), set),
    titles: () => null,
    momoOn: () => true,
  });
  assert.equal(bare.get().mode, 'unfocused');
  await bare.set({ kinds: { turn: false } });
  assert.deepEqual(patches, [{ notifyKinds: { turn: false } }]);
  const saved: any[] = [];
  const live: any = { patchPrefs: (set: any) => (saved.push(set), set), remote: null };
  const bound = pushSettingsFor({ live, prefs: () => ({}), momoOn: () => true });
  assert.equal(bound.get().titlesInPush, false);
  await bound.set({ mode: 'never' });
  assert.deepEqual(saved, [{ notifyOnComplete: 'never' }]);
  live.remote = { pushTitles: { enabled: true, setEnabled: async () => undefined } };
  assert.equal(bound.get().titlesInPush, true);
});

test('through the service: a phone gets and sets them, the panel cannot, and an unready Mac says so', async () => {
  const r = rig();
  const a = ops();
  r.service.pushSettings = a.ops;
  const p = r.phone('p1');
  assert.equal(ok(await p.ask('push.settings.get')).mode, 'unfocused');
  assert.equal(ok(await p.ask('push.settings.set', { mode: 'never' })).mode, 'never');
  fail(await p.ask('push.settings.set', { mode: 'loud' }), 'invalid');
  assert.ok(r.service.methodsFor({ kind: 'phone', pairId: 'p1' } as any).includes('push.settings.get'));
  assert.equal(r.service.methodsFor({ kind: 'panel' } as any).includes('push.settings.get'), false);
  assert.equal(ok(await p.ask('machine.hello')).capabilities.pushSettings, true);
  r.service.pushSettings = null;
  assert.equal(ok(await p.ask('machine.hello')).capabilities.pushSettings, false);
  fail(await p.ask('push.settings.get'), 'failed');
});

test('quiet hours: a phone sets or clears the Mac’s notification quiet hours, for any account, and the Mac reads only valid ones back', async () => {
  const a = ops({ momo: false, prefs: { momo: { paused: false } } });
  const out = await a.ops.set({ quietHours: { start: '23:00', end: '06:30' } });
  assert.deepEqual(out.quietHours, { start: '23:00', end: '06:30' });
  assert.deepEqual(a.state.patches[0], { notifyQuietHours: { start: '23:00', end: '06:30' } });
  assert.equal((await a.ops.set({ quietHours: null })).quietHours, null);
  assert.equal(a.state.patches[1].notifyQuietHours, null);
  assert.equal(
    ops({ prefs: { notifyQuietHours: { start: '9:00', end: '07:00' } } }).ops.get().quietHours,
    null,
    'a damaged saved value reads as none',
  );
  assert.deepEqual(parseParams('push.settings.set', { quietHours: null }), { quietHours: null });
  assert.deepEqual(parseParams('push.settings.set', { quietHours: { start: '22:00', end: '07:00', x: 1 } }), {
    quietHours: { start: '22:00', end: '07:00' },
  });
});
