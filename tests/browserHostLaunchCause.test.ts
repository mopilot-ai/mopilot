// A browser that cannot start says why (host/src/launchFailure.mjs, used by host/src/browserHost.mjs, package 2.6): on a Linux machine Chromium's own account of a missing library or a blocked sandbox reaches the person, not "The browser stopped.".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tick } from './support/async-scenarios.ts';
import { FakeChromium } from './support/fake-chromium.ts';
import { world, code } from './support/browser-service-kit.ts';

const LIB =
  '/h/chrome-headless-shell: error while loading shared libraries: libatk-1.0.so.0: cannot open shared object file: No such file or directory';
const SANDBOX =
  '[1029/102335.079175:FATAL:content/browser/zygote_host/zygote_host_impl_linux.cc:130] No usable sandbox! If you are running on Ubuntu 23.10+';

/** An open that is waiting on the browser's first command when the browser ends with `stderr`. */
async function openThatDies(stderr: string) {
  const w = world();
  w.chromium.stderr = stderr;
  w.chromium.hangs.add('Target.setDiscoverTargets');
  const opening = w.host.open('a');
  await tick();
  w.chromium.die('error');
  return { w, opening };
}

test('A2: a browser that ends at start because a library is missing says which one', async () => {
  const { opening } = await openThatDies(LIB);
  await assert.rejects(
    opening,
    (e: any) => code('browser_exited')(e) && /libatk-1\.0\.so\.0 is missing/.test(e.message) && !/stopped/.test(e.message),
  );
});

test('A2: a browser that ends at start because its sandbox is blocked says so, and what to allow', async () => {
  const { opening } = await openThatDies(SANDBOX);
  await assert.rejects(
    opening,
    (e: any) =>
      code('browser_exited')(e) && /sandbox is blocked/.test(e.message) && /apparmor_restrict_unprivileged_userns/.test(e.message),
  );
});

test('B1: a browser that ends with a reason nobody knows keeps the plain message', async () => {
  const { opening } = await openThatDies('segfault somewhere');
  await assert.rejects(opening, (e: any) => code('browser_exited')(e) && e.message === 'The browser stopped.');
});

test('A3: a start that ends with no account of why does not wait for one beyond the short limit', async () => {
  const w = world();
  const silent = new FakeChromium();
  silent.hangs.add('Target.setDiscoverTargets');
  const launched = world({
    launch: async () => ({ ...(await silent.launch()), exited: new Promise(() => undefined) }),
  });
  const opening = launched.host.open('a');
  await tick();
  silent.die('error');
  await tick();
  assert.deepEqual(launched.clock.pending(), [1000]);
  launched.clock.fire(1000);
  await assert.rejects(opening, (e: any) => code('browser_exited')(e) && e.message === 'The browser stopped.');
  void w;
});

test('the next open after a start that failed for a reason tries again, and a death while running keeps its plain message', async () => {
  const { w, opening } = await openThatDies(LIB);
  await assert.rejects(opening, code('browser_exited'));
  w.chromium.stderr = '';
  w.chromium.hangs.clear();
  const { targetId } = await w.host.open('a');
  assert.equal(w.chromium.launches, 2);
  w.chromium.stderr = LIB;
  w.chromium.hangs.add('Page.navigate');
  await w.host.attach('a', targetId);
  const waiting = w.host.command('a', { targetId, method: 'Page.navigate', params: { url: 'https://x.test/' } });
  await tick();
  w.chromium.die('error');
  await assert.rejects(waiting, (e: any) => code('browser_exited')(e) && e.message === 'The browser stopped.');
});

test('A1: chats that open at once share one start, and every one of them hears the cause', async () => {
  const w = world();
  w.chromium.stderr = LIB;
  w.chromium.hangs.add('Target.setDiscoverTargets');
  const opens = [w.host.open('a'), w.host.open('b')];
  const settled = Promise.allSettled(opens);
  await tick();
  w.chromium.die('error');
  const results = await settled;
  assert.equal(w.chromium.launches, 1);
  for (const r of results) assert.ok(r.status === 'rejected' && /libatk-1\.0\.so\.0 is missing/.test(r.reason.message));
});
