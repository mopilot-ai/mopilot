// Browser import sources: which browsers are installed, their profiles, Safari access, and the keychain key fetch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { listSources } = require('../electron/capabilities/browser/import/sources.cjs');
const { chromiumKey, zeroKey } = require('../electron/capabilities/browser/import/chromiumKey.cjs');
const { deriveKey } = require('../shared/chromiumCrypto.cjs');

const home = () => fs.mkdtempSync(path.join(os.tmpdir(), 'import-src-test-'));
const support = (h: string, ...rest: string[]) => path.join(h, 'Library', 'Application Support', ...rest);
const mk = (...parts: string[]) => fs.mkdirSync(path.join(...parts), { recursive: true });
const byId = (list: any[], id: string) => list.find((s) => s.id === id);
const errWith = (code: string) => Object.assign(new Error(code), { code });

test('listSources: all seven sources in a fixed order with names, services and roots', () => {
  const h = home();
  const list = listSources({ home: h, platform: 'darwin' });
  assert.deepEqual(
    list.map((s: any) => s.id),
    ['chrome', 'edge', 'brave', 'chromium', 'vivaldi', 'arc', 'safari'],
  );
  assert.deepEqual(
    list.map((s: any) => s.name),
    ['Google Chrome', 'Microsoft Edge', 'Brave', 'Chromium', 'Vivaldi', 'Arc', 'Safari'],
  );
  assert.deepEqual(
    list.map((s: any) => s.keychainService),
    [
      'Chrome Safe Storage',
      'Microsoft Edge Safe Storage',
      'Brave Safe Storage',
      'Chromium Safe Storage',
      'Vivaldi Safe Storage',
      'Arc Safe Storage',
      null,
    ],
  );
  assert.equal(byId(list, 'chrome').root, support(h, 'Google', 'Chrome'));
  assert.equal(byId(list, 'brave').root, support(h, 'BraveSoftware', 'Brave-Browser'));
  assert.equal(byId(list, 'arc').root, support(h, 'Arc', 'User Data'));
  assert.equal(byId(list, 'safari').root, path.join(h, 'Library', 'Safari'));
  assert.deepEqual(
    list.map((s: any) => s.kind),
    ['chromium', 'chromium', 'chromium', 'chromium', 'chromium', 'chromium', 'safari'],
  );
  assert.ok(list.every((s: any) => s.status === 'not_installed' || s.id === 'safari'));
  assert.deepEqual(byId(list, 'edge').profiles, []);
});

test('listSources: a data folder with no profile (only NativeMessagingHosts) is not installed', () => {
  const h = home();
  for (const dir of [['Microsoft Edge'], ['BraveSoftware', 'Brave-Browser'], ['Arc', 'User Data']])
    mk(support(h, ...dir), 'NativeMessagingHosts');
  mk(support(h, 'Google', 'Chrome'), 'Default');
  const list = listSources({ home: h, platform: 'darwin' });
  for (const id of ['edge', 'brave', 'arc']) {
    assert.equal(byId(list, id).status, 'not_installed', id);
    assert.deepEqual(byId(list, id).profiles, [], id);
  }
  assert.equal(byId(list, 'chrome').status, 'ready');
});

test('listSources: every source is unsupported off macOS', () => {
  const list = listSources({ home: home(), platform: 'linux' });
  assert.equal(list.length, 7);
  for (const s of list) {
    assert.equal(s.status, 'unsupported');
    assert.deepEqual(s.profiles, []);
  }
});

test('listSources: defaults read the real home without throwing', () => {
  assert.equal(listSources().length, 7);
});

