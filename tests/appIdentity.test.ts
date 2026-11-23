// appIdentity.cjs: an app an agent named (bundle id or name) becomes its display name, bundle id and icon, cached per query.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { AppIdentity, isBundleId, run } = require('../electron/capabilities/appIdentity.cjs');

const PLISTS: Record<string, object | string> = {
  '/Applications/Claude.app/Contents/Info.plist': { CFBundleDisplayName: 'Claude', CFBundleIdentifier: 'com.anthropic.claudefordesktop' },
  '/System/Applications/TextEdit.app/Contents/Info.plist': { CFBundleName: 'TextEdit', CFBundleIdentifier: 'com.apple.TextEdit' },
  '/Users/me/Applications/Odd.app/Contents/Info.plist': 'not json',
};

function rig(o: { mdfind?: string; lsappinfo?: string; electron?: any } = {}) {
  const ran: string[][] = [];
  const id = new AppIdentity({
    home: '/Users/me',
    exists: (f: string) => ['/System/Applications/TextEdit.app', '/Users/me/Applications/Odd.app'].includes(f),
    run: async (file: string, args: string[]) => {
      ran.push([file, ...args]);
      if (file.endsWith('mdfind')) return o.mdfind ?? '';
      if (file.endsWith('lsappinfo')) return o.lsappinfo ?? '';
      const p = PLISTS[args.at(-1)!];
      return p === undefined ? '' : typeof p === 'string' ? p : JSON.stringify(p);
    },
    images: o.electron ?? null,
  });
  return { id, ran };
}

const icons = {
  createThumbnailFromPath: async (f: string) => {
    if (f.includes('TextEdit')) throw new Error('no icon');
    return { isEmpty: () => f.includes('Odd'), toDataURL: () => `data:image/png;base64,${f.length}` };
  },
};

test('a bundle id: Spotlight finds the app (the Applications folders first), its Info.plist names it', async () => {
  const r = rig({ mdfind: '/Volumes/Old/Claude.app\n/Applications/Claude.app\n/tmp/x.txt\n', electron: icons });
  assert.deepEqual(await r.id.resolve('com.anthropic.claudefordesktop'), {
    name: 'Claude',
    bundleId: 'com.anthropic.claudefordesktop',
    icon: 'data:image/png;base64,24',
  });
  // cached per query, case-insensitively: Spotlight is asked once
  await r.id.resolve(' COM.anthropic.claudefordesktop ');
  assert.equal(r.ran.filter((x) => x[0].endsWith('mdfind')).length, 1);
  assert.match(r.ran[0][1], /kMDItemCFBundleIdentifier == "com.anthropic.claudefordesktop"/);
});

test('a bundle id Spotlight only finds elsewhere, and one it does not find', async () => {
  assert.equal((await rig({ mdfind: '/Volumes/Old/Claude.app\n' }).id.resolve('com.x.y'))?.name, 'Claude');
  assert.equal(await rig().id.resolve('com.nothing.here'), null);
  // Spotlight off: a running app's path from LaunchServices
  const running = rig({ lsappinfo: '"Claude" ASN:0x0-0x1:\n    bundle path="/Applications/Claude.app"\n' });
  assert.equal((await running.id.resolve('com.anthropic.claudefordesktop'))?.name, 'Claude');
  assert.deepEqual(running.ran[1].slice(0, 2), ['/usr/bin/lsappinfo', 'info']);
});

test('a name: the installed app by folder; no icon without Electron or when it fails; a plist that is not JSON names it by folder', async () => {
  const r = rig({ electron: icons });
  assert.deepEqual(await r.id.resolve('TextEdit'), { name: 'TextEdit', bundleId: 'com.apple.TextEdit', icon: null });
  assert.deepEqual(await r.id.resolve('Odd.app'), { name: 'Odd', bundleId: null, icon: null });
  assert.deepEqual(await rig().id.resolve('TextEdit'), { name: 'TextEdit', bundleId: 'com.apple.TextEdit', icon: null });
  assert.equal(await r.id.resolve('Missing'), null);
  assert.equal(await r.id.resolve(''), null);
  assert.equal(await r.id.resolve(42), null);
});

test('isBundleId: dotted ids, not names or app files', () => {
  assert.equal(isBundleId('com.apple.TextEdit'), true);
  assert.equal(isBundleId('Notes'), false);
  assert.equal(isBundleId('Notes.app'), false);
});

test('defaults: real commands answer nothing for an app that does not exist', async () => {
  const id = new AppIdentity();
  assert.equal(await id.resolve('Definitely Not An App 7f3c'), null);
  assert.equal(await id.info('/nonexistent/X.app').then((i: any) => i.name), 'X');
});

test('run: what a command printed, or nothing when it fails', async () => {
  assert.equal(await run('/bin/echo', ['hi']), 'hi\n');
  assert.equal(await run('/nonexistent/cmd-7f3c', []), '');
});

test('shown: what the control pill names — nothing before an app, the resolved name and icon, else the name or "App"', async () => {
  const r = rig({ electron: icons });
  assert.deepEqual(await r.id.shown(null), { name: null, icon: null });
  assert.deepEqual(await r.id.shown('  '), { name: null, icon: null });
  assert.deepEqual(await r.id.shown('Odd.app'), { name: 'Odd', icon: null });
  assert.deepEqual(await r.id.shown('Missing'), { name: 'Missing', icon: null });
  assert.deepEqual(await r.id.shown('com.nothing.here'), { name: 'App', icon: null });
});
