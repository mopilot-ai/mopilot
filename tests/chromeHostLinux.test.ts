// The Linux counterpart of the Chrome native host's checks (browser/chromeHostLinux.cjs, chromeNativeHost.cjs): the E2E-only gate, the /proc check against a fake /proc, the app wiring, and that macOS is unchanged.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { STORE, request } from './support/native-host-kit.ts';
import { emptyChromeFolder, memoryPairing } from './support/chrome-extension-kit.ts';
import { until } from './support/chrome-relay-kit.ts';
import { fakeCore, ancestryOf } from './support/fake-core.ts';

const require = createRequire(import.meta.url);
const hl = require('../electron/capabilities/browser/chromeHostLinux.cjs');
const nh = require('../electron/capabilities/browser/chromeNativeHost.cjs');
const appRelay = require('../electron/app/chromeRelay.cjs');
const { DEV_EXTENSION_ID } = require('../electron/capabilities/browser/chromeExtensionIds.cjs');

const CHROME = '/opt/google/chrome/chrome';
const SAGE = '/repo/native/sage-mcp/build/sage-mcp';
const UID = 1001;
const NOT = 'the host was not started by Google Chrome';
const ENV: Record<string, string> = {
  SAGE_E2E_BACKGROUND: '1',
  MOPILOT_CHROME_NATIVE_HOST: '1',
  MOPILOT_CHROME_RELAY_USER_DATA_DIR: '/tmp/scratch',
};
const stops: (() => void)[] = [];
after(() => stops.forEach((s) => s()));

type Proc = { ppid?: number; exe?: string; uid?: number; mnt?: string; file?: { dev: number; ino: number } };
type Node = { uid: number; mode: number };

/** What the core reads of `procs`: who started each, and the file each runs. */
const coreOf = (procs: Record<number, Proc>) => {
  const parents = Object.fromEntries(Object.entries(procs).flatMap(([pid, p]) => (p.ppid === undefined ? [] : [[pid, p.ppid]])));
  return fakeCore({
    'caps.ancestry': ancestryOf(parents),
    'caps.executable': (pid: string) => procs[Number(pid)]?.exe ?? new Error('no such process'),
  }).addon;
};

/** A /proc and a file tree in memory: processes by pid, and owner and mode by path. */
function fakeFs({ procs, files = {} as Record<string, Node> }: { procs: Record<number, Proc>; files?: Record<string, Node> }) {
  const tree: Record<string, Node> = {
    '/': { uid: 0, mode: 0o40755 },
    '/opt': { uid: 0, mode: 0o40755 },
    '/opt/google': { uid: 0, mode: 0o40755 },
    '/opt/google/chrome': { uid: 0, mode: 0o40755 },
    [CHROME]: { uid: 0, mode: 0o100755 },
    ...files,
  };
  const proc = (p: string) => {
    const m = /^\/proc\/(\d+|self)(?:\/([\w/]+))?$/.exec(p);
    return m ? { pid: m[1], entry: m[1] === 'self' ? { mnt: 'mnt:[1]' } : procs[Number(m[1])], what: m[2] } : null;
  };
  const gone = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  return {
    readlinkSync: (p: string) => {
      const r = proc(p);
      if (r?.what === 'ns/mnt') {
        if (!r.entry) throw gone();
        return (r.entry as Proc).mnt ?? 'mnt:[1]';
      }
      throw gone();
    },
    statSync: (p: string) => {
      const r = proc(p);
      // a file: its device and inode (what /proc/<pid>/exe follows to, or the path here)
      if (r?.what === 'exe') {
        if (!r.entry?.exe) throw gone();
        return r.entry.file ?? { dev: 1, ino: 7 };
      }
      if (!r) return { dev: 1, ino: 7 };
      if (!r?.entry || r.entry.uid === undefined) throw gone();
      return { uid: r.entry.uid };
    },
    lstatSync: (p: string) => {
      if (!tree[p]) throw gone();
      return tree[p];
    },
    realpathSync: (p: string) => {
      if (p === '/bin/link') return SAGE;
      throw gone();
    },
  } as any;
}