test('listSources: profiles come from Local State, in natural order, only when the folder exists', () => {
  const h = home();
  const root = support(h, 'Google', 'Chrome');
  for (const d of ['Default', 'Profile 2', 'Profile 10', 'Profile 3']) mk(root, d);
  fs.writeFileSync(path.join(root, 'Not a dir'), '');
  fs.writeFileSync(
    path.join(root, 'Local State'),
    JSON.stringify({
      profile: {
        info_cache: {
          'Profile 10': { name: 'Ten' },
          'Profile 2': { gaia_name: 'Gaia Two' },
          'Profile 3': {},
          'Profile 7': { name: 'Gone' },
          'Not a dir': { name: 'File' },
          '../escape': { name: 'Escape' },
          Default: { name: 'Me' },
        },
      },
    }),
  );
  const chrome = byId(listSources({ home: h, platform: 'darwin' }), 'chrome');
  assert.equal(chrome.status, 'ready');
  assert.deepEqual(
    chrome.profiles.map((p: any) => [p.id, p.name, p.path]),
    [
      ['Default', 'Me', path.join(root, 'Default')],
      ['Profile 2', 'Gaia Two', path.join(root, 'Profile 2')],
      ['Profile 3', 'Profile 3', path.join(root, 'Profile 3')],
      ['Profile 10', 'Ten', path.join(root, 'Profile 10')],
    ],
  );
});

test('listSources: Local State cannot name the browser root or its parent as a profile', () => {
  const h = home();
  const root = support(h, 'Google', 'Chrome');
  for (const id of ['Default', 'Custom Profile', '..profile']) mk(root, id);
  fs.writeFileSync(
    path.join(root, 'Local State'),
    JSON.stringify({
      profile: {
        info_cache: {
          '': { name: 'Empty' },
          '.': { name: 'Root' },
          '..': { name: 'Parent' },
          Default: { name: 'Me' },
          'Custom Profile': { name: 'Custom' },
          '..profile': { name: 'Dots in a real name' },
        },
      },
    }),
  );
  try {
    const chrome = byId(listSources({ home: h, platform: 'darwin' }), 'chrome');
    assert.equal(chrome.status, 'ready');
    assert.deepEqual(
      chrome.profiles.map((p: any) => p.id),
      ['Default', 'Custom Profile', '..profile'],
    );
    assert.ok(chrome.profiles.every((p: any) => path.dirname(p.path) === root));
  } finally {
    fs.rmSync(h, { recursive: true, force: true });
  }
});

test('listSources: without usable Local State the Default and Profile n folders are listed', () => {
  for (const state of [
    null,
    '{broken',
    '{}',
    '{"profile":{"info_cache":"x"}}',
    '{"profile":{"info_cache":{}}}',
    '{"profile":{"info_cache":null}}',
  ]) {
    const h = home();
    const root = support(h, 'Microsoft Edge');
    for (const d of ['Profile 1', 'Default', 'Guest Profile', 'Profile x']) mk(root, d);
    if (state !== null) fs.writeFileSync(path.join(root, 'Local State'), state);
    const edge = byId(listSources({ home: h, platform: 'darwin' }), 'edge');
    assert.deepEqual(
      edge.profiles.map((p: any) => [p.id, p.name]),
      [
        ['Default', 'Default'],
        ['Profile 1', 'Profile 1'],
      ],
      String(state),
    );
  }
});

