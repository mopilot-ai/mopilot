// Settings switches answer at once and never wait on another operation: a hung registration, relay or Mac cannot freeze them, and a refused change rolls back with a reason.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { controllerRig, defer } from './support/phone/push-controller-rig';
import { rig as activityRig } from './support/liveActivityRig.ts';
import { act, createElement, createRoot, flush, click, toggle } from './support/phone/component-kit';

// a variable path keeps the React Native sources out of the root type program (as phoneMacSettingsUi does)
const cardPath = '../mobile/src/push/MacNotificationSettings';
const { MacNotificationSettings } = await import(cardPath);

test('a registration call that never finishes does not hold back the next switch', async () => {
  const r = controllerRig();
  await r.ctl.start();
  r.log.length = 0;
  r.gate.disable = new Promise<void>(() => undefined);
  void r.ctl.setPrefs({ enabled: false });
  assert.equal(r.ctl.ui().prefs.enabled, false, 'shown at once');
  const titles = r.ctl.setPrefs({ skipOpenChat: false });
  assert.equal(r.ctl.ui().prefs.skipOpenChat, false, 'shown at once');
  await Promise.race([titles, new Promise((resolve) => setTimeout(resolve, 200))]);
  assert.ok(
    r.log.some((l) => l.startsWith('prefs:') && l.includes('"skipOpenChat":false')),
    'saved while the relay call hangs',
  );
  assert.equal(r.prefsBox.value.skipOpenChat, false);
});

test('a switch that cannot be saved rolls back and says why', async () => {
  const r = controllerRig();
  await r.ctl.start();
  r.prefsBox.writeFails = true;
  const pending = r.ctl.setPrefs({ titles: true });
  assert.equal(r.ctl.ui().prefs.titles, true, 'shown at once');
  await pending;
  assert.equal(r.ctl.ui().prefs.titles, false);
  assert.match(r.ctl.ui().prefsError ?? '', /Could not save/);
  r.prefsBox.writeFails = false;
  await r.ctl.setPrefs({ titles: true });
  assert.equal(r.ctl.ui().prefsError, null, 'the next successful change clears it');
});

test('the Live Activity switch moves at once and a stuck chat read cannot keep it from turning off', async () => {
  const r = activityRig({ prefs: { enabled: true, titles: false } });
  await r.activity.start();
  r.set.counts(null);
  const off = r.activity.setEnabled(false);
  assert.equal(r.activity.ui().prefs.enabled, false, 'shown before the save finishes');
  await off;
  assert.deepEqual(r.saved(), { enabled: false, titles: false });
});

test('a Live Activity task that never finishes is cut off, so turning the switch off still ends the activity', async () => {
  const r = activityRig({
    prefs: { enabled: true, titles: false },
    taskMs: 30,
    hangCounts: true,
  });
  const first = r.activity.start();
  await new Promise((resolve) => setTimeout(resolve, 80));
  await first;
  r.log.length = 0;
  await r.activity.setEnabled(false);
  assert.ok(r.only('end').length > 0, 'activity ended');
  assert.ok(r.only('relay.unregister').length > 0, 'relay token removed');
});

function macRig(over: { hold?: Promise<void>; refuse?: string } = {}) {
  const state: any = {
    titlesInPush: false,
    mode: 'unfocused',
    kinds: {},
    momoQuietHours: null,
    quietHours: null,
  };
  const runtime: any = {
    snapshot: () => ({ selectedPair: 'p', generation: 1 }),
    request: async (method: string, params: any) => {
      if (method === 'machine.hello') return { capabilities: { pushSettings: true } };
      if (method === 'push.settings.get') return { ...state };
      await over.hold;
      if (over.refuse) throw new Error(over.refuse);
      if (params.kinds) state.kinds = { ...state.kinds, ...params.kinds };
      return { ...state };
    },
  };
  return runtime;
}
async function mount(runtime: any) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(MacNotificationSettings, { runtime })));
  await flush();
  return async () => (await act(async () => root.unmount()), host.remove());
}

test('the computer’s switches move at once, stay usable while a save is out, and roll back with the reason on refusal', async () => {
  const hold = defer();
  const runtime = macRig({ hold: hold.promise });
  const unmount = await mount(runtime);
  assert.equal(toggle('Finished chats'), 'On');
  await click('Finished chats');
  assert.equal(toggle('Finished chats'), 'Off', 'shown before the Mac answers');
  const approvals = [...document.querySelectorAll('button[role="switch"]')].find(
    (e) => e.getAttribute('aria-label') === 'Approvals',
  ) as any;
  assert.ok(approvals && !approvals.disabled, 'other switches stay usable');
  hold.resolve();
  await flush();
  await unmount();

  const refusing = macRig({ refuse: 'unknown method' });
  const unmount2 = await mount(refusing);
  await click('Finished chats');
  await flush();
  assert.equal(toggle('Finished chats'), 'On', 'rolled back');
  assert.match(document.body.textContent!, /unknown method|Update MoPilot/);
  await unmount2();
});

test('a refused save names its reason when it has one and stays plain when it has none', async () => {
  const r = controllerRig();
  await r.ctl.start();
  r.prefsBox.writeFails = true;
  await r.ctl.setPrefs({ titles: true });
  assert.equal(r.ctl.ui().prefsError, 'Could not save this setting. It was put back. keychain full');
  r.prefsBox.writeError = 'not an Error';
  await r.ctl.setPrefs({ titles: true });
  assert.equal(r.ctl.ui().prefsError, 'Could not save this setting. It was put back.');
});

const macPath = '../mobile/src/push/macSettings';
const { applyPatch, revertPatch } = await import(macPath);

test('a computer patch is shown at once and only that patch is put back on refusal', () => {
  const base = {
    titlesInPush: false,
    mode: 'unfocused',
    kinds: { turn: true, approval: true },
    quietHours: { start: '22:00', end: '07:00' },
    momoQuietHours: null,
  };
  const patch = {
    titlesInPush: true,
    mode: 'always',
    kinds: { turn: false },
    quietHours: null,
    momoQuietHours: { start: '23:00', end: '06:00' },
  };
  const shown = applyPatch(base, patch);
  assert.deepEqual(shown, { ...base, ...patch, kinds: { turn: false, approval: true } });
  assert.deepEqual(applyPatch(base, { mode: 'never' }), { ...base, mode: 'never' });
  // a Mac without quiet hours has none to change
  const old = { ...base, quietHours: undefined };
  assert.equal(applyPatch(old, { quietHours: null }).quietHours, undefined);
  // another change made meanwhile survives the put-back
  const later = { ...shown, kinds: { turn: false, approval: false } };
  assert.deepEqual(revertPatch(later, base, patch), { ...base, kinds: { turn: true, approval: false } });
  assert.deepEqual(revertPatch(shown, base, { mode: 'always' }), { ...shown, mode: 'unfocused' });
});