const good: Record<number, Proc> = {
  40: { ppid: 30, exe: SAGE, uid: UID },
  30: { ppid: 5, exe: CHROME, uid: UID },
};
const chrome = (procs: Record<number, Proc> = good, files?: Record<string, Node>) =>
  hl.chromeParentLinux({ pid: 40, fs: fakeFs({ procs, files }), uid: UID, addon: coreOf(procs) });

test('the gate: only an unpackaged E2E run that asked for the host and named a scratch Chrome folder, on Linux', () => {
  const on = (o: any = {}) => hl.linuxHostEnabled({ env: ENV, packaged: false, platform: 'linux', ...o });
  assert.equal(on(), true);
  assert.equal(on({ packaged: true }), false);
  assert.equal(hl.linuxHostEnabled({ env: ENV, platform: 'linux' }), false, 'packaged unless the caller says otherwise');
  assert.equal(on({ platform: 'darwin' }), false);
  for (const k of Object.keys(ENV)) assert.equal(on({ env: { ...ENV, [k]: undefined } }), false, k);
  assert.equal(on({ env: { ...ENV, MOPILOT_CHROME_NATIVE_HOST: '0' } }), false);
  assert.equal(hl.linuxHostEnabled(), false, 'every default is closed');
});

test('the parent check: Google’s browser process, root-owned all the way up, the user’s own, still the host’s parent', async () => {
  assert.equal(await chrome(), null);
  // no parent, or init: no browser started it
  assert.equal(await chrome({ ...good, 40: { ...good[40], ppid: 1 } }), 'no browser started the host');
  assert.equal(await chrome({ 30: good[30] }), 'no browser started the host');
  // another program, a replaced binary, an unreadable exe (a process of another user), an empty link
  assert.equal(await chrome({ ...good, 30: { ...good[30], exe: '/tmp/chrome' } }), NOT);
  assert.equal(await chrome({ ...good, 30: { ...good[30], exe: `${CHROME} (deleted)` } }), NOT);
  assert.equal(await chrome({ ...good, 30: { ppid: 5, uid: UID } }), NOT);
  assert.equal(await chrome({ ...good, 30: { ...good[30], exe: '' } }), NOT);
  // another user's Chrome or host, or a process with no owner to read
  assert.equal(await chrome({ ...good, 30: { ...good[30], uid: 0 } }), NOT);
  assert.equal(await chrome({ ...good, 40: { ...good[40], uid: 0 } }), NOT);
  assert.equal(await chrome({ ...good, 40: { ppid: 30, exe: SAGE } }), NOT);
  // a binary or a directory above it that the user could replace
  for (const p of [CHROME, '/opt/google/chrome', '/opt/google', '/opt', '/']) {
    assert.equal(await chrome(good, { [p]: { uid: UID, mode: 0o100755 } }), NOT, `owned by the user: ${p}`);
    assert.equal(await chrome(good, { [p]: { uid: 0, mode: 0o100775 } }), NOT, `group-writable: ${p}`);
    assert.equal(await chrome(good, { [p]: { uid: 0, mode: 0o100757 } }), NOT, `world-writable: ${p}`);
  }
  // an unprivileged mount namespace (unshare -Urm) showing another file at Chrome's path: another namespace, or another file
  assert.equal(await chrome({ ...good, 30: { ...good[30], mnt: 'mnt:[2]' } }), NOT);
  assert.equal(await chrome({ ...good, 30: { ...good[30], file: { dev: 1, ino: 8 } } }), NOT);
  assert.equal(await chrome({ ...good, 30: { ...good[30], file: { dev: 2, ino: 7 } } }), NOT);
  // our own namespace or the parent's unreadable: nothing is shown to match
  const noNs = fakeFs({ procs: good });
  const readlink = noNs.readlinkSync;
  const addon = coreOf(good);
  assert.equal(
    await hl.chromeParentLinux({
      pid: 40,
      addon,
      fs: {
        ...noNs,
        readlinkSync: (p: string) =>
          p.endsWith('ns/mnt')
            ? ((): never => {
                throw new Error('x');
              })()
            : readlink(p),
      },
      uid: UID,
    }),
    NOT,
  );
  assert.equal(
    await hl.chromeParentLinux({
      pid: 40,
      addon,
      fs: {
        ...noNs,
        statSync: (p: string) =>
          p === CHROME
            ? ((): never => {
                throw new Error('x');
              })()
            : noNs.statSync(p),
      },
      uid: UID,
    }),
    NOT,
  );
  // a path nothing is at (removed while we looked)
  const procs = { ...good, 30: { ppid: 5, exe: '/gone/chrome', uid: UID } };
  assert.equal(
    await hl.chromeParentLinux({ pid: 40, fs: fakeFs({ procs }), uid: UID, executables: ['/gone/chrome'], addon: coreOf(procs) }),
    NOT,
  );
  assert.equal(await hl.chromeParentLinux({ pid: 40, fs: fakeFs({ procs: good }), uid: UID, executables: [CHROME], addon }), null);
  // the host reparented between the two readings, or the second reading failing: not shown to be Chrome's
  for (const second of [[40, 77], [40], new Error('no table')]) {
    let reads = 0;
    const flip = fakeCore({
      'caps.ancestry': (pid: string) => (pid === '40' && ++reads === 2 ? second : ancestryOf({ 40: 30, 30: 5 })(pid)),
      'caps.executable': (pid: string) => good[Number(pid)].exe,
    });
    assert.equal(
      await hl.chromeParentLinux({ pid: 40, fs: fakeFs({ procs: good }), uid: UID, addon: flip.addon }),
      NOT,
      JSON.stringify(second),
    );
    assert.equal(reads, 2, 'it reads the parent again');
  }
  // no core: no parent to read
  assert.equal(await hl.chromeParentLinux({ pid: 40, fs: fakeFs({ procs: good }), uid: UID, addon: null }), 'no browser started the host');
  // defaults: the real core and uid; a pid that does not exist has no browser
  assert.equal(await hl.chromeParentLinux({ pid: 1 << 22 }), 'no browser started the host');
});