test('listSources: a Chromium folder macOS blocks needs Full Disk Access, with the profiles found by name', () => {
  // macOS 27: another app's data folder stats, but listing it or reading Local State is refused without Full Disk Access
  const h = home();
  const root = support(h, 'Google', 'Chrome');
  for (const d of ['Default', 'Profile 2', 'Profile 50', 'Profile 51', 'Guest Profile']) mk(root, d);
  fs.writeFileSync(path.join(root, 'Local State'), JSON.stringify({ profile: { info_cache: { Default: { name: 'Me' } } } }));
  mk(support(h, 'Microsoft Edge'), 'NativeMessagingHosts');
  const real = fs;
  const inside = (p: unknown) => String(p).includes(`${path.sep}Application Support${path.sep}`);
  for (const code of ['EPERM', 'EACCES']) {
    const blocked = {
      ...real,
      readFileSync: (p: string, ...rest: any[]) => {
        if (inside(p)) throw errWith(code);
        return (real as any).readFileSync(p, ...rest);
      },
      readdirSync: (p: string, ...rest: any[]) => {
        if (inside(p)) throw errWith(code);
        return (real as any).readdirSync(p, ...rest);
      },
    } as any;
    const list = listSources({ home: h, platform: 'darwin', fs: blocked });
    const chrome = byId(list, 'chrome');
    assert.equal(chrome.status, 'needs_full_disk_access', code);
    assert.deepEqual(
      chrome.profiles.map((p: any) => [p.id, p.name, p.path]),
      [
        ['Default', 'Default', path.join(root, 'Default')],
        ['Profile 2', 'Profile 2', path.join(root, 'Profile 2')],
        ['Profile 50', 'Profile 50', path.join(root, 'Profile 50')],
      ],
      code,
    );
    // a blocked folder with no profile (another app's NativeMessagingHosts) is still not a browser
    assert.equal(byId(list, 'edge').status, 'not_installed', code);
    assert.deepEqual(byId(list, 'edge').profiles, [], code);
  }
  // blocked only when listing (Local State missing)
  fs.rmSync(path.join(root, 'Local State'));
  const noList = {
    ...real,
    readdirSync: () => {
      throw errWith('EPERM');
    },
  } as any;
  assert.equal(byId(listSources({ home: h, platform: 'darwin', fs: noList }), 'chrome').status, 'needs_full_disk_access');
});

test('listSources: other read failures give no profiles instead of throwing', () => {
  const h = home();
  const root = support(h, 'Vivaldi');
  mk(root, 'Default');
  const real = fs;
  // readdir fails for the fallback listing for another reason
  const noList = {
    ...real,
    readdirSync: () => {
      throw errWith('EIO');
    },
  } as any;
  assert.deepEqual(byId(listSources({ home: h, platform: 'darwin', fs: noList }), 'vivaldi').profiles, []);
  assert.equal(byId(listSources({ home: h, platform: 'darwin', fs: noList }), 'vivaldi').status, 'not_installed');
  // a profile folder that cannot be examined is left out
  const noStat = {
    ...real,
    statSync: (p: string) => {
      if (p.endsWith('Default')) throw errWith('EPERM');
      return real.statSync(p);
    },
  } as any;
  assert.deepEqual(byId(listSources({ home: h, platform: 'darwin', fs: noStat }), 'vivaldi').profiles, []);
});

test('listSources: Safari is ready, missing, or needs Full Disk Access', () => {
  const real = fs;
  // no folder at all
  assert.equal(byId(listSources({ home: home(), platform: 'darwin' }), 'safari').status, 'not_installed');
  // folder without History.db
  const h = home();
  mk(h, 'Library', 'Safari');
  assert.equal(byId(listSources({ home: h, platform: 'darwin' }), 'safari').status, 'not_installed');
  // with History.db
  fs.writeFileSync(path.join(h, 'Library', 'Safari', 'History.db'), '');
  const ready = byId(listSources({ home: h, platform: 'darwin' }), 'safari');
  assert.equal(ready.status, 'ready');
  assert.deepEqual(ready.profiles, [{ id: 'Safari', name: 'Safari', path: path.join(h, 'Library', 'Safari') }]);
  // blocked by the system, at each step
  for (const [step, code] of [
    ['statSync', 'EPERM'],
    ['readdirSync', 'EACCES'],
    ['accessSync', 'EPERM'],
    ['accessSync', 'EACCES'],
  ]) {
    const blocked = {
      ...real,
      [step]: (p: string, ...rest: any[]) => {
        if (String(p).includes('Safari')) throw errWith(code);
        return (real as any)[step](p, ...rest);
      },
    } as any;
    assert.equal(
      byId(listSources({ home: h, platform: 'darwin', fs: blocked }), 'safari').status,
      'needs_full_disk_access',
      `${step} ${code}`,
    );
  }
  // an unexpected failure and an error without a code both mean it cannot be used
  for (const err of [errWith('EIO'), 'odd', null]) {
    const odd = {
      ...real,
      accessSync: () => {
        throw err;
      },
    } as any;
    assert.equal(byId(listSources({ home: h, platform: 'darwin', fs: odd }), 'safari').status, 'not_installed');
  }
});

