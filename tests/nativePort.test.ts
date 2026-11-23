// src/lib/native.ts's port: `native` reads whatever bridge is installed each time it is used (src/lib/nativeInstall.ts at
// startup, a test's fake from tests/support/ports/native.ts); before one is, a use says so and installedNative is null.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { installNative, installedNative, native, type NativeApi } from '../src/lib/native.ts';
import { fakeNative, useFakeNative } from './support/ports/native.ts';

const { loadBridge } = createRequire(import.meta.url)('../electron/bridge/spec.cjs');

/** The namespace and name of one call of `kind` the bridge declares at a namespace's top level. */
function declared(kind: string): [string, string] {
  for (const [ns, spec] of Object.entries(loadBridge() as Record<string, Record<string, any>>))
    for (const [name, node] of Object.entries(spec)) if (node?.kind === kind) return [ns, name];
  throw new Error(`no ${kind} declared`);
}

const bridge = (marker: string) => ({ platform: marker, marker, app: { ready: async () => marker } }) as unknown as NativeApi;

test('before a bridge is installed, a use of native says so (never window.native), and installedNative is null', () => {
  installNative(null);
  (globalThis as any).window = { native: bridge('window') };
  try {
    assert.throws(() => native.platform, /The native bridge is not installed: src\/lib\/nativeInstall\.ts installs window\.native first/);
    assert.equal(installedNative(), null);
    const installed = bridge('installed');
    installNative(installed);
    assert.equal(installedNative(), installed);
  } finally {
    installNative(null);
    delete (globalThis as any).window;
  }
});

test('an installed bridge is used for reads, writes, keys and spreads, and null takes it out', async () => {
  const installed = bridge('installed') as any;
  installNative(installed);
  try {
    assert.equal(native.platform, 'installed');
    assert.equal(await native.app.ready(), 'installed');
    (native as any).extra = 1;
    assert.equal(installed.extra, 1);
    assert.ok('extra' in native);
    assert.deepEqual(Object.keys(native), ['platform', 'marker', 'app', 'extra']);
    assert.equal(({ ...native } as any).marker, 'installed');
    assert.equal(Object.getOwnPropertyDescriptor(native, 'nope'), undefined);
    delete (native as any).extra;
    assert.equal('extra' in installed, false);
    // a property defined on the port lands on the bridge; the port itself can't be frozen
    Object.defineProperty(native, 'defined', { value: 2, enumerable: true });
    assert.equal(installed.defined, 2);
    assert.equal((native as any).defined, 2);
    assert.throws(() => Object.freeze(native), TypeError);
  } finally {
    installNative(null);
  }
  assert.throws(() => native.platform, /not installed/);
});

test('the entry’s install module puts window.native behind the port as it was at startup', async () => {
  const startup = bridge('startup');
  (globalThis as any).window = { native: startup };
  await import('../src/lib/nativeInstall.ts');
  (globalThis as any).window = { native: bridge('later') };
  try {
    assert.equal(native.platform, 'startup');
  } finally {
    installNative(null);
  }
});

test('the shared fake answers every declared call by its kind and records it', async () => {
  const fake = fakeNative();
  assert.equal(fake.platform, 'darwin');
  assert.equal(fake.flags.isEnabled('x' as any), false);
  assert.deepEqual(fake.flags.all(), {});
  fake.flags.onChanged(() => {})();
  // an invoke resolves undefined, a send returns nothing, a dropped file's path is its own
  assert.equal(await (fake as any).app.ready(), undefined);
  const [sendNs, send] = declared('send');
  assert.equal((fake as any)[sendNs][send]('x'), undefined);
  const [fileNs, file] = declared('filePath');
  assert.equal((fake as any)[fileNs][file]({ path: '/a' }), '/a');
  assert.equal((fake as any)[fileNs][file](undefined), '');
  assert.deepEqual(fake.callsTo('app.ready'), [[]]);
  assert.deepEqual(fake.callsTo(`${sendNs}.${send}`), [['x']]);
});

test('overrides replace calls (still recorded) and values, namespace by namespace; null leaves a namespace out', async () => {
  const seen: unknown[] = [];
  const fake = fakeNative({
    platform: 'win32',
    flags: { isEnabled: () => true, onChanged: (cb: unknown) => (seen.push(cb), () => {}) },
    app: { ready: async (n: number) => n * 2 },
    git: null,
  });
  assert.equal(fake.platform, 'win32');
  assert.equal(fake.flags.isEnabled('x' as any), true);
  assert.deepEqual(fake.callsTo('flags.isEnabled'), [['x']]);
  fake.flags.onChanged(() => {});
  assert.equal(seen.length, 1);
  assert.equal(await (fake as any).app.ready(21), 42);
  assert.deepEqual(fake.callsTo('app.ready'), [[21]]);
  assert.equal('git' in fake, false);
});

test('an override the bridge doesn’t declare fails, at any depth', () => {
  assert.throws(() => fakeNative({ own: { thing: 1 } }), /the bridge declares no own; check electron\/bridge/);
  assert.throws(() => fakeNative({ app: { redy: () => {} } }), /the bridge declares no app\.redy/);
});

test('the default flags subscription fires through emit', () => {
  const fake = fakeNative();
  const snaps: unknown[] = [];
  const off = fake.flags.onChanged((snap) => snaps.push(snap));
  fake.emit('flags.onChanged', { a: true });
  off();
  fake.emit('flags.onChanged', { a: false });
  assert.deepEqual(snaps, [{ a: true }]);
  assert.deepEqual(fake.callsTo('flags.all'), []);
  assert.deepEqual(fake.flags.all(), {});
});

test('an on subscription fires through emit until it is unsubscribed', () => {
  const fake = fakeNative();
  const [ns, name] = declared('on');
  const seen: unknown[] = [];
  const off = (fake as any)[ns][name]((v: unknown) => seen.push(v));
  fake.emit(`${ns}.${name}`, 1);
  off();
  fake.emit(`${ns}.${name}`, 2);
  fake.emit('nobody.listens', 3);
  assert.deepEqual(seen, [1]);
});

test('useFakeNative installs the fake for the test and puts back the bridge that was there', () => {
  installNative(bridge('the file’s own'));
  const after: (() => void)[] = [];
  const fake = useFakeNative({ after: (fn) => after.push(fn) }, { platform: 'linux' });
  assert.equal(native.platform, 'linux');
  assert.equal((native as any).calls, fake.calls);
  for (const fn of after) fn();
  assert.equal(native.platform, 'the file’s own');
  assert.equal(installNative(null)?.platform, 'the file’s own');
});
