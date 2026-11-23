// The Android Emulator driver (electron/capabilities/simulator/android.cjs) over a faked adb and emulator: attach (online
// device, AVD start and boot wait, refusals), launch, screenshots, the uiautomator tree, input, settings actions and logs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createAndroid } = require('../electron/capabilities/simulator/android.cjs');

const ok = (stdout: any = '') => ({ ok: true, code: 0, stdout, stderr: '' });
const bad = (stderr: string) => ({ ok: false, code: 1, stdout: '', stderr });
type Call = { file: string; args: string[]; opts?: any };

function setup(over: { respond?: (c: Call) => any; adb?: boolean; emulator?: boolean; devices?: string[][] } = {}) {
  const calls: Call[] = [];
  const started: any[] = [];
  let poll = 0;
  const devices = over.devices ?? [['emulator-5554', 'device']];
  const exec = {
    platform: 'linux',
    locate: (n: string) =>
      n === 'adb' ? (over.adb === false ? null : '/sdk/adb') : n === 'emulator' ? (over.emulator === false ? null : '/sdk/emulator') : null,
    startDetached: (f: string, a: string[]) => started.push([f, a]),
    run: async (file: string, args: string[], opts?: any) => {
      const call = { file, args, opts };
      calls.push(call);
      const custom = over.respond?.(call);
      if (custom) return custom;
      if (args[0] === '-list-avds') return ok('Pixel_7\nPixel_8\n');
      if (args[0] === 'devices') return ok(`List of devices attached\n${devices.map((d) => d.join('\t')).join('\n')}\n`);
      if (args.includes('getprop')) return ok('1\n');
      poll += 1;
      return ok('');
    },
  };
  const android = createAndroid({ exec, sleep: async () => undefined });
  return { android, calls, started, polls: () => poll };
}

test('attach takes the first emulator online, or a named device, and reports the choice', async () => {
  const { android } = setup({
    devices: [
      ['R5CT123', 'device'],
      ['emulator-5556', 'device'],
      ['emulator-5558', 'offline'],
    ],
  });
  assert.equal(await android.control('c', { action: 'attach' }), 'Attached to emulator-5556. Next: launch an app or take a screenshot.');
  assert.match(await android.control('c', { action: 'attach', device: 'R5CT123' }), /Attached to R5CT123/);
  const phone = setup({ devices: [['R5CT123', 'device']] });
  await assert.rejects(phone.android.control('c', { action: 'attach' }), /No emulator or device is online/);
  await assert.rejects(
    android.control('c', { action: 'attach', device: 'emulator-1' }),
    /Device "emulator-1" is not online\. Start one with attach and avd set to one of: Pixel_7, Pixel_8/,
  );
  await assert.rejects(android.control('c', { action: 'attach', device: 'bad dev' }), /device "bad dev" is not valid/);
});

