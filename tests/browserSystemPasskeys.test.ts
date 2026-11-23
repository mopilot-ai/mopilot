// macOS's passkey sheet for the built-in browser, app-wide (systemPasskeys.cjs: loading, the switch, one sheet at a
// time, timeouts, a cancel macOS never answers) and its setup per browser session (auth.cjs). One page's bridge is in
// browserPasskeyBridge.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sp = require('../electron/capabilities/browser/systemPasskeys.cjs');
const { configureBrowserAuth } = require('../electron/capabilities/browser/auth.cjs');
const { recentIgnored, clearIgnored } = require('../electron/ignored.cjs');

/** A passkeys.node whose sheets wait until the test answers them. */
function fakeAddon(caps: any = { entitlement: true, platform: true, securityKey: true }) {
  const starts: any[] = [];
  const cancels: number[] = [];
  const addon = {
    available: () =>
      caps instanceof Error
        ? (() => {
            throw caps;
          })()
        : caps,
    start(json: string, win: any, cb: (json: string) => void) {
      if (addon.refuse) throw addon.refuse;
      starts.push({ request: JSON.parse(json), win, cb });
      return starts.length;
    },
    cancel(handle: number) {
      cancels.push(handle);
      if (addon.cancelThrows) throw new Error('gone');
    },
    refuse: null as any,
    cancelThrows: false,
  };
  return { addon, starts, cancels };
}

/** Timers the test runs by hand. */
function timers() {
  const pending = new Map<number, () => void>();
  let n = 0;
  return {
    pending,
    setTimer: ((fn: () => void) => (pending.set(++n, fn), n)) as any,
    clearTimer: ((id: number) => pending.delete(id)) as any,
    fire(id: number) {
      const fn = pending.get(id);
      pending.delete(id);
      fn?.();
    },
  };
}

test('auth: every browser session sets up the one app-wide module, with the window showing each page', () => {
  const { addon } = fakeAddon();
  const view = { id: 'view-window' };
  const host = { id: 'host' };
  const own = { id: 'own' };
  const BrowserWindow = { fromWebContents: (wc: any) => (wc === 'host-wc' ? host : wc?.id === 'popup' ? own : null) };
  const state = configureBrowserAuth({
    app: { isPackaged: false },
    session: new EventEmitter(),
    dialog: {},
    BrowserWindow,
    webContents: {},
    browserWindows: {},
    viewWindow: (wc: any) => (wc.id === 'view' ? view : wc.id === 'parked' ? null : undefined),
    platform: 'linux',
    loadAddon: () => addon,
  });
  const shared = sp.systemPasskeys();
  // the switch is on by default, and this signature holds the entitlement
  assert.deepEqual(shared.caps(), { platform: true, securityKey: true });
  assert.equal(shared.legacy(), false);
  state.touchId = true;
  assert.equal(shared.legacy(), true);
  const wc = (id: string, type = 'window', hostWebContents: any = null) => ({
    id,
    isDestroyed: () => id === 'gone',
    getType: () => type,
    hostWebContents,
  });
  assert.equal(shared.anchor(wc('view')), view);
  assert.equal(shared.anchor(wc('parked')), null, 'a parked view shows nowhere');
  assert.equal(shared.anchor(wc('guest', 'webview', 'host-wc')), host);
  assert.equal(shared.anchor(wc('popup')), own);
  assert.equal(shared.anchor(wc('gone')), null);
  // a chat's own partition keeps it (and any sheet it has up)
  configureBrowserAuth({
    app: {},
    session: new EventEmitter(),
    BrowserWindow,
    viewWindow: () => undefined,
    platform: 'linux',
    loadAddon: () => null,
  });
  assert.equal(sp.systemPasskeys(), shared);
  // the default loader asks for the real addon on macOS only
  configureBrowserAuth({ app: {}, session: new EventEmitter(), BrowserWindow, viewWindow: () => undefined, platform: 'linux' });
});

test('loading: passkeys.node on macOS only, from Contents/Helpers or the checkout’s build', () => {
  const asked: string[] = [];
  const load = (p: string) => (asked.push(p), { loaded: p });
  assert.equal(sp.loadPasskeyAddon({ platform: 'linux', load }), null);
  assert.deepEqual(sp.loadPasskeyAddon({ platform: 'darwin', packaged: true, resourcesPath: '/A.app/Contents/Resources', load }), {
    loaded: '/A.app/Contents/Helpers/passkeys.node',
  });
  sp.loadPasskeyAddon({ platform: 'darwin', load });
  assert.match(asked[1], /native\/passkeys\/build\/passkeys\.node$/);
  assert.equal(typeof sp.loadPasskeyAddon, 'function');
  // the defaults: this platform, a checkout
  assert.doesNotThrow(() => {
    try {
      sp.loadPasskeyAddon();
    } catch {
      // not built in this checkout
    }
  });
});

