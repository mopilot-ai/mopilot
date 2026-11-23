// MoPilot's Chrome extension offered through Chrome's External Extensions preference (#1632): the file's place, the states that write it, leave it, or take it back, and the startup wiring.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ext = require('../electron/capabilities/browser/chromeExternalInstall.cjs');
const { offerChromeExtension } = require('../electron/app/chromeRelay.cjs');

const ID = 'abcdefghijklmnopabcdefghijklmnop';
const UPDATE = { external_update_url: 'https://clients2.google.com/service/update2/crx' };

/** A scratch Chrome folder (the pairing runs' MOPILOT_CHROME_RELAY_USER_DATA_DIR) and a record file, never the user's. */
function scratch(chrome = true) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mpext-'));
  const root = path.join(base, 'Chrome');
  if (chrome) fs.mkdirSync(root);
  const file = path.join(root, 'External Extensions', `${ID}.json`);
  const stateFile = path.join(base, 'offer.json');
  const env = { MOPILOT_CHROME_RELAY_USER_DATA_DIR: root };
  const sync = (o: Record<string, unknown> = {}) =>
    ext.syncExternalInstall({ id: ID, enabled: true, state: 'missing', stateFile, env, platform: 'darwin', ...o });
  return { root, file, stateFile, env, sync };
}

test('the file goes in Chrome’s own per-user External Extensions folder, or the scratch one a run names; macOS only', () => {
  assert.equal(ext.externalFile({ id: ID, platform: 'win32' }), null);
  assert.equal(ext.externalFile({ id: ID, platform: 'linux' }), null);
  assert.deepEqual(ext.externalFile({ id: ID, platform: 'darwin', home: '/h', env: {} }), {
    root: '/h/Library/Application Support/Google/Chrome',
    file: `/h/Library/Application Support/Google/Chrome/External Extensions/${ID}.json`,
  });
  assert.equal(
    ext.externalFile({ id: ID, platform: 'darwin', env: { MOPILOT_CHROME_RELAY_USER_DATA_DIR: '/s/c' } })?.file,
    `/s/c/External Extensions/${ID}.json`,
  );
});

test('a Chrome without the extension gets the update-URL preference once; asking again changes nothing', () => {
  const s = scratch();
  assert.equal(s.sync(), 'written');
  assert.deepEqual(JSON.parse(fs.readFileSync(s.file, 'utf8')), UPDATE);
  assert.equal(JSON.parse(fs.readFileSync(s.stateFile, 'utf8')).offered, ID);
  const before = fs.statSync(s.file).mtimeMs;
  assert.equal(s.sync(), 'present');
  assert.equal(s.sync({ state: null }), 'present');
  assert.equal(fs.statSync(s.file).mtimeMs, before);
});

test('an offer made before is not made again over a file the user took away; a file holding anything else is never replaced', () => {
  const s = scratch();
  s.sync();
  fs.rmSync(s.file);
  assert.equal(s.sync(), 'offered-before');
  assert.equal(fs.existsSync(s.file), false);
  const t = scratch();
  fs.mkdirSync(path.dirname(t.file), { recursive: true });
  fs.writeFileSync(t.file, '{"external_version":"1"}');
  assert.equal(t.sync(), 'present');
  assert.equal(fs.readFileSync(t.file, 'utf8'), '{"external_version":"1"}');
});

test('nothing is written without a Chrome folder, or when the extension is already in the profile, on or turned off', () => {
  const none = scratch(false);
  assert.equal(none.sync(), 'no-chrome');
  const s = scratch();
  assert.equal(s.sync({ state: 'on' }), 'installed');
  assert.equal(s.sync({ state: 'off' }), 'installed');
  assert.equal(fs.existsSync(s.file), false);
  assert.equal(s.sync({ platform: 'win32' }), 'unsupported');
});

test('turned off, the file is taken back when ours and the extension isn’t installed, so a later switch on offers again', () => {
  const s = scratch();
  s.sync();
  assert.equal(s.sync({ enabled: false }), 'removed');
  assert.equal(fs.existsSync(s.file), false);
  assert.equal(fs.existsSync(s.stateFile), false);
  assert.equal(s.sync({ enabled: false }), 'off');
  assert.equal(s.sync(), 'written');
});