test('the host’s file and parent by the core: its answer, or nothing, and a deleted file stays marked', async () => {
  const addon = coreOf({ ...good, 41: { ppid: 30, exe: `${SAGE} (deleted)` } });
  assert.equal(await hl.executableOf(40, addon), SAGE);
  assert.equal(await hl.executableOf(41, addon), `${SAGE} (deleted)`);
  assert.equal(await hl.executableOf(99, addon), null);
  assert.equal(await hl.executableOf(40, fakeCore({ 'caps.executable': 7 }).addon), null, 'what is no path');
  assert.equal(await hl.executableOf(40, null), null);
  assert.equal(await hl.executableOf(1 << 22), null, 'the real core: no such process');
  assert.equal(await hl.startedByProcess(40, addon), 30);
  assert.equal(await hl.startedByProcess(99, addon), null);
  assert.equal(await hl.startedByProcess(40, fakeCore({ 'caps.ancestry': [40, 'x'] }).addon), null);
  assert.equal(await hl.startedByProcess(40, null), null);
});

test('verifying a host on Linux: closed without the gate; with it the file, the socket and the parent decide, in that order', async () => {
  const base = {
    socket: {},
    pid: 40,
    origin: `chrome-extension://${STORE}/`,
    binary: SAGE,
    ids: [STORE],
    platform: 'linux',
    holds: async () => null,
    linuxE2E: true,
    linuxFs: fakeFs({ procs: good }),
    linuxUid: UID,
    addon: coreOf(good),
  };
  const v = (o: any = {}) => nh.verifyHostPeer({ ...base, ...o });
  assert.equal(await v(), null);
  assert.equal(await v({ linuxE2E: false }), 'the Chrome native host is not available on Linux');
  assert.equal(await v({ linuxE2E: undefined }), 'the Chrome native host is not available on Linux');
  // the checks that come first stay first
  assert.equal(await v({ pid: 1 }), 'no pid');
  assert.equal(await v({ origin: 'chrome-extension://x/' }), 'not an extension of MoPilot');
  // the host's file, by the core: a symlinked binary path counts as what it resolves to; another file or an unreadable one does not
  assert.equal(await v({ binary: '/bin/link' }), null);
  assert.equal(await v({ binary: '/other/sage-mcp' }), "process 40 is not MoPilot's host");
  assert.equal(await v({ pid: 41 }), "process 41 is not MoPilot's host");
  assert.equal(await v({ holds: async () => 'process 40 is not the one connected' }), 'process 40 is not the one connected');
  const evil = { ...good, 30: { ppid: 5, exe: '/home/u/chrome', uid: UID } };
  assert.equal(await v({ linuxFs: fakeFs({ procs: evil }), addon: coreOf(evil) }), NOT);
  // a replaced host reads as deleted, and matches no path
  const replaced = { ...good, 40: { ...good[40], exe: `${SAGE} (deleted)` } };
  assert.equal(await v({ addon: coreOf(replaced) }), "process 40 is not MoPilot's host");
  // the real file system and core by default: a pid that does not exist is no host of ours
  assert.equal(await v({ linuxFs: undefined, addon: undefined, pid: 1 << 22 }), `process ${1 << 22} is not MoPilot's host`);
});

