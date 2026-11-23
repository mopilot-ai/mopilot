// The iOS Simulator driver (electron/capabilities/simulator/ios.cjs) over a faked xcrun and idb: attach (boot, pick,
// refusals), launch, screenshots, idb-backed input and its install hint, what iOS cannot do, logs and crash reports.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createIos } = require('../electron/capabilities/simulator/ios.cjs');

const U1 = '11111111-1111-1111-1111-111111111111';
const U2 = '22222222-2222-2222-2222-222222222222';
const U3 = '33333333-3333-3333-3333-333333333333';
const LIST = {
  devices: {
    'com.apple.CoreSimulator.SimRuntime.iOS-16-4': [{ udid: U1, name: 'iPhone 14', state: 'Shutdown' }],
    'com.apple.CoreSimulator.SimRuntime.iOS-17-5': [
      { udid: U2, name: 'iPad Pro', state: 'Shutdown' },
      { udid: U3, name: 'iPhone 15', state: 'Shutdown' },
    ],
  },
};
const ok = (stdout: any = '') => ({ ok: true, code: 0, stdout, stderr: '' });
const bad = (stderr: string, extra: any = {}) => ({ ok: false, code: 1, stdout: '', stderr, ...extra });

type Call = { file: string; args: string[]; opts?: any };
function setup(over: { respond?: (c: Call) => any; idb?: boolean; platform?: string; list?: any; files?: any; silent?: boolean } = {}) {
  const calls: Call[] = [];
  const unlinked: string[] = [];
  const ignored: string[] = [];
  const exec = {
    platform: over.platform ?? 'darwin',
    locate: (n: string) => (n === 'idb' && over.idb ? '/bin/idb' : null),
    startDetached: () => undefined,
    readFile: (p: string) => (over.files?.read ? over.files.read(p) : Buffer.from('png')),
    readText: (p: string) => over.files?.read?.(p) ?? '',
    removeFile: (p: string) => {
      unlinked.push(p);
      if (over.files?.unlinkFails) throw new Error('gone');
    },
    listDir: (d: string) => (over.files?.dir ? over.files.dir(d) : []),
    modifiedAt: (p: string) => over.files?.mtime?.(p) ?? 1_000_000,
    run: async (file: string, args: string[], opts?: any) => {
      const call = { file, args, opts };
      calls.push(call);
      const custom = over.respond?.(call);
      if (custom) return custom;
      if (args[1] === 'list') return ok(JSON.stringify(over.list ?? LIST));
      return ok('');
    },
  };
  const ios = createIos({
    exec,
    tmp: '/tmp',
    now: () => 1_000_000,
    home: '/home/u',
    ...(over.silent ? {} : { noteIgnored: (what: string) => ignored.push(what) }),
  });
  return { ios, calls, unlinked, ignored };
}
const simctl = (calls: Call[], verb: string) => calls.find((c) => c.args[0] === 'simctl' && c.args[1] === verb);

test('attach boots the newest iPhone, opens the Simulator window and reports the idb state', async () => {
  const { ios, calls } = setup({ idb: true });
  const text = await ios.control('c1', { action: 'attach' });
  assert.match(text, /Attached to iPhone 15 \(3333.*iOS-17-5\)\. Touch, text and inspect are available/);
  assert.deepEqual(simctl(calls, 'boot')?.args, ['simctl', 'boot', U3]);
  assert.deepEqual(simctl(calls, 'bootstatus')?.args, ['simctl', 'bootstatus', U3, '-b']);
  assert.equal(simctl(calls, 'bootstatus')?.opts.timeout, 180_000);
  assert.deepEqual(calls.at(-1)?.args, ['-a', 'Simulator', '--args', '-CurrentDeviceUDID', U3]);
});

