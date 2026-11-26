// Mobile Remote end to end, scenario 8: the Mac's per-device Terminal-and-screen switch. It is off by default, nothing runs while it is off (no folder lookup, no approval card, no shell, no capture), and turning it on or off takes effect for that device only, also for a mirror already running.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRelay, startMac, startPhone, until, phoneMirror, type Phone, type Relay } from './support/mobileStack.ts';
import { mirrorOps } from './support/remote-mirror-kit.ts';

/** The Mac with the real per-device switch (devices.mirrors, as chromePanelMirror.cjs reads it) over mirror seams that record. */
async function mirrored(relay: Relay, phones = 1) {
  const seams = mirrorOps();
  const mac = await startMac(relay, {
    ops: { mirror: seams.mirror },
    policy: (remote) => ({ mirrors: (pairId: string) => remote().devices?.byPair(pairId)?.mirrors === true }),
  });
  const ps: Phone[] = [];
  for (let i = 1; i <= phones; i++) {
    const phone = await startPhone(relay, { id: `phone-${i}` });
    await phone.pair(await mac.qr(), `Phone ${i}`);
    await until(() => phone.snap().pairs.length === 1 && phone.snap().safetyNumber === null, `pair ${i}`);
    await phone.runtime.connect(phone.snap().pairs[0].pairId);
    ps.push(phone);
  }
  mac.known.add('c1');
  /** What Settings does for a device: flip the switch, then let a running mirror notice. */
  const setMirrors = async (phone: (typeof ps)[number], value: boolean) => {
    const device = mac.remote.devices.byPair(phone.snap().pairs[0].pairId);
    assert.equal(await mac.remote.devices.update(device.id, { mirrors: value }, device.pairId), true);
    mac.service.mirror.recheck();
  };
  return { mac, seams, phones: ps, setMirrors };
}
const SHELL = { chatId: 'c1', stream: 's1', cols: 80, rows: 24 };

test('mirrors are off by default: hello says so and nothing runs for a refused request', async () => {
  const relay = await startRelay();
  const { seams, phones } = await mirrored(relay);
  const [phone] = phones;
  assert.equal((await phone.ask('machine.hello')).capabilities.mirrors, false);
  await phone.ask('chat.follow', { chatId: 'c1' });
  await assert.rejects(phone.ask('pty.open', SHELL), /off for this device/);
  await assert.rejects(phone.ask('pty.write', { stream: 's1', data: 'ls\n' }), /off for this device|isn't open/);
  await assert.rejects(phone.ask('frames.subscribe', { chatId: 'c1' }), /off for this device|forbidden/);
  assert.deepEqual(seams.log, [], 'no folder lookup, no approval card, no shell');
  assert.equal(seams.shots.length, 0, 'no capture');
});

test('turned on for one device: its terminal runs after the Mac’s approval and streams, the other device stays off', async () => {
  const relay = await startRelay();
  const { mac, seams, phones, setMirrors } = await mirrored(relay, 2);
  const [one, two] = phones;
  await setMirrors(one, true);
  assert.equal((await one.ask('machine.hello')).capabilities.mirrors, true);
  assert.equal((await two.ask('machine.hello')).capabilities.mirrors, false, 'a device the Mac did not enable is not offered mirrors');

  await one.ask('chat.follow', { chatId: 'c1' });
  assert.deepEqual(await one.ask('pty.open', SHELL), { stream: 's1', resumed: false, at: 0, truncated: false });
  assert.deepEqual(
    seams.log.map((l) => l[0]),
    ['folder', 'approve', 'spawn'],
    'the Mac was asked first',
  );
  // Release the prompt after the first chunk arrives, so the phone exercises split delivery.
  const [key, handlers] = [...seams.ptys].at(-1)!;
  assert.match(key, /^remote:/);
  const terminalText = () => {
    const decoder = new TextDecoder();
    let terminal = phoneMirror.emptyTerminal();
    for (const event of one.eventsOf('pty.data')) terminal = phoneMirror.applyData(terminal, decoder, event.at, event.data);
    return phoneMirror.display(terminal.text);
  };
  handlers.onData('hello\r\n');
  await until(() => terminalText() === 'hello\n', 'the first terminal chunk');
  handlers.onData('$ ');
  await until(() => terminalText() === 'hello\n$ ', 'the complete terminal output');
  await one.ask('pty.write', { stream: 's1', data: 'ls\n' });
  assert.deepEqual(seams.log.at(-1), ['write', key, 'ls\n']);
  assert.equal(two.eventsOf('pty.data').length, 0);
  await two.ask('chat.follow', { chatId: 'c1' });
  await assert.rejects(two.ask('pty.open', SHELL), /off for this device/);
  assert.equal(seams.log.filter((l) => l[0] === 'spawn').length, 1, 'the second device started nothing');
  void mac;
});

test('turning the switch off ends a running terminal and its frames, and nothing more reaches the phone', async () => {
  const relay = await startRelay();
  const { seams, phones, setMirrors } = await mirrored(relay);
  const [phone] = phones;
  await setMirrors(phone, true);
  await phone.ask('chat.follow', { chatId: 'c1' });
  await phone.ask('pty.open', SHELL);
  assert.deepEqual(await phone.ask('frames.subscribe', { chatId: 'c1' }), { subscribed: true, active: false });
  seams.toolChanged('browser');
  await until(() => seams.shots.length === 1, 'the capture');
  seams.shots.shift()!.resolve({ data: 'AAAA', width: 200, height: 100 });
  await until(() => phone.eventsOf('frames.frame').length === 1, 'the first frame');
  // the Mac still sends the frame (the phone no longer draws a live view of it)
  assert.equal(phone.eventsOf('frames.frame')[0].jpeg, 'AAAA');

  await setMirrors(phone, false);
  await until(() => seams.log.some((l) => l[0] === 'kill'), 'the shell to be killed');
  const seen = phone.events.length;
  await assert.rejects(phone.ask('pty.write', { stream: 's1', data: 'rm -rf /\n' }), /off for this device|isn't open/);
  await assert.rejects(phone.ask('frames.subscribe', { chatId: 'c1' }), /off for this device|forbidden/);
  assert.ok(!seams.log.some((l) => l[0] === 'write' && String(l[2]).includes('rm')), 'the write never reached the shell');
  seams.toolChanged('screen');
  assert.equal(seams.shots.length, 0, 'no capture once the device is off');
  assert.equal(phone.eventsOf('frames.frame').length, 1);
  assert.ok(phone.events.length - seen <= 1, 'at most a closing notice');
});