test('the Linux host folder: only a gated run’s scratch folder, never the user’s own Chrome folder', () => {
  const all = () => true;
  const env = { MOPILOT_CHROME_RELAY_USER_DATA_DIR: '/s/c' };
  assert.deepEqual(nh.hostFolders({ platform: 'linux', env, exists: all, linuxE2E: true }), ['/s/c/NativeMessagingHosts']);
  assert.deepEqual(nh.hostFolders({ platform: 'linux', env, exists: () => false, linuxE2E: true }), []);
  assert.deepEqual(nh.hostFolders({ platform: 'linux', env, exists: all }), [], 'no gate');
  assert.deepEqual(nh.hostFolders({ platform: 'linux', env: {}, home: '/h', exists: all, linuxE2E: true }), [], 'no scratch folder');
  assert.deepEqual(nh.hostFolders({ platform: 'win32', env, exists: all, linuxE2E: true }), []);
});

test('on macOS the folder, the core and codesign decide, and the Linux gate is not consulted', async () => {
  assert.deepEqual(nh.hostFolders({ platform: 'darwin', env: {}, home: '/h', exists: () => true }), [
    '/h/Library/Application Support/Google/Chrome/NativeMessagingHosts',
  ]);
  const calls: string[] = [];
  const exec = (cmd: string, _args: string[], _o: any, cb: any) => {
    calls.push(cmd);
    return cb(null, '');
  };
  const r = await nh.verifyHostPeer({
    socket: {},
    pid: 40,
    origin: `chrome-extension://${STORE}/`,
    binary: SAGE,
    ids: [STORE],
    platform: 'darwin',
    execFile: exec,
    holds: async () => null,
    addon: coreOf({ 40: { ppid: 30, exe: SAGE } }),
  });
  assert.equal(r, null);
  assert.deepEqual(calls, ['/usr/bin/codesign']);
});