test('attach prefers a booted device, takes a name or UDID, and skips boot for a booted one', async () => {
  const booted = JSON.parse(JSON.stringify(LIST));
  booted.devices['com.apple.CoreSimulator.SimRuntime.iOS-16-4'][0].state = 'Booted';
  const a = setup({ list: booted });
  assert.match(await a.ios.control('c', { action: 'attach' }), /iPhone 14/);
  assert.equal(simctl(a.calls, 'boot'), undefined);
  const b = setup();
  assert.match(await b.ios.control('c', { action: 'attach', device: 'ipad pro' }), /iPad Pro/);
  assert.match(await b.ios.control('c', { action: 'attach', device: U1.toLowerCase() }), /iPhone 14/);
  const noPhone = setup({ list: { devices: { 'x.SimRuntime.iOS-1': [{ udid: U2, name: 'iPad', state: 'Shutdown' }] } } });
  assert.match(await noPhone.ios.control('c', { action: 'attach' }), /iPad/);
});

test('attach refuses an unknown device, an empty list, boot failures and unreadable output', async () => {
  await assert.rejects(setup().ios.control('c', { action: 'attach', device: 'Nope' }), /No simulator "Nope"\. Installed: iPad Pro/);
  await assert.rejects(setup({ list: {} }).ios.control('c', { action: 'attach' }), /No iOS simulators are installed/);
  await assert.rejects(setup({ list: { devices: { r: null } } }).ios.control('c', { action: 'attach' }), /No iOS simulators/);
  const failBoot = setup({ respond: (c) => (c.args[1] === 'boot' ? bad('Unable to boot') : null) });
  await assert.rejects(failBoot.ios.control('c', { action: 'attach' }), /Booting iPhone 15 failed: Unable to boot/);
  const raced = setup({ respond: (c) => (c.args[1] === 'boot' ? bad('Unable to boot device in current state: Booted') : null) });
  assert.match(await raced.ios.control('c', { action: 'attach' }), /Attached/);
  const slow = setup({ respond: (c) => (c.args[1] === 'bootstatus' ? bad('timed out') : null) });
  await assert.rejects(slow.ios.control('c', { action: 'attach' }), /Waiting for iPhone 15 to boot failed/);
  const junk = setup({ respond: (c) => (c.args[1] === 'list' ? ok('not json') : null) });
  await assert.rejects(junk.ios.control('c', { action: 'attach' }), /unreadable output/);
  const failList = setup({ respond: (c) => (c.args[1] === 'list' ? bad('list broke') : null) });
  await assert.rejects(failList.ios.control('c', { action: 'attach' }), /Listing simulators failed: list broke/);
  const noDevices = setup({ respond: (c) => (c.args[1] === 'list' ? ok('{}') : null) });
  await assert.rejects(noDevices.ios.control('c', { action: 'attach' }), /No iOS simulators/);
});

test('a missing Xcode or a non-Mac is reported as the missing toolchain', async () => {
  const noXcode = setup({ respond: () => ({ ok: false, code: 'ENOENT', stdout: '', stderr: 'enoent', missing: true }) });
  await assert.rejects(
    noXcode.ios.control('c', { action: 'attach' }),
    (e: any) => e.code === 'unavailable' && /Xcode command line tools are not installed/.test(e.message),
  );
  const linux = setup({ platform: 'linux' });
  await assert.rejects(linux.ios.control('c', { action: 'attach' }), /needs macOS with Xcode/);
  await assert.rejects(linux.ios.logs('c', { action: 'read' }), /needs macOS/);
});

test('actions before attach say to attach, detach forgets the device', async () => {
  const { ios } = setup();
  await assert.rejects(ios.control('c', { action: 'tap', x: 1, y: 1 }), (e: any) => e.code === 'not_attached');
  await assert.rejects(ios.logs('c', { action: 'read' }), /Call control with action "attach"/);
  await ios.control('c', { action: 'attach' });
  assert.match(await ios.control('c', { action: 'detach' }), /Detached/);
  await assert.rejects(ios.control('c', { action: 'screenshot' }), /No simulator is attached/);
  await ios.control('c', { action: 'attach' });
  await assert.rejects(ios.control('c', { action: 'bogus' }), /Unknown action "bogus"/);
  await assert.rejects(ios.control('c', {}), /Unknown action ""/);
});

