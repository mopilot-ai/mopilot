// What a failed browser start tells the person (host/src/launchFailure.mjs, package 2.6).
import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore: plain ESM without declarations
import { launchFailure, startFailure, CAUSE_MS } from '../host/src/launchFailure.mjs';

const timers = () => {
  const cleared: unknown[] = [];
  const fired: (() => void)[] = [];
  return {
    cleared,
    fired,
    // a timer without unref (an environment's own) is still fine
    setTimer: ((fn: () => void) => (fired.push(fn), { id: fired.length })) as any,
    clearTimer: ((t: unknown) => void cleared.push(t)) as any,
  };
};
const exited = (error: any) => Object.assign(new Error('The browser stopped.'), { code: 'browser_exited', ...error });

test('Chromium missing a library is named by that library; a blocked sandbox says what to allow; anything else names nothing', () => {
  assert.match(
    String(launchFailure('/x/chrome: error while loading shared libraries: libgbm.so.1: cannot open shared object file')),
    /libgbm\.so\.1 is missing/,
  );
  assert.match(
    String(launchFailure('FATAL:zygote_host_impl_linux.cc:130] No usable sandbox! If you')),
    /apparmor_restrict_unprivileged_userns=0/,
  );
  assert.equal(launchFailure('segfault'), null);
  assert.equal(launchFailure(''), null);
  assert.equal(launchFailure(undefined), null);
  assert.equal(launchFailure({ message: 'No usable sandbox' }), null);
});

test('B1: an error that is not the browser ending, or no error at all, comes back as it was, without waiting', async () => {
  const t = timers();
  const other = Object.assign(new Error('denied'), { code: 'invalid' });
  assert.equal(await startFailure(other, new Promise(() => undefined), t), other);
  assert.equal(await startFailure(undefined, new Promise(() => undefined), t), undefined);
  assert.equal(t.fired.length, 0);
});

test('A3: the browser that ended with a known reason gives its message to the error; the wait timer is cleared', async () => {
  const t = timers();
  const error = exited({});
  const got = await startFailure(
    error,
    Promise.resolve({ code: 1, stderr: 'x: error while loading shared libraries: libatk-1.0.so.0: no' }),
    t,
  );
  assert.equal(got, error);
  assert.equal(got.code, 'browser_exited');
  assert.match(got.message, /libatk-1\.0\.so\.0 is missing/);
  assert.equal(t.cleared.length, 1);
});

test('A3: an exit that names nothing known, or none within the limit, keeps the plain message', async () => {
  const t = timers();
  const unknown = exited({});
  assert.equal((await startFailure(unknown, Promise.resolve({ code: 1, stderr: 'boom' }), t)).message, 'The browser stopped.');
  const silent = exited({});
  const waiting = startFailure(silent, new Promise(() => undefined), t);
  await new Promise((r) => setImmediate(r));
  t.fired.at(-1)!();
  assert.equal((await waiting).message, 'The browser stopped.');
  assert.equal(CAUSE_MS, 1000);
});
