// The push controller and the phone's Live Activity: the activity follows the titles choice, `prefs.liveActivity` mirrors the activity's own switch (which a reinstall does not bring back), and nothing is written before the saved prefs are read.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_PREFS } from '../mobile/src/push/prefs';
import { createLiveActivity } from '../mobile/src/push/liveActivityController';
import { controllerRig, defer, tick } from './support/phone/push-controller-rig';

/** A stand-in for the activity controller: its own switch, what it was told, and listeners. */
function fakeActivity(enabled = false, loaded = true) {
  const calls: string[] = [];
  const listeners = new Set<() => void>();
  let on = enabled;
  let ready = loaded;
  const activity: any = {
    ui: () => ({ prefs: { enabled: on, titles: false }, status: 'off', failed: false, loaded: ready }),
    subscribe: (l: () => void) => (listeners.add(l), () => void listeners.delete(l)),
    setEnabled: async (next: boolean) => {
      calls.push(`enabled:${next}`);
      on = next;
      listeners.forEach((l) => l());
    },
    setTitles: async (next: boolean) => void calls.push(`titles:${next}`),
  };
  return {
    activity,
    calls,
    listeners,
    set: (next: boolean) => ((on = next), listeners.forEach((l) => l())),
    load: () => ((ready = true), listeners.forEach((l) => l())),
  };
}

test('the controller hands the activity to the page', async () => {
  const a = fakeActivity();
  const r = controllerRig({ liveActivity: a.activity });
  assert.equal(r.ctl.liveActivity, a.activity);
  assert.equal(controllerRig().ctl.liveActivity, undefined);
});

test('at start the activity follows the saved titles choice, and the saved liveActivity copy follows the activity, not the other way', async () => {
  // a reinstall: the keychain brings back liveActivity: true, the activity's own switch (app defaults) is off again
  const a = fakeActivity(false);
  const r = controllerRig({ liveActivity: a.activity });
  r.prefsBox.value = { ...DEFAULT_PREFS, liveActivity: true, titles: true };
  await r.ctl.start();
  assert.deepEqual(a.calls, ['titles:true']);
  assert.equal(r.ctl.ui().prefs.liveActivity, false, 'the page shows what is really on');
  assert.deepEqual(r.prefsBox.value.liveActivity, false);
  // the activity was not turned on by the old copy
  assert.equal(
    a.calls.some((c) => c === 'enabled:true'),
    false,
  );
});

test('nothing is written to the saved prefs before they are read', async () => {
  const a = fakeActivity(true);
  const r = controllerRig({ liveActivity: a.activity });
  const gate = defer();
  r.prefsBox.readGate = gate.promise;
  r.prefsBox.value = { ...DEFAULT_PREFS, sound: false, titles: true };
  const started = r.ctl.start();
  await tick();
  // the activity reports a change while the saved prefs are still being read
  a.set(false);
  a.set(true);
  assert.equal(
    r.log.some((l) => l.startsWith('prefs:')),
    false,
  );
  gate.resolve();
  await started;
  await tick();
  assert.equal(r.ctl.ui().prefs.sound, false, 'the saved choices were kept');
  assert.equal(r.ctl.ui().prefs.liveActivity, true);
  assert.equal(r.prefsBox.value.sound, false);
});

test('a change of the activity’s switch is mirrored once, with no loop', async () => {
  const a = fakeActivity(false);
  const r = controllerRig({ liveActivity: a.activity });
  await r.ctl.start();
  r.log.length = 0;
  a.calls.length = 0;
  a.set(true);
  await tick();
  assert.equal(r.ctl.ui().prefs.liveActivity, true);
  assert.equal(r.log.filter((l) => l.startsWith('prefs:')).length, 1);
  assert.deepEqual(a.calls, [], 'the mirror does not turn the activity on again');
  a.set(true);
  await tick();
  assert.equal(r.log.filter((l) => l.startsWith('prefs:')).length, 1);
});

test('a liveActivity change asked for through the prefs reaches the activity; one that already agrees does not', async () => {
  const a = fakeActivity(false);
  const r = controllerRig({ liveActivity: a.activity });
  await r.ctl.start();
  a.calls.length = 0;
  await r.ctl.setPrefs({ liveActivity: true });
  assert.deepEqual(a.calls, ['enabled:true']);
  await r.ctl.setPrefs({ liveActivity: true });
  assert.deepEqual(a.calls, ['enabled:true']);
  assert.equal(r.ctl.ui().prefs.liveActivity, true);
});