test('launch starts the app and reports its pid; bad ids and failures are refused', async () => {
  const { ios, calls } = setup({
    respond: (c) =>
      c.args[1] === 'launch' ? (c.args[3] === 'com.fail.app' ? bad('app not installed') : ok('com.demo.app: 4242\n')) : null,
  });
  await ios.control('c', { action: 'attach' });
  assert.match(
    await ios.control('c', { action: 'launch', app: 'com.demo.app' }),
    /Launched com\.demo\.app \(pid 4242\)\. Take a screenshot/,
  );
  assert.deepEqual(simctl(calls, 'launch')?.args, ['simctl', 'launch', U3, 'com.demo.app']);
  await assert.rejects(ios.control('c', { action: 'launch', app: '-bad' }), /app \(bundle id\) "-bad" is not valid/);
  await assert.rejects(ios.control('c', { action: 'launch', app: 'com.fail.app' }), /Launching com\.fail\.app failed: app not installed/);
  const nopid = setup({ respond: (c) => (c.args[1] === 'launch' ? ok('started') : null) });
  await nopid.ios.control('c', { action: 'attach' });
  assert.equal(
    await nopid.ios.control('c', { action: 'launch', app: 'com.demo.app' }),
    'Launched com.demo.app. Take a screenshot to see it.',
  );
});

test('screenshot returns the image with its size and removes the temporary file, even when removal fails', async () => {
  const png = Buffer.alloc(24);
  png.writeUInt32BE(0x89504e47, 0);
  png.writeUInt32BE(1179, 16);
  png.writeUInt32BE(2556, 20);
  const { ios, calls, unlinked, ignored } = setup({ files: { read: () => png, unlinkFails: true } });
  await ios.control('c', { action: 'attach' });
  const out = await ios.control('c', { action: 'screenshot' });
  assert.equal(out[0].type, 'image');
  assert.equal(out[0].data, png.toString('base64'));
  assert.match(out[1].text, /1179x2556 pixels\. Tap and swipe coordinates are in screen points/);
  assert.deepEqual(simctl(calls, 'io')?.args, ['simctl', 'io', U3, 'screenshot', '--type=png', `/tmp/mopilot-sim-${U3}-1000000.png`]);
  assert.equal(unlinked.length, 1);
  assert.deepEqual(ignored, ['remove a simulator screenshot']);
  const odd = setup();
  await odd.ios.control('c', { action: 'attach' });
  assert.match((await odd.ios.control('c', { action: 'screenshot' }))[1].text, /unknown size/);
  const fail = setup({ respond: (c) => (c.args[1] === 'io' ? bad('no display') : null) });
  await fail.ios.control('c', { action: 'attach' });
  await assert.rejects(fail.ios.control('c', { action: 'screenshot' }), /Screenshot failed: no display/);
});

