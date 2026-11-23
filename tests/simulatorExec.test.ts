// The simulator toolchain runner and argument checks (electron/platform/simulatorExec.cjs and electron/capabilities/simulator/common.cjs): where adb,
// emulator and idb are found, how a missing binary, a timeout and a failed exit come back, and the validators.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createExec } = require('../electron/platform/simulatorExec.cjs');
const c = require('../electron/capabilities/simulator/common.cjs');

const fakeExec =
  (err: any, out: any = 'out', errText: any = 'err') =>
  (_f: string, _a: string[], _o: any, cb: any) =>
    cb(err, out, errText);

test('locate finds tools in SDK folders, then PATH, and returns null when absent', () => {
  const seen = new Set(['/sdk/platform-tools/adb', '/bin/idb', '/home/u/Library/Android/sdk/emulator/emulator']);
  const x = createExec({ exists: (p: string) => seen.has(p), env: { ANDROID_HOME: '/sdk', PATH: '/usr/bin:/bin' }, home: '/home/u' });
  assert.equal(x.locate('adb'), '/sdk/platform-tools/adb');
  assert.equal(x.locate('idb'), '/bin/idb');
  assert.equal(x.locate('emulator'), '/home/u/Library/Android/sdk/emulator/emulator');
  const none = createExec({ exists: () => false, env: {}, home: '/h' });
  assert.equal(none.locate('adb'), null);
  assert.equal(none.locate('unknown'), null);
});

test('run reports success, a missing binary, a timeout and a failed exit', async () => {
  assert.deepEqual(await createExec({ execFile: fakeExec(null, 'hi', '') }).run('x', []), { ok: true, code: 0, stdout: 'hi', stderr: '' });
  const ok = await createExec({ execFile: fakeExec(null, 'a', undefined) }).run('x', [], { binary: true, timeout: 5 });
  assert.equal(ok.ok, true);
  const noText = await createExec({ execFile: fakeExec({ code: 1, message: 'boom' }, 'o', null) }).run('x', []);
  assert.equal(noText.stderr, 'boom');
  const missing = await createExec({ execFile: fakeExec({ code: 'ENOENT', message: 'spawn x ENOENT' }, '', '') }).run('x', []);
  assert.equal(missing.missing, true);
  assert.equal(missing.stderr, 'spawn x ENOENT');
  const slow = await createExec({ execFile: fakeExec({ killed: true, message: 'timed out' }, null, 'partial') }).run('x', []);
  assert.deepEqual([slow.timedOut, slow.stdout, slow.stderr, slow.code, slow.missing], [true, '', 'partial', null, false]);
  const failed = await createExec({ execFile: fakeExec({ code: 2, message: 'm' }, 'o', 'bad') }).run('x', []);
  assert.deepEqual([failed.ok, failed.code, failed.stdout, failed.stderr], [false, 2, 'o', 'bad']);
});

test('startDetached spawns a detached program that survives the call and ignores its errors', () => {
  const calls: any[] = [];
  const handlers: Record<string, () => void> = {};
  const child = { on: (e: string, f: () => void) => (handlers[e] = f), unref: () => calls.push('unref') };
  const x = createExec({ spawn: ((f: string, a: string[], o: any) => (calls.push([f, a, o]), child)) as any });
  x.startDetached('emu', ['-avd', 'p']);
  assert.deepEqual(calls[0], ['emu', ['-avd', 'p'], { detached: true, stdio: 'ignore' }]);
  assert.equal(calls[1], 'unref');
  assert.equal(handlers.error(), undefined);
  assert.equal(x.platform, process.platform);
  assert.equal(createExec({ platform: 'linux' }).platform, 'linux');
});

test('validators accept good values and refuse bad ones', () => {
  assert.equal(c.matching('com.a.b', c.PACKAGE, 'app'), 'com.a.b');
  assert.throws(() => c.matching('x y', c.PACKAGE, 'app'), /app "x y" is not valid/);
  assert.throws(() => c.matching(undefined, c.PACKAGE, 'app'), /not valid/);
  assert.equal(c.coord(12.6, 'x'), 13);
  for (const bad of [undefined, null, '', 'a', -1, 20001, Infinity]) assert.throws(() => c.coord(bad, 'x'), /x must be a number/);
  assert.deepEqual(
    c.pathOf([
      { x: 1, y: 2 },
      { x: 3.2, y: 4 },
    ]),
    [
      { x: 1, y: 2 },
      { x: 3, y: 4 },
    ],
  );
  assert.throws(() => c.pathOf([{ x: 1, y: 1 }]), /2 to 200/);
  assert.throws(() => c.pathOf('no'), /2 to 200/);
  assert.throws(() => c.pathOf([{ x: 1, y: 1 }, null]), /points\[1\]\.x/);
});

test('pngSize reads the header and tail keeps the last lines with a note', () => {
  const png = Buffer.alloc(24);
  png.writeUInt32BE(0x89504e47, 0);
  png.writeUInt32BE(300, 16);
  png.writeUInt32BE(600, 20);
  assert.deepEqual(c.pngSize(png), { w: 300, h: 600 });
  assert.equal(c.pngSize(Buffer.alloc(30)), null);
  assert.equal(c.pngSize(Buffer.alloc(3)), null);
  assert.equal(c.pngSize(null), null);
  assert.equal(c.tail('a\nb\nc\n', 2), '[1 earlier lines left out]\nb\nc');
  assert.equal(c.tail('a\nb', 5), 'a\nb');
  assert.equal(c.tail('', 5), '(no output)');
  assert.equal(c.tail('a\nb', 'x'), 'a\nb');
  assert.equal(c.tail('x'.repeat(30000), 1).length, 20000);
});

test('why takes the first line of a failure and falls back to the exit code', () => {
  assert.equal(c.why({ stderr: ' first\nsecond ' }), 'first');
  assert.equal(c.why({ stderr: '', stdout: 'from out' }), 'from out');
  assert.equal(c.why({ stderr: '', stdout: '', code: 3 }), 'exit 3');
  assert.equal(c.why({ stderr: '\n\n', stdout: '' }), 'failed');
});

test('the file helpers read, list, date and remove through the injected file system', () => {
  const seen: string[] = [];
  const x = createExec({
    files: {
      readFileSync: (p: string, enc?: string) => (seen.push(`read ${p} ${enc ?? ''}`), enc ? 'text' : Buffer.from('bin')),
      unlinkSync: (p: string) => void seen.push(`rm ${p}`),
      readdirSync: (d: string) => (seen.push(`ls ${d}`), ['a.ips']),
      statSync: (p: string) => (seen.push(`stat ${p}`), { mtimeMs: 42 }),
    } as any,
  });
  assert.equal(x.readFile('/f').toString(), 'bin');
  assert.equal(x.readText('/t'), 'text');
  assert.deepEqual(x.listDir('/d'), ['a.ips']);
  assert.equal(x.modifiedAt('/m'), 42);
  x.removeFile('/r');
  assert.deepEqual(seen, ['read /f ', 'read /t utf8', 'ls /d', 'stat /m', 'rm /r']);
});
