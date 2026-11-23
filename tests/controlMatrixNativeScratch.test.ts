// The control matrix, group E (docs/control-plane/matrix.md): the Chrome comparison's native arm runs Claude in Chrome
// and the ChatGPT extension in a scratch Chrome profile (MOPILOT_CHROME_RELAY_USER_DATA_DIR), never the user's own.
// MoPilot's native-availability probe and the Codex Chrome pick read the vendors' hosts and extensions there too,
// so a Claude Code session gets Claude in Chrome (not --no-chrome) and a native Codex thread gets the Chrome surface,
// with the scratch profile's ChatGPT extension named by id. Real temporary folders; no browser starts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { chromeGuard } from '../bench/lib/contract.mjs';

export const GUARDS = ['bench/', 'electron/'];

const require = createRequire(import.meta.url);
const { chromiumUserDataDirs, vendorChromeUserDataDirs } = require('../electron/capabilities/browser/chromiumBrowsers.cjs');
const { probeNativeAvailability, vendorChromeProfile } = require('../electron/capabilities/nativeAvailability/probe.cjs');
const { chatgptExtensionInstances, CHATGPT_EXTENSION_ID } = require('../electron/capabilities/browser/codexChromePick.cjs');
const { openInChrome, userShell } = require('../electron/capabilities/browser/userChrome.cjs');
const { openSiteForRoute } = require('../electron/capabilities/browser/openSite.cjs');

const CLAUDE_EXT = 'fcoeoabgfenejglbffodgkkbkcdhcgfn';
const SCRATCH_ID = '71702c04-edf8-48e2-9484-32eac68d6fbd';
const CHROME_ID = '61d140d8-b711-4bfb-bb41-11756f2e0db2';

const write = (p: string, text: string) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
};

/**
 * A Chrome user data folder as the native arm prepares it: both vendors' host manifests in its own
 * NativeMessagingHosts (naming programs that exist), and both extensions installed and on in its Default profile.
 */
function vendorProfile(dir: string, bin: string) {
  write(bin, '');
  const host = (name: string, id: string) =>
    write(
      path.join(dir, 'NativeMessagingHosts', `${name}.json`),
      JSON.stringify({ name, path: bin, type: 'stdio', allowed_origins: [`chrome-extension://${id}/`] }),
    );
  host('com.anthropic.claude_code_browser_extension', CLAUDE_EXT);
  host('com.openai.codexextension', CHATGPT_EXTENSION_ID);
  for (const id of [CLAUDE_EXT, CHATGPT_EXTENSION_ID]) write(path.join(dir, 'Default', 'Extensions', id, '1.0', 'manifest.json'), '{}');
  write(
    path.join(dir, 'Default', 'Secure Preferences'),
    JSON.stringify({
      extensions: { settings: { [CLAUDE_EXT]: { disable_reasons: [] }, [CHATGPT_EXTENSION_ID]: { disable_reasons: [] } } },
    }),
  );
}

/** The ChatGPT extension's instance id in a profile's Local Extension Settings, as Chrome's leveldb log holds it. */
const instance = (profileDir: string, id: string) =>
  write(path.join(profileDir, 'Local Extension Settings', CHATGPT_EXTENSION_ID, '000003.log'), `\u0001extensionInstanceId&"${id}"\u0000`);

