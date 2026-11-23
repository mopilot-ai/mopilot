// Phone connection claims use per-phone relay presence, never the Mac's own transport, and retain saved pairings across restarts.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { rig as channelRig, pairing, wireOf, msg } from './support/remoteChannelRig.ts';
import { rig as alwaysOnRig } from './support/alwaysOnRig.ts';

const require = createRequire(import.meta.url);
const { createPhonePresence } = require('../electron/remote/phonePresence.cjs');
const { phoneDevices } = require('../electron/remote/phoneDevices.cjs');
const { register } = require('../electron/app/ipc/remoteSettings.cjs');
const { PHONE_CONNECTION_LABEL, phoneSummary } = await import('../shared/phoneConnections.mjs');
const { phoneLine } = await import('../src/components/pages/settings/phoneSeen.ts');

function settingsReader(remote: any) {
  const handlers = new Map<string, Function>();
  const events = new Map<string, Function>();
  const live = { remote, remoteConsent: { enabled: () => true }, mopilot: { creds: { user: { id: 'u' }, deviceId: 'mac' } } };
  register(
    { handle: (key: string, fn: Function) => handlers.set(key, fn), on: (key: string, fn: Function) => events.set(key, fn) },
    { live, allowed: () => true },
  );
  const sender = Object.assign(new EventEmitter(), { mainFrame: {}, isDestroyed: () => false });
  const event: any = { sender, senderFrame: sender.mainFrame };
  events.get('remoteSettings:document')!(event);
  return { live, read: () => handlers.get('remoteSettings:state')!(event, event.returnValue) };
}

test('an open Mac relay with an offline phone is not a connected phone', async (t) => {
  const r = await channelRig();
  const presence = createPhonePresence(r.relay);
  r.relay.emit('open', { peerEvents: true, pairs: [{ pair: r.phone.pairId, role: 'mac', peerOnline: false }] });
  const a = alwaysOnRig();
  a.live.remote = { ...r, presence, running: true };
  t.after(() => {
    a.alwaysOn.close();
    r.channel.stop();
  });
  assert.equal(r.channel.presence(r.phone.pairId), 'online', 'the transport can queue messages for an absent phone');
  assert.equal(a.alwaysOn.get().paired, 1);
  assert.equal(a.alwaysOn.get().connected, false, 'only the phone presence can establish a live connection');
});

test('Settings and the tray agree through relay loss, reconnect, channel pause, storage recovery and removal', async (t) => {
  const r = await channelRig();
  const presence = createPhonePresence(r.relay);
  const a = alwaysOnRig();
  a.live.remote = { ...r, presence, running: true };
  const settings = settingsReader(a.live.remote);
  t.after(() => {
    a.alwaysOn.close();
    r.channel.stop();
  });
  const check = (expected: string, paired = 1) => {
    const devices = settings.read().devices;
    assert.equal(devices[0].connection, expected);
    assert.equal(devices[0].online, expected === 'connected');
    assert.equal(a.alwaysOn.get().connected, expected === 'connected');
    assert.equal(a.alwaysOn.get().paired, paired);
    const submenu = a.alwaysOn.trayItems(() => {})[0].submenu;
    assert.equal(submenu[1].label, `${r.phone.record.name} — ${PHONE_CONNECTION_LABEL[expected]}`);
    assert.ok(phoneLine(devices[0], Date.now()).startsWith(PHONE_CONNECTION_LABEL[expected]));
    assert.equal(phoneSummary(devices), `${expected === 'connected' ? 1 : 0} connected · ${paired} paired`);
    assert.deepEqual(
      Object.keys(devices[0]).sort(),
      ['connection', 'frames', 'id', 'lastSeenAt', 'mirrors', 'name', 'online', 'pairId', 'pairedAt', 'retired'].sort(),
      'no pair keys or ratchet state reach either surface',
    );
  };
  check('unknown');
  const hello = { peerEvents: true, pairs: [{ pair: r.phone.pairId, role: 'mac', peerOnline: true }] };
  r.relay.emit('open', hello);
  check('connected');
  r.relay.emit('state', 'backoff');
  check('unknown');
  assert.equal(r.devices.list().length, 1, 'losing the relay does not remove a pairing');
  r.relay.emit('open', hello);
  check('connected');
  r.relay.emit('event', { ev: 'peer', pair: r.phone.pairId, online: false });
  check('offline');
  r.relay.emit('event', { ev: 'peer', pair: r.phone.pairId, online: true });
  r.channel.pauser.pause(r.channel.sessions.get(r.phone.pairId), 'storage');
  check('paused');
  r.relay.emit('open', hello);
  check('connected');
  r.devices.locked = true;
  check('locked');
  r.devices.locked = false;
  r.devices.retirePair(r.phone.pairId);
  check('removed', 0);
  settings.live.remote = null;
  a.live.remote = null;
  assert.deepEqual(settings.read().devices, []);
  assert.equal(a.alwaysOn.get().connected, false, 'an account switch cannot show an old account’s phone');
});

