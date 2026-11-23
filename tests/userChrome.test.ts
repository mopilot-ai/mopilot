// electron/capabilities/browser/userChrome.cjs: the scratch Chrome folder a run is pinned to, Chrome started on it, and
// Electron's shell whose openExternal keeps pages there; and openSite.cjs's sign-in hand-off in such a run (#1535).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  pinnedChrome,
  chromeExecutable,
  openInChrome,
  openExternal,
  userShell,
  opensInBrowser,
} = require('../electron/capabilities/browser/userChrome.cjs');
const { openSiteForRoute } = require('../electron/capabilities/browser/openSite.cjs');

const SCRATCH = { MOPILOT_CHROME_RELAY_USER_DATA_DIR: '/w/chrome-profile' };
const BENCH_NO_DIR = { MOPILOT_SCRATCH_CHROME_REAL: '/chrome' };

/** A spawn that records each start and starts (or fails with `fail`). */
function spawner(fail = false) {
  const spawned: string[][] = [];
  const spawn: any = (cmd: string, args: string[]) => {
    spawned.push([cmd, ...args]);
    const child: any = new EventEmitter();
    child.unref = () => {};
    setImmediate(() => (fail ? child.emit('error', new Error('ENOENT')) : child.emit('spawn')));
    return child;
  };
  return { spawned, spawn };
}

test('pinnedChrome: the scratch folder a run named, a refusal for a bench run without one, else nothing', () => {
  assert.deepEqual(pinnedChrome({ MOPILOT_CHROME_RELAY_USER_DATA_DIR: '/w/x/../chrome-profile/' }), { dir: '/w/chrome-profile' });
  assert.match((pinnedChrome(BENCH_NO_DIR) as any).refuse, /names no scratch Chrome folder/);
  assert.equal(pinnedChrome({}), null);
  assert.equal(pinnedChrome(), pinnedChrome(process.env));
});

test('opensInBrowser: pages and files go to a browser; app links do not', () => {
  for (const u of ['https://a.test/', 'HTTP://a.test/', 'file:///tmp/a.html']) assert.equal(opensInBrowser(u), true, u);
  for (const u of ['mailto:a@b.c', 'zoommtg://x', 'x-apple.systempreferences:com.apple.preference.security'])
    assert.equal(opensInBrowser(u), false, u);
});