test('the titles choice reaches the activity when it changes, and only then', async () => {
  const a = fakeActivity();
  const r = controllerRig({ liveActivity: a.activity });
  await r.ctl.start();
  a.calls.length = 0;
  await r.ctl.setPrefs({ titles: true });
  await r.ctl.setPrefs({ titles: true });
  await r.ctl.setPrefs({ sound: false });
  await r.ctl.setPrefs({ titles: false });
  assert.deepEqual(a.calls, ['titles:true', 'titles:false']);
});

test('the activity is no longer followed after stop', async () => {
  const a = fakeActivity();
  const r = controllerRig({ liveActivity: a.activity });
  await r.ctl.start();
  assert.equal(a.listeners.size, 1);
  r.ctl.stop();
  assert.equal(a.listeners.size, 0);
});

test('a mirror write that waited behind a slow change never turns the activity back on against the person’s last tap', async () => {
  const a = fakeActivity(false);
  const r = controllerRig({ liveActivity: a.activity });
  await r.ctl.start();
  a.calls.length = 0;
  // a slow change holds the prefs chain
  const gate = defer();
  r.gate.disable = gate.promise;
  const slow = r.ctl.setPrefs({ enabled: false });
  await tick();
  a.set(true);
  a.set(false);
  gate.resolve();
  await slow;
  await tick();
  await tick();
  assert.deepEqual(
    a.calls.filter((c) => c.startsWith('enabled')),
    [],
    'the activity is as the person left it',
  );
  assert.equal(r.ctl.ui().prefs.liveActivity, false);
});

test('the mirror waits for the activity to load its own switch, and for the saved prefs to be read', async () => {
  const a = fakeActivity(true, false);
  const r = controllerRig({ liveActivity: a.activity });
  await r.ctl.start();
  assert.equal(
    r.log.some((l) => l.startsWith('prefs:')),
    false,
    'the activity has not said what it is yet',
  );
  a.load();
  await tick();
  assert.equal(r.ctl.ui().prefs.liveActivity, true);
  // saved prefs that could not be read are not replaced by defaults
  const b = fakeActivity(true);
  const broken = controllerRig({ liveActivity: b.activity });
  broken.prefsBox.readFails = true;
  await broken.ctl.start();
  b.set(true);
  await tick();
  assert.equal(
    broken.log.some((l) => l.startsWith('prefs:')),
    false,
  );
});

test('a change that could not be saved does not reach the activity', async () => {
  const a = fakeActivity(false);
  const r = controllerRig({ liveActivity: a.activity });
  await r.ctl.start();
  a.calls.length = 0;
  r.prefsBox.writeFails = true;
  await r.ctl.setPrefs({ liveActivity: true });
  await r.ctl.setPrefs({ titles: true });
  assert.deepEqual(a.calls, []);
});

test('after a reinstall (the keychain says on, the app defaults are empty) the real activity controller starts nothing and asks iOS nothing', async () => {
  const native: string[] = [];
  const stored = { value: null as string | null };
  const activity = createLiveActivity({
    native: {
      isEnabled: async () => (native.push('isEnabled'), true),
      start: async () => (native.push('start'), true),
      update: async () => void native.push('update'),
      stripTitles: async () => void native.push('strip'),
      end: async () => void native.push('end'),
      token: async () => null,
      setTitlesSwitch: async (on: boolean) => (native.push(`titles:${on}`), true),
      loadPrefs: async () => stored.value,
      savePrefs: async (raw: string) => void (stored.value = raw),
      onToken: () => () => {},
      onEnded: () => () => {},
    },
    relay: { register: async () => void native.push('relay.register'), unregister: async () => void native.push('relay.unregister') },
    store: {
      read: async () => (stored.value ? JSON.parse(stored.value) : { enabled: false, titles: false }),
      write: async (prefs) => void (stored.value = JSON.stringify(prefs)),
    },
    counts: async () => ({ needs: 2, running: 1 }),
    signedIn: () => true,
    foreground: () => () => {},
    account: () => () => {},
  });
  const r = controllerRig({ liveActivity: activity });
  r.prefsBox.value = { ...DEFAULT_PREFS, liveActivity: true, titles: true };
  await Promise.all([r.ctl.start(), activity.start()]);
  await tick();
  await tick();
  assert.equal(native.includes('start'), false, 'no activity starts');
  assert.equal(native.includes('isEnabled'), false, 'iOS is not asked, so no permission prompt can appear');
  assert.equal(native.includes('titles:true'), false, 'the widget is not told to read titles');
  assert.equal(r.ctl.ui().prefs.liveActivity, false, 'the page shows what is really on');
  assert.equal(r.prefsBox.value.liveActivity, false);
  assert.equal(r.ctl.ui().prefs.titles, true, 'the other choices are kept');
  // turning it on in this install does start it, and the page follows
  await activity.setEnabled(true);
  await tick();
  assert.equal(native.includes('start'), true);
  assert.equal(r.ctl.ui().prefs.liveActivity, true);
});