test('chromiumKey: runs security asynchronously and derives the key from the trimmed password', async () => {
  const calls: any[] = [];
  const execFile = (cmd: string, args: string[], opts: any, cb: Function) => {
    calls.push({ cmd, args, opts });
    setImmediate(() => cb(null, 'p@ss word\n', ''));
  };
  const key = await chromiumKey('Chrome Safe Storage', { execFile, platform: 'darwin', timeoutMs: 5000 });
  assert.deepEqual(key, deriveKey('p@ss word'));
  assert.equal(key.length, 16);
  assert.deepEqual(calls[0].args, ['find-generic-password', '-w', '-s', 'Chrome Safe Storage']);
  assert.equal(calls[0].cmd, 'security');
  assert.equal(calls[0].opts.timeout, 5000);
  // a password with no trailing newline is used as is
  const plain = await chromiumKey('x', {
    execFile: (_c: string, _a: string[], _o: any, cb: Function) => cb(null, 'abc'),
    platform: 'darwin',
  });
  assert.deepEqual(plain, deriveKey('abc'));
  // the default timeout is two minutes
  await chromiumKey('x', {
    execFile: (_c: string, _a: string[], o: any, cb: Function) => {
      calls.push(o);
      cb(null, 'abc');
    },
    platform: 'darwin',
  });
  assert.equal(calls[calls.length - 1].timeout, 120000);
});

test('chromiumKey: denial, timeout, empty output and other platforms are keychain_denied without leaking the password', async () => {
  const secret = 'hunter2-secret';
  const denied = (execFile: Function, platform = 'darwin') => chromiumKey('x', { execFile, platform });
  const check = async (p: Promise<unknown>) => {
    await assert.rejects(p, (e: any) => {
      assert.equal(e.code, 'keychain_denied');
      assert.equal(e.name, 'ImportError');
      assert.ok(!e.message.includes(secret));
      assert.ok(!String(e.stack).includes(secret));
      return true;
    });
  };
  // the keychain refused (the error text quotes the command and even a secret)
  await check(
    denied((_c: string, _a: string[], _o: any, cb: Function) => cb(Object.assign(new Error(`Command failed: ${secret}`), { code: 44 }))),
  );
  // the prompt timed out
  await check(
    denied((_c: string, _a: string[], _o: any, cb: Function) =>
      cb(Object.assign(new Error('timeout'), { killed: true, signal: 'SIGTERM' })),
    ),
  );
  // nothing came back
  await check(denied((_c: string, _a: string[], _o: any, cb: Function) => cb(null, '\n')));
  // not macOS: the command is never run
  let ran = false;
  await check(
    denied(() => {
      ran = true;
    }, 'linux'),
  );
  assert.equal(ran, false);
  // default platform: macOS runs the injected command, others are refused
  const fake = (_c: string, _a: string[], _o: any, cb: Function) => cb(null, 'abc');
  if (process.platform === 'darwin') assert.deepEqual(await chromiumKey('x', { execFile: fake }), deriveKey('abc'));
  else await check(chromiumKey('x', { execFile: fake }));
  // the default command runner is the real one: off macOS it is not reached
  await check(chromiumKey('x', { platform: 'linux' }));
});

test('zeroKey: overwrites the key and tolerates nothing', () => {
  const key = deriveKey('abc');
  zeroKey(key);
  assert.ok(key.every((b: number) => b === 0));
  zeroKey(null);
  zeroKey(undefined);
});