test('capabilities: nothing without the addon, the switch, the entitlement or macOS 13.5', () => {
  clearIgnored();
  const none = sp.createSystemPasskeys();
  assert.equal(none.caps(), null);
  assert.equal(none.legacy(), false);
  assert.equal(none.anchor({}), null);
  assert.deepEqual(none.run({}, null, 1), { busy: true });
  const failing = sp.createSystemPasskeys({
    load: () => {
      throw new Error('not built');
    },
    enabled: () => true,
  });
  assert.equal(failing.caps(), null);
  assert.equal(failing.caps(), null, 'loaded once');
  assert.deepEqual(
    recentIgnored()
      .filter((e: any) => /passkey bridge/.test(e.context))
      .map((e: any) => e.count),
    [1],
  );
  const off = sp.createSystemPasskeys({ load: () => fakeAddon().addon, enabled: () => false });
  assert.equal(off.caps(), null);
  for (const caps of [
    { entitlement: false, platform: true, securityKey: true },
    { entitlement: true, platform: false, securityKey: true },
    null,
    new Error('broken'),
  ]) {
    const s = sp.createSystemPasskeys({ load: () => fakeAddon(caps).addon, enabled: () => true });
    assert.equal(s.caps(), null);
  }
  const old = sp.createSystemPasskeys({
    load: () => fakeAddon({ entitlement: true, platform: true, securityKey: false }).addon,
    enabled: () => true,
  });
  assert.deepEqual(old.caps(), { platform: true, securityKey: false });
  // the signature and macOS can't change while the app runs: asked once, while the switch is read each time
  let asked = 0;
  let on = true;
  const once = sp.createSystemPasskeys({
    load: () => ({ available: () => (asked++, { entitlement: true, platform: true, securityKey: true }) }),
    enabled: () => on,
  });
  once.caps();
  once.caps();
  on = false;
  assert.equal(once.caps(), null);
  assert.equal(asked, 1);
});

test('one sheet at a time: a second request is refused; the slot frees when macOS answers', async () => {
  const { addon, starts, cancels } = fakeAddon();
  const t = timers();
  const s = sp.createSystemPasskeys({ load: () => addon, enabled: () => true, setTimer: t.setTimer, clearTimer: t.clearTimer });
  const win = Buffer.from('window');
  const first = s.run({ kind: 'get' }, win, 60_000);
  assert.equal(s.busy(), true);
  assert.deepEqual(starts[0].request, { kind: 'get' });
  assert.equal(starts[0].win, win);
  assert.deepEqual(s.run({ kind: 'get' }, win, 60_000), { busy: true });
  starts[0].cb(JSON.stringify({ ok: true, kind: 'get' }));
  assert.deepEqual(await first.answer, { ok: true, kind: 'get' });
  assert.equal(s.busy(), false);
  assert.equal(t.pending.size, 0, 'its timeout is cleared');
  // a cancel after the answer does nothing
  first.cancel();
  assert.deepEqual(cancels, []);

  // a malformed answer is an unknown error
  const second = s.run({ kind: 'create' }, null, 60_000);
  starts[1].cb('{');
  assert.deepEqual(await second.answer, { ok: false, code: 1000 });

  // the page's timeout closes the sheet; macOS answers the cancel with its own error
  const third = s.run({ kind: 'get' }, null, 30_000);
  const [timeout] = [...t.pending.keys()];
  t.fire(timeout);
  assert.deepEqual(cancels, [3]);
  assert.equal(s.busy(), true, 'the slot waits for macOS');
  starts[2].cb(JSON.stringify({ ok: false, code: 1001 }));
  assert.deepEqual(await third.answer, { ok: false, code: 1001 });
  assert.equal(s.busy(), false);
  assert.equal(t.pending.size, 0);
});

test('a cancel macOS never answers frees the slot after a grace period; a failed start or cancel is noted', async () => {
  clearIgnored();
  const { addon, starts, cancels } = fakeAddon();
  const t = timers();
  const s = sp.createSystemPasskeys({ load: () => addon, enabled: () => true, setTimer: t.setTimer, clearTimer: t.clearTimer });
  const run = s.run({}, null, 60_000);
  addon.cancelThrows = true;
  run.cancel();
  run.cancel();
  assert.deepEqual(cancels, [1, 1]);
  assert.deepEqual(
    recentIgnored()
      .filter((e: any) => /close macOS's passkey sheet/.test(e.context))
      .map((e: any) => e.count),
    [2],
  );
  const grace = [...t.pending.keys()].at(-1)!;
  t.fire(grace);
  assert.deepEqual(await run.answer, { ok: false, code: 1001 });
  assert.equal(s.busy(), false);
  // macOS's answer arriving afterwards changes nothing, and a new sheet is not taken for it
  const next = s.run({}, null, 60_000);
  starts[0].cb(JSON.stringify({ ok: true }));
  assert.equal(s.busy(), true);
  starts[1].cb(JSON.stringify({ ok: true, second: true }));
  assert.deepEqual(await next.answer, { ok: true, second: true });

  addon.refuse = new Error('no authenticator can serve this request');
  const refused = s.run({}, null, 60_000);
  assert.deepEqual(await refused.answer, { ok: false, code: 1000 });
  refused.cancel();
  assert.equal(s.busy(), false);
  assert.ok(recentIgnored().some((e: any) => /show macOS's passkey sheet/.test(e.context)));
  assert.equal(sp.CANCEL_GRACE, 10_000);
});
