// CM-Z30: MoPilot's Chrome extension pairing page opens only into a Chrome profile that has the extension on (#1319 G29).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { memoryPairing } from './support/chrome-extension-kit.ts';

export const GUARDS = ['electron/capabilities/', 'electron/chrome-extension/', 'shared/'];

const require = createRequire(import.meta.url);
const { ChromeExtensionChannel } = require('../electron/capabilities/browser/chromeExtension.cjs');

const worlds: any[] = [];
after(() => {
  for (const w of worlds) w.stop();
});

test('CM-Z30: the pairing page never opens into a Chrome profile without the extension on; the error says to install or turn it on (#1319 G29)', async () => {
  const channel = (installed: () => unknown) => {
    const opened: string[] = [];
    const ch = new ChromeExtensionChannel({
      pairing: memoryPairing(),
      openPage: async (url: string) => opened.push(url),
      installHint: 'Load it unpacked.',
      installed,
      connectMs: 200,
      port: 0,
    });
    worlds.push({ stop: () => ch.stop() });
    return { ch, opened };
  };
  // missing: no page (Chrome would block it: ERR_BLOCKED_BY_CLIENT), and the error names the install step
  let state: any = 'missing';
  const a = channel(() => state);
  await assert.rejects(a.ch.connect('c'), /isn't installed in the Chrome profile MoPilot uses.*Load it unpacked\./);
  assert.deepEqual(a.opened, []);
  // installed but turned off: no page either, and the error says where to turn it on
  state = 'off';
  await assert.rejects(a.ch.connect('c'), /is turned off .* chrome:\/\/extensions/);
  assert.deepEqual(a.opened, []);
  // once it is on (the user installed it meanwhile), the next wait offers the pairing page as before
  state = 'on';
  await assert.rejects(a.ch.connect('c'), /isn't paired\. MoPilot opened/);
  assert.equal(a.opened.length, 1);
  // a profile that can't be read, or a check that fails, decides nothing: the page is offered
  for (const installed of [
    () => null,
    () => {
      throw new Error('EACCES');
    },
  ]) {
    const b = channel(installed);
    await assert.rejects(b.ch.connect('c'), /isn't paired/);
    assert.equal(b.opened.length, 1);
  }
});

// Timers run on the event loop's monotonic clock and the pairing throttle reads Date.now(), the wall clock: each is
// floored to whole milliseconds from its own origin (and NTP may slew the wall clock), so a wait's timer can fire
// before Date.now() has moved connectMs past the offer. Holding Date.now() still makes that order certain (#1531, the
// CI flake: the next wait saw the last wait's profile state).
test('CM-Z30: each wait reads the profile again, also when its timer fires before the wall clock moved connectMs past the last offer (#1531)', async (t) => {
  let state: any = 'missing';
  const opened: string[] = [];
  const ch = new ChromeExtensionChannel({
    pairing: memoryPairing(),
    openPage: async (url: string) => opened.push(url),
    installed: () => state,
    connectMs: 30,
    port: 0,
  });
  worlds.push({ stop: () => ch.stop() });
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  await assert.rejects(ch.connect('c'), /isn't installed/);
  state = 'off';
  await assert.rejects(ch.connect('c'), /is turned off/);
  state = 'on';
  await assert.rejects(ch.connect('c'), /isn't paired\. MoPilot opened/);
  assert.equal(opened.length, 1);
});

test('CM-Z30: the extension turned on while another chat still waits: the next wait offers the page at once and every error says what is true now; a burst still opens it once (#1531)', async (t) => {
  let state: any = 'missing';
  const opened: string[] = [];
  const pairing = memoryPairing();
  const ch = new ChromeExtensionChannel({
    pairing,
    openPage: async (url: string) => opened.push(url),
    installed: () => state,
    connectMs: 45_000,
    port: 0,
  });
  worlds.push({ stop: () => ch.stop() });
  await ch.start();
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const settled = (p: Promise<unknown>) =>
    p.then(
      () => assert.fail('connected'),
      (error: Error) => error.message,
    );
  // chat a waits while the extension is missing: no page
  const a = settled(ch.connect('a'));
  await flush();
  assert.deepEqual(opened, []);
  // the user installs it and turns it on; chat b asks 10 s later, within a's wait
  state = 'on';
  t.mock.timers.tick(10_000);
  const b = settled(ch.connect('b'));
  await flush();
  assert.equal(opened.length, 1, 'the page opens for the extension that is on now');
  // a third chat in the same burst: the page is not opened again
  const c = settled(ch.connect('c'));
  await flush();
  assert.equal(opened.length, 1);
  // turned off again before a fourth chat asks: no page, and its error says so
  state = 'off';
  const d = settled(ch.connect('d'));
  await flush();
  assert.equal(opened.length, 1);
  t.mock.timers.tick(45_000);
  assert.match(await d, /is turned off/);
  // the earlier waits end with what was last read, not with what the first wait saw
  for (const p of [a, b, c]) assert.match(await p, /is turned off/);
  // on again after the window: the page is offered again
  state = 'on';
  t.mock.timers.tick(45_000);
  const e = settled(ch.connect('e'));
  await flush();
  assert.equal(opened.length, 2);
  t.mock.timers.tick(45_000);
  assert.match(await e, /isn't paired\. MoPilot opened/);
  // a pairing that can't be read offers no page, and the profile is still read: the error says what is true now
  pairing.set(null);
  state = 'missing';
  const f = settled(ch.connect('f'));
  await flush();
  t.mock.timers.tick(45_000);
  assert.match(await f, /isn't installed/);
  assert.equal(opened.length, 2);
});

test('CM-Z30: a paired wait never reports an earlier wait’s reading of the profile, and a stop lets the next wait offer the page (#1531)', async (t) => {
  let state: any = 'missing';
  const opened: string[] = [];
  const pairing = memoryPairing();
  const ch = new ChromeExtensionChannel({
    pairing,
    openPage: async (url: string) => opened.push(url),
    installed: () => state,
    connectMs: 45_000,
    graceMs: 60_000,
    port: 0,
  });
  worlds.push({ stop: () => ch.stop() });
  await ch.start();
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const settled = (p: Promise<unknown>) =>
    p.then(
      () => assert.fail('connected'),
      (error: Error) => error.message,
    );
  const a = settled(ch.connect('a'));
  await flush();
  t.mock.timers.tick(45_000);
  assert.match(await a, /isn't installed/);
  // the user installs and pairs it, then Chrome closes: the paired wait ends before its grace offer
  state = 'on';
  pairing.markPaired();
  const b = settled(ch.connect('b'));
  await flush();
  t.mock.timers.tick(45_000);
  assert.match(await b, /did not connect within 45 s/);
  // unpaired again: a wait opens the page; MoPilot's channel stops and starts while it still waits
  pairing.set({ ...pairing.get(), paired: false });
  const c = settled(ch.connect('c'));
  await flush();
  assert.equal(opened.length, 1);
  ch.stop();
  await ch.start();
  const d = settled(ch.connect('d'));
  await flush();
  assert.equal(opened.length, 2, 'the page opens again after the restart');
  t.mock.timers.tick(45_000);
  await Promise.all([c, d]);
});