/** A home with nothing in Chrome's own folder, and a scratch profile outside it; removed afterwards. */
function withHome(run: (home: string, scratch: string) => void) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'native-scratch-'));
  try {
    run(home, path.join(home, 'chrome-compare-profile'));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('CM-E18: the scratch profile MoPilot was pointed at comes first among the folders a vendor Chrome controller can be in, once', () => {
  const home = '/Users/u';
  const own = chromiumUserDataDirs({ home, platform: 'darwin' });
  // unset: the browsers' own folders, as before
  assert.deepEqual(vendorChromeUserDataDirs({ home, platform: 'darwin', env: {} }), own);
  const scratch = vendorChromeUserDataDirs({ home, platform: 'darwin', env: { MOPILOT_CHROME_RELAY_USER_DATA_DIR: '/Users/u/scratch/' } });
  assert.deepEqual(scratch[0], { id: 'chrome', name: 'Google Chrome', dir: '/Users/u/scratch' });
  assert.deepEqual(scratch.slice(1), own);
  // a folder that is one of the browsers' own is listed once, first
  const same = vendorChromeUserDataDirs({ home, platform: 'darwin', env: { MOPILOT_CHROME_RELAY_USER_DATA_DIR: own[0].dir } });
  assert.equal(same.length, own.length);
  assert.equal(same[0].dir, own[0].dir);
  // without o.env it reads this process's environment
  const saved = process.env.MOPILOT_CHROME_RELAY_USER_DATA_DIR;
  process.env.MOPILOT_CHROME_RELAY_USER_DATA_DIR = '/tmp/from-env';
  try {
    assert.equal(vendorChromeUserDataDirs({ home, platform: 'darwin' })[0].dir, '/tmp/from-env');
  } finally {
    if (saved === undefined) delete process.env.MOPILOT_CHROME_RELAY_USER_DATA_DIR;
    else process.env.MOPILOT_CHROME_RELAY_USER_DATA_DIR = saved;
  }
});

test('CM-E19: Claude in Chrome and the Codex Browser plugin read as ready from the scratch profile the native arm runs them in', () => {
  withHome((home, scratch) => {
    vendorProfile(scratch, path.join(home, 'hosts', 'host'));
    const probe = (env: Record<string, string>) => probeNativeAvailability({ home, platform: 'darwin', appDirs: [], env });
    // Chrome's own folder has neither: without the scratch profile, Claude Code would run with --no-chrome
    const none = probe({});
    assert.equal(none.claude.chrome.ready, false);
    assert.equal(none.codex.chrome.ready, false);
    const facts = probe({ MOPILOT_CHROME_RELAY_USER_DATA_DIR: scratch });
    assert.deepEqual(facts.claude.chrome, { host: true, extension: true, enabled: true, ready: true });
    assert.deepEqual(facts.codex.chrome, { host: true, extension: true, enabled: true, ready: true });
    // the browsers' own folders are never searched for a scratch profile's name: `open -na` would start the user's Chrome
    assert.equal(
      vendorChromeProfile('claude-in-chrome', { home, platform: 'darwin', env: { MOPILOT_CHROME_RELAY_USER_DATA_DIR: scratch } }),
      null,
    );
    // the pinned run's hand-off asks for the scratch folder itself, and Chrome opens there in the extension's profile
    // (openSite.cjs, CM-E21)
    assert.deepEqual(vendorChromeProfile('codex-browser-plugin', { home, platform: 'darwin', userData: scratch }), {
      browser: 'chrome',
      name: 'Google Chrome',
      profile: 'Default',
    });
  });
});

test('CM-E20: a native Codex thread is told the scratch profile’s ChatGPT extension id, beside Google Chrome’s own', () => {
  withHome((home, scratch) => {
    instance(path.join(scratch, 'Default'), SCRATCH_ID);
    instance(path.join(home, 'Library', 'Application Support', 'Google', 'Chrome', 'Profile 1'), CHROME_ID);
    assert.deepEqual(chatgptExtensionInstances({ home, platform: 'darwin', env: {} }).chrome, [CHROME_ID]);
    assert.deepEqual(chatgptExtensionInstances({ home, platform: 'darwin', env: { MOPILOT_CHROME_RELAY_USER_DATA_DIR: scratch } }).chrome, [
      SCRATCH_ID,
      CHROME_ID,
    ]);
  });
});

test('CM-E21: a bench run opens every sign-in hand-off and every link in Chrome on its scratch folder, never the default profile', async () => {
  // the environment bench/drivers/contract.mjs gives an instance: Chrome only through bench/scratch-chrome.mjs
  const bench = {
    MOPILOT_CHROME_RELAY_USER_DATA_DIR: '/w/chrome-profile',
    MOPILOT_CHROME_RELAY_EXECUTABLE: '/repo/bench/scratch-chrome.mjs',
    MOPILOT_SCRATCH_CHROME_REAL: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    // MoPilot's extension, loaded into every Chrome the wrapper starts (#1587)
    MOPILOT_SCRATCH_CHROME_EXTENSION: '/repo/electron/chrome-extension',
    MOPILOT_SCRATCH_CHROME_PAIR: '1',
  };
  const started: string[][] = [];
  const spawn: any = (cmd: string, args: string[]) => {
    started.push([cmd, ...args]);
    const child: any = new EventEmitter();
    child.unref = () => {};
    setImmediate(() => child.emit('spawn'));
    return child;
  };
  const system: string[] = [];
  const chrome = (env: Record<string, string>) => (u: string, p: any) => openInChrome(u, { ...p, env, spawn, platform: 'darwin' });
  const site = (route: string, env: Record<string, string>) =>
    openSiteForRoute(`https://${route}.test/`, route, {
      env,
      platform: 'darwin',
      openExternal: async (u: string) => void system.push(u),
      openInChrome: chrome(env),
      vendorProfile: (_c: string, userData?: string) =>
        userData ? null : { browser: 'chrome', name: 'Google Chrome', profile: 'Default' },
      profileDir: 'Profile 1',
      spawn,
    });
  for (const route of ['claude-in-chrome', 'codex-browser-plugin', 'extension', 'relay', 'codex-extension']) await site(route, bench);
  // a link the app opens (sign-in pages, "Open in your browser", the pairing page, Help) goes the same way
  const shell = userShell({ openExternal: async (u: string) => void system.push(u) }, { env: bench, open: chrome(bench) });
  await shell.openExternal('https://link.test/');
  assert.deepEqual(system, [], 'the default browser opens the default profile');
  assert.equal(started.length, 6);
  for (const [cmd, ...args] of started) {
    assert.equal(cmd, bench.MOPILOT_CHROME_RELAY_EXECUTABLE, 'only the guard executable starts Chrome; never `open -na`');
    assert.deepEqual(
      chromeGuard(args, bench),
      { chrome: bench.MOPILOT_SCRATCH_CHROME_REAL, extension: bench.MOPILOT_SCRATCH_CHROME_EXTENSION, pair: true },
      args.join(' '),
    );
    assert.equal(args[0], '--user-data-dir=/w/chrome-profile');
  }
  // a bench run that named no scratch folder starts nothing and opens nothing
  const { MOPILOT_CHROME_RELAY_USER_DATA_DIR: _dir, ...noDir } = bench;
  for (const route of ['claude-in-chrome', 'relay']) await assert.rejects(site(route, noDir), /names no scratch Chrome folder/);
  const late: string[] = [];
  const unpinned = userShell({ openExternal: async (u: string) => void late.push(u) }, { env: noDir, open: chrome(noDir) });
  await assert.rejects(unpinned.openExternal('https://link.test/'), /names no scratch Chrome folder/);
  assert.equal(started.length, 6);
  assert.deepEqual(late, []);
});

test('CM-E22: main takes Electron’s shell only behind the scratch-Chrome guard (userShell) and starts Chrome with a profile in two places, so nothing reaches the default profile in a pinned run', () => {
  const root = path.join(import.meta.dirname, '..', 'electron');
  const files = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      return e.isDirectory() ? files(p) : /\.c?js$/.test(e.name) ? [p] : [];
    });
  const raw: string[] = [];
  const starts: string[] = [];
  for (const file of files(root)) {
    const text = fs.readFileSync(file, 'utf8');
    const rel = path.relative(root, file);
    for (const m of text.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=\s*require\('electron'\)/g)) {
      const shell = /\bshell\b(?:\s*:\s*(\w+))?/.exec(m[1]);
      if (!shell) continue;
      // taken as-is, or renamed and never wrapped
      if (!shell[1] || !new RegExp(`userShell\\(${shell[1]}\\)`).test(text)) raw.push(rel);
    }
    if (/require\('electron'\)\.shell\b|\belectron\.shell\b/.test(text)) raw.push(rel);
    // Chrome is started with a profile only here: userChrome.cjs (on the pinned folder) and openSite.cjs (a real user's
    // vendor profile, after the pinned run has taken its own way)
    if (/--profile-directory=|--user-data-dir=/.test(text)) starts.push(rel);
  }
  assert.deepEqual(raw, []);
  assert.deepEqual(starts.sort(), [
    path.join('capabilities', 'browser', 'openSite.cjs'),
    path.join('capabilities', 'browser', 'userChrome.cjs'),
  ]);
});