test('input goes through idb with the device, and says what to install without it', async () => {
  const idb = (r: any) => (c: Call) => (c.file === '/bin/idb' ? r(c) : null);
  const { ios, calls } = setup({ idb: true });
  await ios.control('c', { action: 'attach' });
  const last = () => calls.at(-1)!.args;
  assert.match(await ios.control('c', { action: 'tap', x: 10.4, y: 20 }), /Tapped \(10, 20\)/);
  assert.deepEqual(last(), ['ui', 'tap', '10', '20', '--udid', U3]);
  assert.match(await ios.control('c', { action: 'swipe', x: 1, y: 2, to_x: 3, to_y: 4 }), /Swiped from \(1, 2\) to \(3, 4\)/);
  assert.deepEqual(last(), ['ui', 'swipe', '1', '2', '3', '4', '--duration', '0.3', '--udid', U3]);
  await ios.control('c', { action: 'swipe', x: 1, y: 2, to_x: 3, to_y: 4, duration: 99 });
  assert.equal(last()[7], '10');
  assert.match(await ios.control('c', { action: 'text', text: 'hi there' }), /Typed 8 characters/);
  assert.deepEqual(last(), ['ui', 'text', '--udid', U3, '--', 'hi there']);
  await assert.rejects(ios.control('c', { action: 'text' }), /text is required/);
  assert.match(await ios.control('c', { action: 'button', button: 'home' }), /Pressed HOME/);
  assert.deepEqual(last(), ['ui', 'button', 'HOME', '--udid', U3]);
  await assert.rejects(ios.control('c', { action: 'button', button: 'BACK' }), /button must be one of HOME/);
  assert.match(await ios.control('c', { action: 'press_key', key: 'Return' }), /Pressed key Return/);
  assert.deepEqual(last(), ['ui', 'key', '40', '--udid', U3]);
  await ios.control('c', { action: 'press_key', key: '4' });
  assert.deepEqual(last(), ['ui', 'key', '4', '--udid', U3]);
  await assert.rejects(ios.control('c', { action: 'press_key', key: 'F13x' }), /key must be a HID usage number/);
  await assert.rejects(ios.control('c', { action: 'tap', x: -1, y: 0 }), /x must be a number/);
  const failing = setup({ idb: true, respond: idb((c: Call) => (c.args[1] === 'tap' ? bad('idb_companion not running') : null)) });
  await failing.ios.control('c', { action: 'attach' });
  await assert.rejects(failing.ios.control('c', { action: 'tap', x: 1, y: 1 }), /tap failed: idb_companion not running/);
});