test('turned off, an installed extension keeps its file (Chrome would remove the extension with it), and a foreign file stays', () => {
  const s = scratch();
  s.sync();
  assert.equal(s.sync({ enabled: false, state: 'on' }), 'off');
  assert.equal(s.sync({ enabled: false, state: 'off' }), 'off');
  assert.equal(fs.existsSync(s.file), true);
  fs.writeFileSync(s.file, '{"external_version":"1"}');
  assert.equal(s.sync({ enabled: false }), 'off');
  assert.equal(fs.readFileSync(s.file, 'utf8'), '{"external_version":"1"}');
});

test('a folder that can’t be written is noted and reported, never thrown', () => {
  const s = scratch();
  fs.writeFileSync(path.join(s.root, 'External Extensions'), 'a file, not a folder');
  assert.equal(s.sync(), 'failed');
});

test('a record made for another Chrome folder doesn’t stop the offer here; a dangling link is not replaced', () => {
  const a = scratch();
  a.sync();
  const b = scratch();
  fs.copyFileSync(a.stateFile, b.stateFile);
  assert.equal(b.sync(), 'written');
  const c = scratch();
  fs.mkdirSync(path.dirname(c.file), { recursive: true });
  fs.symlinkSync('/nonexistent/target', c.file);
  assert.equal(c.sync(), 'present');
  assert.equal(fs.readlinkSync(c.file), '/nonexistent/target');
});

test('taking the file back needs the extension missing: an unreadable profile or a state other than missing keeps it', () => {
  const s = scratch();
  s.sync();
  assert.equal(s.sync({ enabled: false, state: null }), 'off');
  assert.equal(fs.existsSync(s.file), true);
});

test('the profile folders are Default and Profile N; an unreadable folder has none', () => {
  const s = scratch();
  for (const n of ['Default', 'Profile 1', 'Profile 12', 'Guest Profile', 'Profile x', 'Crashpad']) fs.mkdirSync(path.join(s.root, n));
  assert.deepEqual(ext.profileFolders(s.root).sort(), ['Default', 'Profile 1', 'Profile 12']);
  assert.deepEqual(ext.profileFolders(path.join(s.root, 'nope')), []);
});

test('startup: dev builds offer nothing; a build with the store id reads every profile of the folder and the extension in any one decides', () => {
  assert.equal(offerChromeExtension({ dir: '/d', enabled: true, ids: null }), 'not-shipped');
  const s = scratch();
  for (const n of ['Default', 'Profile 1']) fs.mkdirSync(path.join(s.root, n));
  const run = (states: Record<string, 'on' | 'off' | 'missing' | null>) => {
    const asked: unknown[] = [];
    const sent: any[] = [];
    offerChromeExtension({
      dir: '/d',
      enabled: false,
      profileDir: 'Profile 2',
      ids: [ID],
      env: s.env,
      platform: 'darwin',
      inProfile: (id: string, o: { profileDir: string | null }) => {
        asked.push([id, o.profileDir]);
        return String(o.profileDir) in states ? states[String(o.profileDir)] : 'missing';
      },
      sync: (o: unknown) => {
        sent.push(o);
        return 'off';
      },
    });
    return { asked, sent: sent[0] };
  };
  const all = run({});
  // the store's id and the dev key's, in each profile
  assert.deepEqual([...new Set(all.asked.map((a: any) => a[1]))], ['Profile 2', null, 'Default', 'Profile 1']);
  assert.equal(new Set(all.asked.map((a: any) => a[0])).size, 2);
  assert.deepEqual(all.sent, {
    id: ID,
    enabled: false,
    state: 'missing',
    stateFile: '/d/chrome-extension-offer.json',
    env: s.env,
    platform: 'darwin',
  });
  assert.equal(run({ 'Profile 1': 'off' }).sent.state, 'off');
  assert.equal(run({ 'Profile 1': 'off', Default: 'on' }).sent.state, 'on');
  assert.equal(run({ Default: null }).sent.state, null);
  // off macOS there is no folder to list and nothing to write
  const off = offerChromeExtension({ dir: '/d', enabled: true, ids: [ID], env: s.env, platform: 'win32', inProfile: () => 'missing' });
  assert.equal(off, 'unsupported');
});