test('restart reloads the saved identity and last activity but waits for fresh presence', async (t) => {
  const r = await channelRig();
  await r.devices.rename(r.phone.record.id, 'Work phone');
  await r.devices.update(r.phone.record.id, { lastSeenAt: 1_700_000_000_000 });
  const before = phoneDevices({ ...r, presence: null });
  const next = await r.restart();
  const presence = createPhonePresence(next.relay);
  t.after(() => next.channel.stop());
  const remote = { ...next, presence };
  assert.deepEqual(phoneDevices(remote), before);
  assert.equal(phoneDevices(remote)[0].connection, 'unknown');
  next.relay.emit('open', { peerEvents: true, pairs: [{ pair: r.phone.pairId, role: 'mac', peerOnline: true }] });
  assert.equal(phoneDevices(remote)[0].connection, 'connected');
  assert.equal(phoneDevices(remote)[0].name, 'Work phone');
  assert.equal(phoneDevices(remote)[0].lastSeenAt, 1_700_000_000_000);
});

test('a failed removal that closes the channel keeps its saved pairing and explains recovery', async (t) => {
  const r = await channelRig();
  const presence = createPhonePresence(r.relay);
  const remote = { ...r, presence };
  const settings = settingsReader(remote);
  const a = alwaysOnRig();
  a.live.remote = { ...remote, running: true };
  t.after(() => {
    a.alwaysOn.close();
    r.channel.stop();
  });
  const hello = { peerEvents: true, pairs: [{ pair: r.phone.pairId, role: 'mac', peerOnline: true }] };
  r.relay.emit('open', hello);
  r.devices.o.safe.broken = true;
  const removing = r.devices.removePair(r.phone.record.id, r.phone.pairId);
  r.relay.emit('frame', wireOf(r.phone, msg('during-removal')));
  await assert.rejects(removing);
  r.devices.o.safe.broken = false;
  assert.equal(r.devices.isRetired(r.phone.pairId), false);
  assert.equal(r.devices.locked, false);
  assert.equal(r.channel.closedReason(r.phone.pairId), 'retired');
  await assert.rejects(r.channel.send(r.phone.pairId, msg('cannot-send')), /session is closed/);
  r.relay.emit('open', hello);
  const device = settings.read().devices[0];
  assert.equal(device.connection, 'closed', 'a live phone cannot make a terminal channel usable');
  assert.equal(device.online, false);
  assert.equal(phoneSummary([device]), '0 connected · 1 paired');
  assert.ok(phoneLine(device, Date.now()).startsWith('Restart MoPilot to reconnect'));
  assert.equal(a.alwaysOn.trayItems()[0].submenu[1].label, `${r.phone.record.name} — Restart MoPilot to reconnect`);
  const next = await r.restart();
  t.after(() => next.channel.stop());
  const nextPresence = createPhonePresence(next.relay);
  next.relay.emit('open', hello);
  assert.equal(phoneDevices({ ...next, presence: nextPresence })[0].connection, 'connected');
  await next.channel.send(r.phone.pairId, msg('after-restart'));
});

test('unavailable and empty state stay safe, with and without a menu action', () => {
  assert.deepEqual(phoneDevices(undefined), []);
  assert.deepEqual(phoneDevices({ devices: null }), []);
  const a = alwaysOnRig();
  assert.equal(a.alwaysOn.trayItems()[0].enabled, false);
  a.live.remote = { devices: { locked: true, list: () => [] } };
  const menu = a.alwaysOn.trayItems(() => {});
  assert.equal(menu[0].label, 'Phones · Needs attention');
  assert.equal(menu[0].submenu[0].label, 'Phone storage needs recovery');
  assert.equal(menu[0].submenu.at(-1).enabled, true);
});

test('the tray counts connected phones separately from saved pairings and offers inspection', async (t) => {
  const r = await channelRig({ phones: [pairing('Personal phone', 'p_personal'), pairing('Work phone', 'p_work')] });
  const presence = createPhonePresence(r.relay);
  r.relay.emit('open', { peerEvents: true, pairs: r.phones.map((p, i) => ({ pair: p.pairId, role: 'mac', peerOnline: i === 0 })) });
  const a = alwaysOnRig();
  a.live.remote = { ...r, presence, running: true };
  t.after(() => {
    a.alwaysOn.close();
    r.channel.stop();
  });
  let opens = 0;
  const menu = a.alwaysOn.trayItems(() => opens++);
  assert.equal(menu[0].label, 'Phones · 1 connected');
  assert.deepEqual(
    menu[0].submenu.map((item: any) => item.label ?? item.type),
    ['1 connected · 2 paired', 'Personal phone — Connected', 'Work phone — Offline', 'separator', 'Manage phones…'],
  );
  menu[0].submenu.at(-1).click();
  assert.equal(opens, 1);
});