test('attach with nothing online lists AVDs, or says the emulator is missing too', async () => {
  const none = setup({ devices: [] });
  await assert.rejects(
    none.android.control('c', { action: 'attach' }),
    /No emulator or device is online\. Start one with attach and avd set to one of: Pixel_7/,
  );
  const noEmu = setup({ devices: [], emulator: false });
  await assert.rejects(noEmu.android.control('c', { action: 'attach' }), /The emulator binary is not installed either/);
  const noAvds = setup({ devices: [], respond: (c) => (c.args[0] === '-list-avds' ? ok('') : null) });
  await assert.rejects(noAvds.android.control('c', { action: 'attach' }), /none \(create one in Android Studio\)/);
  const failedList = setup({ devices: [], respond: (c) => (c.args[0] === '-list-avds' ? bad('x') : null) });
  await assert.rejects(failedList.android.control('c', { action: 'attach' }), /none \(create one/);
});

test('a missing adb is reported as the missing toolchain', async () => {
  const { android } = setup({ adb: false });
  await assert.rejects(
    android.control('c', { action: 'attach' }),
    (e: any) => e.code === 'unavailable' && /adb is not installed/.test(e.message),
  );
  const failing = setup({ respond: (c) => (c.args[0] === 'devices' ? bad('daemon not running') : null) });
  await assert.rejects(failing.android.control('c', { action: 'attach' }), /Listing devices failed: daemon not running/);
});

test('attach with avd starts it and waits until the new emulator has booted', async () => {
  let listings = 0;
  let boots = 0;
  const { android, started } = setup({
    respond: (c) => {
      if (c.args[0] === 'devices') {
        listings += 1;
        return ok(`List of devices attached\n${listings > 2 ? 'emulator-5560\tdevice\n' : ''}emulator-5554\tdevice\n`);
      }
      if (c.args.includes('getprop')) return ok((boots += 1) > 1 ? '1\n' : '0\n');
      return null;
    },
  });
  assert.match(await android.control('c', { action: 'attach', avd: 'Pixel_7' }), /Attached to emulator-5560/);
  assert.deepEqual(started, [['/sdk/emulator', ['-avd', 'Pixel_7']]]);
});

test('attach with avd refuses an unknown AVD, a missing emulator and a boot that never finishes', async () => {
  await assert.rejects(setup().android.control('c', { action: 'attach', avd: 'Nope' }), /No AVD "Nope"\. Available: Pixel_7, Pixel_8/);
  await assert.rejects(
    setup({ emulator: false }).android.control('c', { action: 'attach', avd: 'Pixel_7' }),
    (e: any) => e.code === 'unavailable' && /emulator is not installed/.test(e.message),
  );
  await assert.rejects(setup().android.control('c', { action: 'attach', avd: '-x' }), /avd "-x" is not valid/);
  const empty = setup({ respond: (c) => (c.args[0] === '-list-avds' ? ok('') : null) });
  await assert.rejects(
    empty.android.control('c', { action: 'attach', avd: 'Pixel_7' }),
    /Available: none \(create one in Android Studio\)/,
  );
  // the first listing is the baseline; every later one shows a new emulator that never reports boot_completed
  let n = 0;
  const stuck = setup({
    respond: (c) => {
      if (c.args[0] === 'devices')
        return ok(`List of devices attached\nemulator-5554\tdevice\n${((n += 1)) > 1 ? 'emulator-5560\tdevice\n' : ''}`);
      if (c.args.includes('getprop')) return ok('0\n');
      return null;
    },
  });
  await assert.rejects(
    stuck.android.control('c', { action: 'attach', avd: 'Pixel_7' }),
    (e: any) => e.code === 'timeout' && /did not finish booting in 90 seconds/.test(e.message),
  );
  const noNew = setup({ respond: (c) => (c.args.includes('getprop') ? ok('1\n') : null) });
  await assert.rejects(noNew.android.control('c', { action: 'attach', avd: 'Pixel_7' }), /did not finish booting/);
});

test('actions before attach say to attach; detach forgets the device; unknown actions are refused', async () => {
  const { android } = setup();
  await assert.rejects(android.control('c', { action: 'tap', x: 1, y: 1 }), (e: any) => e.code === 'not_attached');
  await assert.rejects(android.logs('c', {}), /No emulator is attached/);
  await android.control('c', { action: 'attach' });
  assert.match(await android.control('c', { action: 'detach' }), /Detached/);
  await assert.rejects(android.control('c', { action: 'screenshot' }), /No emulator is attached/);
  await android.control('c', { action: 'attach' });
  await assert.rejects(android.control('c', { action: 'bogus' }), /Unknown action "bogus"/);
  await assert.rejects(android.control('c', {}), /Unknown action ""/);
});

test('launch starts the launcher activity and refuses a package without one', async () => {
  const { android, calls } = setup({
    respond: (c) =>
      c.args.includes('monkey') && c.args.includes('com.none.app') ? ok('** No activities found to run, monkey aborted.') : null,
  });
  await android.control('c', { action: 'attach' });
  assert.match(await android.control('c', { action: 'launch', app: 'com.demo.app' }), /Launched com\.demo\.app/);
  assert.deepEqual(calls.at(-1)!.args, [
    '-s',
    'emulator-5554',
    'shell',
    'monkey',
    '-p',
    'com.demo.app',
    '-c',
    'android.intent.category.LAUNCHER',
    '1',
  ]);
  await assert.rejects(android.control('c', { action: 'launch', app: 'com.none.app' }), /has no launcher activity/);
  await assert.rejects(android.control('c', { action: 'launch', app: 'nodots' }), /app \(package name\) "nodots" is not valid/);
  const fail = setup({ respond: (c) => (c.args.includes('monkey') ? bad('device offline') : null) });
  await fail.android.control('c', { action: 'attach' });
  await assert.rejects(
    fail.android.control('c', { action: 'launch', app: 'com.demo.app' }),
    /Launching com\.demo\.app failed: device offline/,
  );
});

test('screenshot returns the PNG with its pixel size and refuses anything else', async () => {
  const png = Buffer.alloc(24);
  png.writeUInt32BE(0x89504e47, 0);
  png.writeUInt32BE(1080, 16);
  png.writeUInt32BE(2400, 20);
  const { android, calls } = setup({ respond: (c) => (c.args.includes('screencap') ? ok(png) : null) });
  await android.control('c', { action: 'attach' });
  const out = await android.control('c', { action: 'screenshot' });
  assert.equal(out[0].data, png.toString('base64'));
  assert.match(out[1].text, /1080x2400 pixels/);
  assert.equal(calls.at(-1)!.opts.binary, true);
  const junk = setup({ respond: (c) => (c.args.includes('screencap') ? ok(Buffer.from('nope')) : null) });
  await junk.android.control('c', { action: 'attach' });
  await assert.rejects(junk.android.control('c', { action: 'screenshot' }), /did not return a PNG/);
});

test('inspect lists labelled and clickable nodes from the uiautomator dump', async () => {
  const xml =
    '<?xml version="1.0"?><hierarchy><node class="android.widget.Button" text="Sign in" resource-id="com.demo:id/login" clickable="true" bounds="[0,0][100,50]"/>' +
    '<node class="android.view.View" text="" content-desc="Logo" clickable="false" bounds="[0,60][100,90]"/>' +
    '<node class="android.view.View" text="" clickable="true" bounds="[1,1][2,2]"/><node class="android.view.View" text="" clickable="false" bounds="[3,3][4,4]"/></hierarchy>UI hierarchy dumped to: /dev/tty';
  const { android, calls } = setup({ respond: (c) => (c.args.includes('uiautomator') ? ok(xml) : null) });
  await android.control('c', { action: 'attach' });
  assert.equal(
    await android.control('c', { action: 'inspect' }),
    'Button #login "Sign in" clickable [0,0][100,50]\nView "Logo" [0,60][100,90]\nView "" clickable [1,1][2,2]',
  );
  assert.deepEqual(calls.at(-1)!.args, ['-s', 'emulator-5554', 'exec-out', 'uiautomator', 'dump', '/dev/tty']);
  const empty = setup({ respond: (c) => (c.args.includes('uiautomator') ? ok('<hierarchy/>') : null) });
  await empty.android.control('c', { action: 'attach' });
  assert.match(await empty.android.control('c', { action: 'inspect' }), /No labelled or clickable elements/);
});

test('tap, swipe and touch_path send pixel input and validate their points', async () => {
  const { android, calls } = setup();
  await android.control('c', { action: 'attach' });
  const last = () => calls.at(-1)!.args.slice(2);
  assert.match(await android.control('c', { action: 'tap', x: 10.4, y: 20 }), /Tapped \(10, 20\)/);
  assert.deepEqual(last(), ['shell', 'input', 'tap', '10', '20']);
  assert.match(await android.control('c', { action: 'swipe', x: 1, y: 2, to_x: 3, to_y: 4 }), /Swiped from \(1, 2\) to \(3, 4\)/);
  assert.deepEqual(last(), ['shell', 'input', 'swipe', '1', '2', '3', '4', '300']);
  await android.control('c', { action: 'swipe', x: 1, y: 2, to_x: 3, to_y: 4, duration: 0.001 });
  assert.equal(last().at(-1), '50');
  assert.match(
    await android.control('c', {
      action: 'touch_path',
      points: [
        { x: 1, y: 2 },
        { x: 3, y: 4 },
        { x: 5, y: 6 },
      ],
    }),
    /Dragged through 3 points/,
  );
  assert.deepEqual(
    calls.slice(-4).map((c) => c.args.slice(4, 6).join(' ')),
    ['motionevent DOWN', 'motionevent MOVE', 'motionevent MOVE', 'motionevent UP'].map((s) => s),
  );
  assert.deepEqual(last(), ['shell', 'input', 'motionevent', 'UP', '5', '6']);
  await assert.rejects(android.control('c', { action: 'touch_path', points: [{ x: 1, y: 1 }] }), /2 to 200/);
  await assert.rejects(android.control('c', { action: 'tap', x: 'a', y: 1 }), /x must be a number/);
});

test('text is quoted for the device shell; buttons and keys map to key events', async () => {
  const { android, calls } = setup();
  await android.control('c', { action: 'attach' });
  const last = () => calls.at(-1)!.args.slice(2);
  assert.match(await android.control('c', { action: 'text', text: "it's a $HOME;" }), /Typed 13 characters/);
  assert.deepEqual(last(), ['shell', 'input', 'text', "'it'\\''s%sa%s$HOME;'"]);
  await assert.rejects(android.control('c', { action: 'text', text: '' }), /text is required/);
  assert.match(await android.control('c', { action: 'button', button: 'recents' }), /Pressed RECENTS/);
  assert.deepEqual(last(), ['shell', 'input', 'keyevent', 'KEYCODE_APP_SWITCH']);
  await assert.rejects(android.control('c', { action: 'button', button: 'SIRI' }), /button must be one of HOME, BACK/);
  await android.control('c', { action: 'press_key', key: 'enter' });
  assert.deepEqual(last(), ['shell', 'input', 'keyevent', 'KEYCODE_ENTER']);
  await android.control('c', { action: 'press_key', key: 'KEYCODE_TAB' });
  assert.deepEqual(last(), ['shell', 'input', 'keyevent', 'KEYCODE_TAB']);
  await android.control('c', { action: 'press_key', key: '66' });
  assert.deepEqual(last(), ['shell', 'input', 'keyevent', '66']);
  await assert.rejects(android.control('c', { action: 'press_key', key: 'a;rm' }), /key \(an Android KEYCODE_ name or number\)/);
});

test('keyboard, rotation and airplane mode change device settings', async () => {
  const { android, calls } = setup();
  await android.control('c', { action: 'attach' });
  const tail = (n: number) => calls.slice(-n).map((c) => c.args.slice(2).join(' '));
  assert.match(await android.control('c', { action: 'set_keyboard' }), /shown/);
  assert.deepEqual(tail(1), ['shell settings put secure show_ime_with_hard_keyboard 1']);
  assert.match(await android.control('c', { action: 'set_keyboard', visible: false }), /hidden/);
  assert.deepEqual(tail(1), ['shell settings put secure show_ime_with_hard_keyboard 0']);
  assert.match(await android.control('c', { action: 'rotate', orientation: 'landscape' }), /Rotated to landscape/);
  assert.deepEqual(tail(2), ['shell settings put system accelerometer_rotation 0', 'shell settings put system user_rotation 1']);
  await assert.rejects(android.control('c', { action: 'rotate', orientation: 'sideways' }), /orientation must be one of portrait/);
  await assert.rejects(android.control('c', { action: 'rotate' }), /orientation must be one of/);
  assert.match(await android.control('c', { action: 'airplane_mode' }), /Airplane mode on/);
  assert.deepEqual(tail(2), [
    'shell settings put global airplane_mode_on 1',
    'shell am broadcast -a android.intent.action.AIRPLANE_MODE --ez state true',
  ]);
  assert.match(await android.control('c', { action: 'airplane_mode', enabled: false }), /Airplane mode off/);
  assert.equal(tail(1)[0].endsWith('state false'), true);
  const fail = setup({ respond: (c) => (c.args.includes('settings') ? bad('permission denied') : null) });
  await fail.android.control('c', { action: 'attach' });
  await assert.rejects(fail.android.control('c', { action: 'rotate', orientation: 'portrait' }), /rotate failed: permission denied/);
});

test('logs read logcat with a filter and a bounded count; crash_report reads the crash buffer', async () => {
  const { android, calls } = setup({
    respond: (c) =>
      c.args.includes('logcat')
        ? ok(c.args.includes('crash') ? 'FATAL EXCEPTION\nat Foo\n' : 'I/App: start\nE/App: Boom\nI/Other: x\n')
        : null,
  });
  await android.control('c', { action: 'attach' });
  assert.equal(await android.logs('c', {}), 'I/App: start\nE/App: Boom\nI/Other: x');
  assert.deepEqual(calls.at(-1)!.args, ['-s', 'emulator-5554', 'logcat', '-d', '-t', '200']);
  assert.equal(await android.logs('c', { action: 'read', filter: 'BOOM', lines: 5000 }), 'E/App: Boom');
  assert.equal(calls.at(-1)!.args.at(-1), '5000');
  assert.equal(await android.logs('c', { action: 'crash_report', lines: 3 }), 'FATAL EXCEPTION\nat Foo');
  assert.deepEqual(calls.at(-1)!.args, ['-s', 'emulator-5554', 'logcat', '-d', '-b', 'crash', '-t', '3']);
  await assert.rejects(android.logs('c', { action: 'tail' }), /Unknown action "tail"/);
  const quiet = setup({ respond: (c) => (c.args.includes('logcat') ? ok('\n') : null) });
  await quiet.android.control('c', { action: 'attach' });
  assert.equal(await quiet.android.logs('c', { action: 'crash_report' }), 'No crashes in the device crash log.');
});

test('the default sleep waits on a real timer', async () => {
  const exec = {
    platform: 'linux',
    locate: (n: string) => (n === 'adb' ? '/a' : '/e'),
    startDetached: () => undefined,
    run: async (_f: string, a: string[]) => (a[0] === '-list-avds' ? ok('P') : ok('List of devices attached\n')),
  };
  const android = createAndroid({ exec });
  const real = global.setTimeout;
  let waits = 0;
  (global as any).setTimeout = (f: () => void) => ((waits += 1), real(f, 0));
  try {
    await assert.rejects(android.control('c', { action: 'attach', avd: 'P' }), /did not finish booting/);
  } finally {
    global.setTimeout = real;
  }
  assert.equal(waits, 45);
});

test('missing text, button and key arguments are refused', async () => {
  const { android } = setup();
  await android.control('c', { action: 'attach' });
  await assert.rejects(android.control('c', { action: 'text' }), /text is required/);
  await assert.rejects(android.control('c', { action: 'button' }), /button must be one of/);
  await assert.rejects(android.control('c', { action: 'press_key' }), /key \(an Android KEYCODE_ name or number\)/);
});

test('a failed touch_path move still lifts the pointer', async () => {
  const { android, calls } = setup({ respond: (c) => (c.args.includes('MOVE') ? bad('device offline') : null) });
  await android.control('c', { action: 'attach' });
  await assert.rejects(
    android.control('c', {
      action: 'touch_path',
      points: [
        { x: 1, y: 2 },
        { x: 3, y: 4 },
      ],
    }),
    /touch_path failed: device offline/,
  );
  assert.deepEqual(calls.at(-1)!.args.slice(-4), ['motionevent', 'UP', '1', '2']);
});