test('openInChrome: Chrome is started with the URL in the profile Your Chrome uses (or a scratch one), per platform', async () => {
  assert.equal(chromeExecutable({ platform: 'darwin', env: {} }), '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  assert.equal(
    chromeExecutable({ platform: 'win32', env: { ProgramFiles: 'D:\\Apps' } }),
    'D:\\Apps\\Google\\Chrome\\Application\\chrome.exe',
  );
  assert.equal(chromeExecutable({ platform: 'win32', env: {} }), 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
  assert.equal(chromeExecutable({ platform: 'linux', env: {} }), 'google-chrome');
  assert.equal(chromeExecutable({ env: { MOPILOT_CHROME_RELAY_EXECUTABLE: '/x/chrome' } }), '/x/chrome');
  assert.equal(typeof chromeExecutable(), 'string');
  const spawned: any[] = [];
  const spawn: any = (cmd: string, args: string[], opts: any) => {
    const child: any = new EventEmitter();
    child.unref = () => (child.unrefd = true);
    spawned.push({ cmd, args, opts, child });
    setImmediate(() => (cmd === 'fail' ? child.emit('error', new Error('ENOENT')) : child.emit('spawn')));
    return child;
  };
  await openInChrome('chrome-extension://x/connect.html', {
    profileDir: 'Profile 2',
    env: { MOPILOT_CHROME_RELAY_USER_DATA_DIR: '/tmp/scratch' },
    platform: 'linux',
    spawn,
  });
  assert.deepEqual(spawned[0].args, ['--user-data-dir=/tmp/scratch', '--profile-directory=Profile 2', 'chrome-extension://x/connect.html']);
  assert.equal(spawned[0].opts.detached, true);
  assert.equal(spawned[0].child.unrefd, true);
  await openInChrome('u', { env: {}, platform: 'darwin', spawn });
  assert.deepEqual(spawned[1].args, ['u']);
  await assert.rejects(openInChrome('u', { env: { MOPILOT_CHROME_RELAY_EXECUTABLE: 'fail' }, spawn }), /ENOENT/);
});

test('openInChrome: a bench run without a scratch folder starts no Chrome', async () => {
  const { spawned, spawn } = spawner();
  await assert.rejects(openInChrome('https://a.test/', { env: BENCH_NO_DIR, spawn }), /names no scratch Chrome folder/);
  assert.deepEqual(spawned, []);
});

test('openExternal: a real user’s link goes to the system; in a pinned run a page opens in the scratch Chrome', async () => {
  const system: string[] = [];
  const opened: any[] = [];
  const o = (env: any) => ({
    env,
    openExternal: async (u: string) => void system.push(u),
    open: async (u: string, p: any) => void opened.push([u, p]),
  });
  await openExternal('https://a.test/', o({}));
  await openExternal('https://b.test/', o(SCRATCH));
  // an app link opens its app in every run: no browser profile is involved
  await openExternal('mailto:a@b.c', o(SCRATCH));
  assert.deepEqual(system, ['https://a.test/', 'mailto:a@b.c']);
  assert.deepEqual(opened, [['https://b.test/', { env: SCRATCH }]]);
  // a bench run without a folder: refused by openInChrome, never the default browser
  const { spawned, spawn } = spawner();
  await assert.rejects(
    openExternal('https://c.test/', {
      env: BENCH_NO_DIR,
      openExternal: async () => assert.fail('default browser'),
      open: (u: string, p: any) => openInChrome(u, { ...p, spawn }),
    }),
    /names no scratch Chrome folder/,
  );
  assert.deepEqual(spawned, []);
});

test('userShell: openExternal goes through the guard with its options; the shell’s other methods run on the shell itself', async () => {
  const calls: any[] = [];
  const shell = {
    who: 'shell',
    openExternal: async (...a: any[]) => void calls.push(['open', ...a]),
    openPath(this: any, p: string) {
      calls.push(['path', p, this.who]);
      return '';
    },
  };
  const guarded = userShell(shell);
  await guarded.openExternal('https://a.test/', { activate: false });
  assert.equal(guarded.openPath('/tmp/x'), '');
  assert.equal(guarded.who, 'shell');
  // one bound copy of each method, so it compares equal to itself
  assert.equal(guarded.openPath, guarded.openPath);
  assert.deepEqual(calls, [
    ['open', 'https://a.test/', { activate: false }],
    ['path', '/tmp/x', 'shell'],
  ]);
  // a call without options passes none on
  await guarded.openExternal('https://b.test/');
  assert.deepEqual(calls.at(-1), ['open', 'https://b.test/']);
  // a stand-in Electron without a shell keeps none
  assert.equal(userShell(undefined), undefined);
});

test('openSiteForRoute in a pinned run: every route opens Chrome on the scratch folder, a vendor’s in its profile there, with no fallback', async () => {
  const opened: any[] = [];
  const lookedIn: any[] = [];
  const o = (extra: any = {}) => ({
    env: SCRATCH,
    openExternal: async () => assert.fail('the default browser opens the default folder'),
    openInChrome: async (u: string, p: any) => void opened.push([u, p]),
    vendorProfile: (c: string, userData?: string) => {
      lookedIn.push([c, userData]);
      return c === 'claude-in-chrome' ? { browser: 'chrome', name: 'Google Chrome', profile: 'Profile 2' } : null;
    },
    profileDir: 'Profile 3',
    platform: 'darwin',
    spawn: () => assert.fail('open -na starts Chrome on the default folder'),
    ...extra,
  });
  await openSiteForRoute('https://a.test/', 'claude-in-chrome', o());
  await openSiteForRoute('https://b.test/', 'codex-browser-plugin', o());
  await openSiteForRoute('https://c.test/', 'extension', o());
  await openSiteForRoute('https://d.test/', 'claude-in-chrome', o({ platform: 'win32' }));
  assert.deepEqual(opened, [
    ['https://a.test/', { profileDir: 'Profile 2' }],
    // the vendor's extension isn't in the scratch folder: Chrome opens there on its last profile, not elsewhere
    ['https://b.test/', { profileDir: '' }],
    ['https://c.test/', { profileDir: 'Profile 3' }],
    ['https://d.test/', { profileDir: 'Profile 2' }],
  ]);
  assert.deepEqual(lookedIn, [
    ['claude-in-chrome', '/w/chrome-profile'],
    ['codex-browser-plugin', '/w/chrome-profile'],
    ['claude-in-chrome', '/w/chrome-profile'],
  ]);
  // Chrome didn't start: the hand-off fails (handoff.cjs says so) rather than opening the default browser
  await assert.rejects(
    openSiteForRoute('https://e.test/', 'claude-in-chrome', o({ openInChrome: async () => Promise.reject(new Error('no Chrome')) })),
    /no Chrome/,
  );
  // a bench run that named no folder opens nothing at all
  await assert.rejects(
    openSiteForRoute('https://f.test/', 'relay', o({ env: BENCH_NO_DIR, openInChrome: async () => assert.fail('Chrome') })),
    /names no scratch Chrome folder/,
  );
});