test('the app wiring: an unpackaged E2E run on Linux installs the host in its scratch folder and checks with /proc; a packaged build installs nothing and refuses', async (t) => {
  emptyChromeFolder(t);
  const scratch = process.env.MOPILOT_CHROME_RELAY_USER_DATA_DIR as string;
  const was = { ...process.env };
  Object.assign(process.env, { SAGE_E2E_BACKGROUND: '1', MOPILOT_CHROME_NATIVE_HOST: '1' });
  t.after(() => {
    for (const k of ['SAGE_E2E_BACKGROUND', 'MOPILOT_CHROME_NATIVE_HOST']) {
      if (was[k] === undefined) delete process.env[k];
      else process.env[k] = was[k];
    }
  });
  const base = {
    registry: { register: () => () => undefined },
    grants: {},
    token: () => null,
    profileDir: () => '',
    images: { fromBuffer: (b: Buffer) => b },
    isFlagEnabled: () => false,
    kind: 'extension',
    open: async () => undefined,
  };
  const hello = `${JSON.stringify({ type: 'hello', pid: 7, origin: `chrome-extension://${DEV_EXTENSION_ID}/`, request: { type: 'claim' } })}\n`;
  const resources = (process as any).resourcesPath;
  (process as any).resourcesPath = '/A.app/Contents/Resources';
  t.after(() => ((process as any).resourcesPath = resources));
  const start = async (packaged: boolean) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpnhl-'));
    const s = appRelay.setupChromeRelay({ ...base, files: { dir, safeStorage: { isEncryptionAvailable: () => false }, packaged } });
    stops.push(() => s.stop());
    const launcher = path.join(dir, 'chrome-native-host', 'mopilot-chrome-host');
    // a packaged build on Linux starts no host at all: nothing is written, however long we look
    if (packaged && process.platform === 'linux') {
      await new Promise((r) => setTimeout(r, 300));
      return { socket: '', launcher: fs.existsSync(launcher), manifest: fs.existsSync(path.join(scratch, 'NativeMessagingHosts')) };
    }
    await until(() => fs.existsSync(launcher));
    const socket = /--chrome-native-host '([^']*)'/.exec(fs.readFileSync(launcher, 'utf8'))?.[1] as string;
    return { socket, launcher: true, manifest: fs.existsSync(path.join(scratch, 'NativeMessagingHosts', 'ai.mopilot.code.chrome.json')) };
  };
  const closed = await start(true);
  const open = await start(false);
  const reasonOf = async (socket: string) => JSON.parse(await request(socket, hello)).reason;
  // wherever it runs, a process that is not our host is refused by the check the platform has
  assert.equal(await reasonOf(open.socket), "process 7 is not MoPilot's host");
  if (process.platform === 'linux') {
    assert.deepEqual([closed.launcher, closed.manifest], [false, false], 'a packaged build writes no launcher or manifest on Linux');
    assert.equal(open.manifest, true);
  }
});

test('the gate is closed whenever the app is packaged, however the rest of the environment reads, on any platform running the test', () => {
  const files = (o: any) =>
    appRelay.extensionFiles({ dir: '/d', safeStorage: { isEncryptionAvailable: () => false }, platform: 'linux', env: ENV, ...o });
  const had = (process as any).resourcesPath;
  (process as any).resourcesPath = '/A.app/Contents/Resources';
  try {
    assert.equal(files({ packaged: true }).nativeHost.linuxE2E, false);
    assert.equal(files({ packaged: false }).nativeHost.linuxE2E, true);
    assert.equal(files({ packaged: false, env: {} }).nativeHost.linuxE2E, false);
    assert.equal(files({ packaged: false, platform: 'darwin' }).nativeHost.linuxE2E, false);
    assert.equal(typeof files({ packaged: false, platform: undefined, env: undefined }).nativeHost.linuxE2E, 'boolean');
  } finally {
    (process as any).resourcesPath = had;
  }
});

test('no host ids on Linux outside the gate: a packaged build opens no socket and writes no launcher, even with the variables set or a store id', () => {
  const o = { storeId: STORE, platform: 'linux' };
  assert.equal(appRelay.nativeHostIds({ ...o, env: ENV }), null, 'packaged by default');
  assert.equal(appRelay.nativeHostIds({ ...o, env: ENV, packaged: true }), null);
  assert.equal(appRelay.nativeHostIds({ ...o, env: {}, packaged: true, dir: '/A.app/x/app.asar/electron/chrome-extension' }), null);
  assert.deepEqual(appRelay.nativeHostIds({ ...o, env: ENV, packaged: false }), [STORE, DEV_EXTENSION_ID]);
  // macOS keeps its rules
  assert.deepEqual(appRelay.nativeHostIds({ storeId: STORE, platform: 'darwin', env: ENV }), [STORE, DEV_EXTENSION_ID]);
});

test('a host given without ids and without files is treated as packaged: no ids, so no socket and no launcher', async (t) => {
  emptyChromeFolder(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpnhl-'));
  const s = appRelay.setupChromeRelay({
    registry: { register: () => () => undefined },
    grants: {},
    token: () => null,
    profileDir: () => '',
    images: { fromBuffer: (b: Buffer) => b },
    isFlagEnabled: () => false,
    kind: 'extension',
    pairing: memoryPairing(),
    nativeHost: { launcher: path.join(dir, 'launch'), binary: '/b/sage-mcp', folders: [] },
  });
  stops.push(() => s.stop());
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(fs.existsSync(path.join(dir, 'launch')), false);
});