test('without idb every input action is unavailable with the install hint, but screenshots still work', async () => {
  const { ios } = setup();
  const attach = await ios.control('c', { action: 'attach' });
  assert.match(attach, /Touch, text and inspect are not: idb is not installed \(brew install facebook\/fb\/idb-companion/);
  for (const args of [
    { action: 'tap', x: 1, y: 1 },
    { action: 'swipe', x: 1, y: 1, to_x: 2, to_y: 2 },
    { action: 'text', text: 'a' },
    { action: 'button', button: 'HOME' },
    { action: 'press_key', key: 'tab' },
    { action: 'inspect' },
  ])
    await assert.rejects(
      ios.control('c', args),
      (e: any) => e.code === 'unavailable' && /needs idb\. idb is not installed/.test(e.message),
    );
});

test('inspect lists the elements from idb and passes other text through', async () => {
  const tree = JSON.stringify([
    { type: 'Button', AXLabel: 'Sign in', frame: { x: 10.2, y: 20, width: 100, height: 40 } },
    { role: 'Text', label: 'Hi' },
    {},
  ]);
  const a = setup({ idb: true, respond: (c) => (c.args[1] === 'describe-all' ? ok(tree) : null) });
  await a.ios.control('c', { action: 'attach' });
  assert.equal(
    await a.ios.control('c', { action: 'inspect' }),
    'Button "Sign in" (10,20 100x40)\nText "Hi" (0,0 0x0)\nElement "" (0,0 0x0)',
  );
  const single = setup({ idb: true, respond: (c) => (c.args[1] === 'describe-all' ? ok('{"type":"Window"}') : null) });
  await single.ios.control('c', { action: 'attach' });
  assert.match(await single.ios.control('c', { action: 'inspect' }), /^Window ""/);
  const text = setup({ idb: true, respond: (c) => (c.args[1] === 'describe-all' ? ok('plain text tree') : null) });
  await text.ios.control('c', { action: 'attach' });
  assert.equal(await text.ios.control('c', { action: 'inspect' }), 'plain text tree');
});

test('what simctl and idb cannot do is refused as unsupported, even before attach', async () => {
  const { ios } = setup();
  for (const action of ['touch_path', 'rotate', 'set_keyboard'])
    await assert.rejects(
      ios.control('c', { action }),
      (e: any) => e.code === 'unsupported' && new RegExp(`${action} is not supported on iOS`).test(e.message),
    );
});

test('logs read through simctl spawn with an escaped predicate and a bounded tail', async () => {
  const { ios, calls } = setup({ respond: (c) => (c.args[1] === 'spawn' ? ok('l1\nl2\nl3\n') : null) });
  await ios.control('c', { action: 'attach' });
  assert.equal(await ios.logs('c', {}), 'l1\nl2\nl3');
  assert.deepEqual(simctl(calls, 'spawn')?.args, ['simctl', 'spawn', U3, 'log', 'show', '--last', '5m', '--style', 'compact']);
  assert.equal(
    await ios.logs('c', { action: 'read', process: 'My"App', filter: 'a\\b', since: '30s', lines: 2 }),
    '[1 earlier lines left out]\nl2\nl3',
  );
  assert.deepEqual(calls.at(-1)!.args.slice(-2), ['--predicate', 'process == "My\\"App" AND eventMessage CONTAINS[c] "a\\\\b"']);
  await assert.rejects(ios.logs('c', { since: '5 minutes' }), /since \(like 30s, 5m, 1h\)/);
  await assert.rejects(ios.logs('c', { action: 'tail' }), /Unknown action "tail"/);
  const fail = setup({ respond: (c) => (c.args[1] === 'spawn' ? bad('not booted') : null) });
  await fail.ios.control('c', { action: 'attach' });
  await assert.rejects(fail.ios.logs('c', {}), /Reading logs failed: not booted/);
});

test('crash_report returns the newest recent report, filtered by process, and says when there is none', async () => {
  const names = ['MyApp-2026.ips', 'Other-2026.crash', 'notes.txt', 'MyApp-old.ips'];
  const mtime = (p: string) => (p.endsWith('MyApp-old.ips') ? 1_000_000 - 90_000_000 : p.endsWith('Other-2026.crash') ? 999_000 : 998_000);
  const { ios } = setup({ files: { dir: () => names, mtime, read: (p: string) => `report ${p.split('/').pop()}\nline2` } });
  assert.equal(await ios.logs('c', { action: 'crash_report' }), 'Other-2026.crash\nreport Other-2026.crash\nline2');
  assert.match(await ios.logs('c', { action: 'crash_report', process: 'myapp' }), /^MyApp-2026\.ips\n/);
  await assert.rejects(ios.logs('c', { action: 'crash_report', process: 'ghost' }), /No crash report from the last 24 hours for "ghost"/);
  const none = setup({ files: { dir: () => [] } });
  await assert.rejects(none.ios.logs('c', { action: 'crash_report' }), /No crash report from the last 24 hours\./);
  const nodir = setup({
    files: {
      dir: () => {
        throw new Error('ENOENT');
      },
    },
  });
  await assert.rejects(
    nodir.ios.logs('c', { action: 'crash_report' }),
    /No crash reports folder at \/home\/u\/Library\/Logs\/DiagnosticReports/,
  );
});

test('real tmp and home defaults are used, and a failed removal is ignored quietly, when none are given', async () => {
  const exec = {
    platform: 'darwin',
    locate: () => null,
    startDetached: () => undefined,
    readFile: () => Buffer.from('png'),
    removeFile: () => {
      throw new Error('gone');
    },
    run: async (_f: string, args: string[]) => ok(args[1] === 'list' ? JSON.stringify(LIST) : ''),
  };
  const ios = createIos({ exec });
  await ios.control('c', { action: 'attach' });
  assert.equal((await ios.control('c', { action: 'screenshot' }))[0].type, 'image');
});

test('a missing button or key argument is refused', async () => {
  const { ios } = setup({ idb: true });
  await ios.control('c', { action: 'attach' });
  await assert.rejects(ios.control('c', { action: 'button' }), /button must be one of/);
  await assert.rejects(ios.control('c', { action: 'press_key' }), /key must be a HID usage number/);
});
