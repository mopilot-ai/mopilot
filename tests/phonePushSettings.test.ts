// Phone push settings through the controller: saved preferences, serialized changes, rollback and the switch.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_PREFS } from '../mobile/src/push/prefs';
import { chatRef } from '../mobile/src/push/chatRef';
import { controllerRig, defer, tick } from './support/phone/push-controller-rig';

test('settings: saved preferences load at start; a store that cannot be read keeps the defaults', async () => {
  const saved = controllerRig();
  saved.prefsBox.value = { ...DEFAULT_PREFS, sound: false };
  await saved.ctl.start();
  assert.equal(saved.ctl.ui().prefs.sound, false);
  const broken = controllerRig();
  broken.prefsBox.readFails = true;
  await broken.ctl.start();
  assert.deepEqual(broken.ctl.ui().prefs, DEFAULT_PREFS);
  assert.ok(broken.log.includes('enable'));
});

test('settings: turning notifications off removes the token and stays off; turning them on registers again', async () => {
  const r = controllerRig();
  await r.ctl.start();
  assert.equal(r.log.filter((l) => l === 'enable').length, 1);
  await r.ctl.setPrefs({ enabled: false });
  assert.deepEqual(r.log.slice(-2), [`prefs:${JSON.stringify({ ...DEFAULT_PREFS, enabled: false })}`, 'disable']);
  r.emit();
  await tick();
  assert.equal(r.log.filter((l) => l === 'enable').length, 1, 'no registration while off');
  await r.ctl.setPrefs({ enabled: true });
  assert.equal(r.log.filter((l) => l === 'enable').length, 2);
  r.log.length = 0;
  await r.ctl.setPrefs({ enabled: true });
  assert.equal(
    r.log.some((l) => l === 'enable' || l === 'disable'),
    false,
    'an unchanged switch does nothing',
  );
});

test('settings: an off switch at start registers nothing, and turning on without permission waits for permission', async () => {
  const off = controllerRig();
  off.prefsBox.value = { ...DEFAULT_PREFS, enabled: false };
  await off.ctl.start();
  assert.equal(off.log.includes('enable'), false);
  const explain = controllerRig({ step: 'explain' });
  await explain.ctl.start();
  await explain.ctl.setPrefs({ enabled: false });
  await explain.ctl.setPrefs({ enabled: true });
  assert.equal(explain.log.includes('enable'), false);
});

test('settings: sound and quiet hours are saved, invalid times are ignored, a failing store does not lose the change', async () => {
  const r = controllerRig();
  await r.ctl.start();
  await r.ctl.setPrefs({ sound: false });
  await r.ctl.setPrefs({ quiet: { on: true, from: '23:30', to: '06:15' } });
  await r.ctl.setPrefs({ quiet: { from: 'late', to: '25:61' } });
  assert.deepEqual(r.ctl.ui().prefs, { ...DEFAULT_PREFS, sound: false, quiet: { on: true, from: '23:30', to: '06:15' } });
  await r.ctl.setPrefs({ lockScreen: 'hide' });
  assert.equal(r.ctl.ui().prefs.lockScreen, 'hide');
  await r.ctl.setPrefs({ lockScreen: 'sideways' as never });
  assert.equal(r.ctl.ui().prefs.lockScreen, 'hide');
  assert.deepEqual(r.prefsBox.value, r.ctl.ui().prefs);
});

test('settings: a stored off switch survives a foreground that arrives before the preferences load', async () => {
  const r = controllerRig();
  r.prefsBox.value = { ...DEFAULT_PREFS, enabled: false };
  const hold = defer();
  r.prefsBox.readGate = hold.promise;
  const starting = r.ctl.start();
  r.handlers.fg();
  await tick();
  assert.equal(r.log.includes('enable'), false);
  hold.resolve();
  await starting;
  await tick();
  assert.equal(r.log.includes('enable'), false);
});

test('settings: quick off-then-on toggles run in order, so the token ends registered', async () => {
  const r = controllerRig();
  await r.ctl.start();
  r.log.length = 0;
  const hold = defer();
  r.gate.disable = hold.promise;
  const off = r.ctl.setPrefs({ enabled: false });
  const on = r.ctl.setPrefs({ enabled: true });
  await tick();
  assert.deepEqual(
    r.log.filter((l) => l === 'disable' || l === 'enable'),
    ['disable'],
  );
  hold.resolve();
  await Promise.all([off, on]);
  assert.deepEqual(
    r.log.filter((l) => l === 'disable' || l === 'enable'),
    ['disable', 'enable'],
  );
  assert.equal(r.ctl.ui().prefs.enabled, true);
});

test('settings: a change that cannot be saved is shown as it is stored and does not touch registration', async () => {
  const r = controllerRig();
  await r.ctl.start();
  r.log.length = 0;
  r.prefsBox.writeFails = true;
  await r.ctl.setPrefs({ enabled: false });
  assert.equal(r.ctl.ui().prefs.enabled, true);
  assert.equal(r.log.includes('disable'), false);
  await r.ctl.setPrefs({ sound: false });
  assert.equal(r.ctl.ui().prefs.sound, true);
});

test('the foreground policy skips only the open chat, only while it is open and the switch is on, and never the offline notice', async () => {
  const r = controllerRig({ pairs: ['p_a'] });
  await r.ctl.start();
  const here = { kind: 'needsYou', ref: chatRef('p_a', 'c1'), count: 1 } as const;
  const other = { kind: 'done', ref: chatRef('p_a', 'c2'), count: 1 } as const;
  assert.equal(r.ctl.present(here), true, 'no chat open: everything is announced');
  r.ctl.setOpenChat('p_a', 'c1');
  assert.equal(r.ctl.present(here), false, 'the chat being read is not announced');
  assert.equal(r.ctl.present(other), true, 'another chat is');
  assert.equal(r.ctl.present({ kind: 'machineOffline', ref: 'p_a', count: 1 }), false, 'the app already shows that the computer is away');
  await r.ctl.setPrefs({ skipOpenChat: false });
  assert.equal(r.ctl.present(here), true, 'with the switch off the open chat is announced too');
  await r.ctl.setPrefs({ skipOpenChat: true });
  r.ctl.setOpenChat('p_a', null);
  assert.equal(r.ctl.present(here), true, 'a pair without a chat is no open chat');
  r.ctl.setOpenChat(null, 'c1');
  assert.equal(r.ctl.present(here), true);
  r.ctl.setOpenChat('p_a', 'c1');
  r.ctl.setOpenChat(null, null);
  assert.equal(r.ctl.present(here), true, 'closing the chat ends the skip');
  r.ctl.setOpenChat('p_a', 'c1');
  await r.ctl.setPrefs({ enabled: false });
  assert.equal(r.ctl.present(other), false, 'notifications are off: nothing is drawn');
});

test('chat titles: turning them off removes the stored keys, a key that arrives while they are off is not kept, turning them on keeps what comes', async () => {
  const r = controllerRig({ pairs: ['p_a'] });
  r.prefsBox.value = { ...DEFAULT_PREFS, titles: true };
  await r.ctl.start();
  r.state.selectedPair = 'p_a';
  r.log.length = 0;
  await r.ctl.setPrefs({ sound: false });
  assert.equal(
    r.log.some((l) => l.startsWith('prune')),
    false,
    'other switches leave the keys alone',
  );
  await r.ctl.setPrefs({ titles: false });
  assert.ok(r.log.includes('prune:'), 'with titles off no key stays for the extension or the handler to open');
  r.log.length = 0;
  const key = 'ab'.repeat(32);
  r.handlers.event({ kind: 'event', ev: 'push.titleKey', patch: { key } });
  await tick();
  assert.equal(
    r.log.some((l) => l.startsWith('save')),
    false,
    'a key sent while titles are off is dropped',
  );
  await r.ctl.setPrefs({ titles: false });
  assert.equal(
    r.log.some((l) => l.startsWith('prune')),
    false,
    'off again changes nothing',
  );
  await r.ctl.setPrefs({ titles: true });
  r.handlers.event({ kind: 'event', ev: 'push.titleKey', patch: { key } });
  await tick();
  assert.equal(r.log.filter((l) => l.startsWith('save')).length, 1);
  assert.equal(
    r.log.some((l) => l.startsWith('prune')),
    false,
    'turning them on removes nothing',
  );
  r.prefsBox.writeFails = true;
  r.log.length = 0;
  await r.ctl.setPrefs({ titles: false });
  assert.equal(
    r.log.some((l) => l.startsWith('prune')),
    false,
    'a switch that was not saved is not acted on',
  );
});

test('the Live Activity and open-chat switches are saved with the other preferences', async () => {
  const r = controllerRig();
  await r.ctl.start();
  await r.ctl.setPrefs({ liveActivity: true });
  await r.ctl.setPrefs({ skipOpenChat: false });
  assert.deepEqual(r.ctl.ui().prefs, { ...DEFAULT_PREFS, liveActivity: true, skipOpenChat: false });
});

test('the test notification reports whether the phone handed it to the system', async () => {
  assert.equal(await controllerRig().ctl.sendTest(), false, 'no way to show one in this build');
  let shown = 0;
  const ok = controllerRig({ showTest: async () => void shown++ });
  assert.equal(await ok.ctl.sendTest(), true);
  assert.equal(shown, 1);
  const refused = controllerRig({
    showTest: async () => {
      throw new Error('not allowed');
    },
  });
  assert.equal(await refused.ctl.sendTest(), false);
});

test('title keys left from before are removed at start while titles are off, and keys that arrive before the saved choice is read wait for it', async () => {
  const off = controllerRig({ pairs: ['p_a'] });
  await off.ctl.start();
  assert.ok(off.log.includes('prune:'), 'with titles off no key outlives the start');
  const key = 'ab'.repeat(32);
  const early = (titles: boolean, fail = false) => {
    const r = controllerRig({ pairs: ['p_a'] });
    r.prefsBox.value = { ...DEFAULT_PREFS, titles };
    r.prefsBox.readFails = fail;
    r.state.selectedPair = 'p_a';
    const gate = defer();
    r.prefsBox.readGate = gate.promise;
    const started = r.ctl.start();
    r.handlers.event({ kind: 'event', ev: 'push.titleKey', patch: { key } });
    return { r, started, gate };
  };
  const on = early(true);
  assert.equal(
    on.r.log.some((l) => l.startsWith('save')),
    false,
    'not yet: the choice is not known',
  );
  on.gate.resolve();
  await on.started;
  await tick();
  assert.equal(on.r.log.filter((l) => l.startsWith('save')).length, 1, 'titles are on: the early key is kept');
  assert.equal(on.r.log.includes('prune:'), false);
  const no = early(false);
  no.gate.resolve();
  await no.started;
  await tick();
  assert.equal(
    no.r.log.some((l) => l.startsWith('save')),
    false,
    'titles are off: the early key is dropped',
  );
  const broken = early(true, true);
  broken.gate.resolve();
  await broken.started;
  await tick();
  assert.equal(
    broken.r.log.some((l) => l.startsWith('save')),
    false,
    'an unreadable choice is off',
  );
});
