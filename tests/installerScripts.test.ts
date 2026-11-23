// scripts/check-entitlements.mjs, scripts/dmg.mjs and scripts/make-dmg-background.mjs with codesign, dmgbuild and
// the browser replaced: nothing is signed, no disk image is made and no browser starts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { recorder, runScript, tempDir } from './support/scripts-shared-cli.ts';

const ent = await import('../scripts/check-entitlements.mjs');
const dmg = await import('../scripts/dmg.mjs');
const bg = await import('../scripts/make-dmg-background.mjs');

const KAG = '<plist><dict><key>com.apple.security.cs.allow-jit</key><true/><key>keychain-access-groups</key><array/></dict></plist>';
const PLAIN = '<plist><dict><key>com.apple.security.cs.allow-jit</key><true/></dict></plist>';

test('restricted entitlements: keychain groups, application identifiers and com.apple.developer.* only', () => {
  const xml = [
    'keychain-access-groups',
    'com.apple.application-identifier',
    'com.apple.developer.team-identifier',
    'com.apple.security.cs.allow-jit',
    'com.apple.security.device.audio-input',
  ]
    .map((k) => `<key>${k}</key><true/>`)
    .join('');
  assert.deepEqual(ent.restrictedKeys(xml), [
    'keychain-access-groups',
    'com.apple.application-identifier',
    'com.apple.developer.team-identifier',
  ]);
  assert.deepEqual(ent.restrictedKeys(''), []);
});

test('machOFiles: every Mach-O once, through framework links, and nothing else', () => {
  const app = path.join(tempDir('entitlements-'), 'A.app');
  const write = (rel: string, bytes: number[] | string) => {
    fs.mkdirSync(path.dirname(path.join(app, rel)), { recursive: true });
    fs.writeFileSync(path.join(app, rel), typeof bytes === 'string' ? bytes : Buffer.from(bytes));
  };
  write('Contents/MacOS/A', [0xcf, 0xfa, 0xed, 0xfe, 0]);
  write('Contents/Frameworks/X.framework/Versions/A/X', [0xca, 0xfe, 0xba, 0xbe, 0]);
  fs.symlinkSync('A', path.join(app, 'Contents/Frameworks/X.framework/Versions/Current'));
  fs.symlinkSync('Versions/Current/X', path.join(app, 'Contents/Frameworks/X.framework/X'));
  write('Contents/Info.plist', '<plist/>');
  write('Contents/PkgInfo', 'AP');
  assert.deepEqual(ent.machOFiles(app), [
    path.join(app, 'Contents/Frameworks/X.framework/Versions/A/X'),
    path.join(app, 'Contents/MacOS/A'),
  ]);
});

test('checkEntitlements: only the main executable may claim a restricted entitlement, and only with an embedded profile', () => {
  const app = '/out/MoPilot.app';
  const main = `${app}/Contents/MacOS/MoPilot`;
  const helper = `${app}/Contents/Frameworks/MoPilot Helper.app/Contents/MacOS/MoPilot Helper`;
  const rg = `${app}/Contents/Resources/ripgrep/rg`;
  const exec = recorder((_cmd: string, args: string[]) => (args.at(-1) === rg ? PLAIN : KAG));
  const log = recorder();
  const profiled = recorder(() => true);

  // the profile covers the main executable, never a helper
  assert.throws(
    () => ent.checkEntitlements(app, { exec: exec as any, list: () => [main, helper, rg], exists: profiled, log }),
    (e: Error) =>
      e.message ===
      'macOS would refuse to run MoPilot.app: restricted entitlements no embedded provisioning profile grants:\n' +
        '  Contents/Frameworks/MoPilot Helper.app/Contents/MacOS/MoPilot Helper: keychain-access-groups',
  );
  assert.deepEqual(exec.calls[0], [
    'codesign',
    ['-d', '--entitlements', '-', '--xml', main],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ]);
  assert.deepEqual(profiled.calls, [[`${app}/Contents/embedded.provisionprofile`]]);

  // without a profile the main executable can't claim one either (0.3.1 to 0.3.7)
  assert.throws(
    () => ent.checkEntitlements(app, { exec: exec as any, list: () => [main], exists: () => false, log }),
    /\n {2}Contents\/MacOS\/MoPilot: keychain-access-groups$/,
  );

  ent.checkEntitlements(app, { exec: exec as any, list: () => [main, rg], exists: () => true, log });
  ent.checkEntitlements(app, { exec: (() => PLAIN) as any, list: () => [main], exists: () => false, log });
  assert.deepEqual(log.calls, [
    ['Entitlements OK:', app],
    ['Entitlements OK:', app],
  ]);

  // a binary codesign can't read is named, with codesign's reason
  const unreadable = () => {
    throw Object.assign(new Error('Command failed'), { stderr: 'code object is not signed at all\n' });
  };
  assert.throws(
    () => ent.checkEntitlements(app, { exec: unreadable as any, list: () => [rg], exists: () => false, log }),
    (e: Error) => e.message === 'Could not read the entitlements of Contents/Resources/ripgrep/rg: code object is not signed at all',
  );
  const noStderr = () => {
    throw new Error('spawn codesign ENOENT');
  };
  assert.throws(
    () => ent.checkEntitlements(app, { exec: noStderr as any, list: () => [rg], exists: () => false, log }),
    /rg: spawn codesign ENOENT$/,
  );
});

test('check-entitlements CLI: the default package or the given app; a failure is printed', () => {
  const check = recorder();
  assert.equal(ent.main([], { check, arch: 'arm64' }), 0);
  assert.deepEqual(check.calls[0], [path.join('out', 'MoPilot-darwin-arm64', 'MoPilot.app')]);
  const error = recorder();
  const fail = () => {
    throw new Error('killed at launch');
  };
  assert.equal(ent.main(['/x.app'], { check: fail, error }), 1);
  assert.deepEqual(error.calls, [['killed at launch']]);
  const r = runScript('scripts/check-entitlements.mjs', [path.join(tempDir(), 'missing.app')]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /ENOENT/);
});

test('DMG settings: the app on the left, an Applications link on the right, the background and the app icon', () => {
  const s = dmg.dmgSettings({ app: '/out/MoPilot.app', title: 'MoPilot' });
  assert.deepEqual(s, {
    title: 'MoPilot',
    icon: dmg.VOLUME_ICON,
    background: dmg.BACKGROUND,
    'icon-size': 128,
    'text-size': 13,
    window: { position: { x: 200, y: 160 }, size: { width: 600, height: 432 } },
    format: 'ULFO',
    filesystem: 'HFS+',
    contents: [
      { x: 160, y: 212, type: 'file', path: '/out/MoPilot.app' },
      { x: 440, y: 212, type: 'link', path: '/Applications' },
    ],
  });
  // the art the settings name is committed, at 1x and 2x, the background's size
  for (const f of [dmg.BACKGROUND, dmg.BACKGROUND.replace('.png', '@2x.png'), dmg.VOLUME_ICON]) assert.ok(fs.existsSync(f), f);
  const png = fs.readFileSync(dmg.BACKGROUND);
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [600, 400]);
  assert.equal(s.window.size.height - png.readUInt32BE(20), 32, 'the window is the background plus its title bar');
});

test('dmgbuildPath: the pinned bundle for this Mac, through the checked download', async (t) => {
  const download = recorder(async () => '/cache/dmgbuild-bundle');
  assert.equal(await dmg.dmgbuildPath({ arch: 'arm64', download }), path.join('/cache/dmgbuild-bundle', 'dmgbuild'));
  assert.equal(await dmg.dmgbuildPath({ arch: 'x64', download }), path.join('/cache/dmgbuild-bundle', 'dmgbuild'));
  assert.deepEqual(
    download.calls.map((c) => c[0].filenameWithExt),
    ['dmgbuild-bundle-arm64-75c8a6c.tar.gz', 'dmgbuild-bundle-x86_64-75c8a6c.tar.gz'],
  );
  assert.equal(download.calls[0][0].releaseName, 'dmg-builder@1.2.5');
  assert.equal(download.calls[0][0].checksums, dmg.DMGBUILD.checksums);
  // the default loads electron-builder's downloader only when called
  const real = recorder(async () => '/eb-cache');
  t.mock.module('app-builder-lib/out/util/electronGet.js', { namedExports: { downloadBuilderToolset: real } });
  assert.equal(await dmg.dmgbuildPath({ arch: 'arm64' }), path.join('/eb-cache', 'dmgbuild'));
  assert.equal(real.calls[0][0].filenameWithExt, 'dmgbuild-bundle-arm64-75c8a6c.tar.gz');
});

test('buildDmg: dmgbuild gets the settings file, which is removed afterwards even when dmgbuild fails', () => {
  let settings = '';
  let written: any;
  const exec = recorder((_tool: string, args: string[]) => {
    settings = args[1];
    written = JSON.parse(fs.readFileSync(settings, 'utf8'));
  });
  const log = recorder();
  dmg.buildDmg({ app: '/out/A.app', dmg: '/out/A.dmg', title: 'MoPilot', tool: '/bin/dmgbuild' }, { exec: exec as any, log });
  assert.deepEqual(exec.calls[0].slice(0, 2), ['/bin/dmgbuild', ['-s', settings, 'MoPilot', '/out/A.dmg']]);
  assert.equal(exec.calls[0][2].stdio, 'inherit');
  assert.equal(exec.calls[0][2].env.PYTHONIOENCODING, 'utf8');
  assert.deepEqual(written, dmg.dmgSettings({ app: '/out/A.app', title: 'MoPilot' }));
  assert.deepEqual(log.calls[0], ['$', '/bin/dmgbuild', '-s', settings, 'MoPilot', '/out/A.dmg']);
  assert.equal(fs.existsSync(path.dirname(settings)), false);

  const rm = recorder();
  const fail = () => {
    throw new Error('hdiutil: create failed - Resource busy');
  };
  assert.throws(
    () =>
      dmg.buildDmg(
        { app: '/a', dmg: '/d', title: 't', tool: '/bin/dmgbuild' },
        { exec: fail, mkdtemp: (() => '/tmp/x') as any, writeFile: () => {}, rm, log: () => {} },
      ),
    /Resource busy/,
  );
  assert.deepEqual(rm.calls, [['/tmp/x', { recursive: true, force: true }]]);
});

function fakeBrowser() {
  const pages: any[] = [];
  const browser = {
    pages,
    close: recorder(async () => {}),
    newPage: recorder(async (opts: any) => {
      const page = {
        opts,
        goto: recorder(async () => {}),
        evaluate: recorder(async (fn: () => unknown) => fn()),
        screenshot: recorder(async () => {}),
        close: recorder(async () => {}),
      };
      pages.push(page);
      return page;
    }),
  };
  return browser;
}

test('DMG background: rendered at 1x and 2x after the web font loads, and the browser closed', async (t) => {
  const browser = fakeBrowser();
  const log = recorder();
  (globalThis as any).document = { fonts: { ready: 'fonts-ready' } };
  t.after(() => delete (globalThis as any).document);
  const files = await bg.makeDmgBackground({ dir: '/art', launch: async () => browser as any, log });
  assert.deepEqual(files, ['/art/background.png', '/art/background@2x.png']);
  assert.deepEqual(
    browser.pages.map((p) => p.opts),
    [
      { viewport: bg.SIZE, deviceScaleFactor: 1 },
      { viewport: bg.SIZE, deviceScaleFactor: 2 },
    ],
  );
  for (const p of browser.pages) {
    assert.deepEqual(p.goto.calls[0], ['file:///art/background.html']);
    assert.equal(await p.evaluate.calls[0][0](), 'fonts-ready');
    assert.equal(p.close.calls.length, 1);
  }
  assert.deepEqual(browser.pages[1].screenshot.calls[0], [{ path: '/art/background@2x.png' }]);
  assert.equal(browser.close.calls.length, 1);
  assert.deepEqual(log.calls[1], ['Wrote', '/art/background@2x.png']);
  assert.equal(bg.DMG_DIR, path.dirname(dmg.BACKGROUND) + path.sep);

  // a failed shot still closes the browser; the default launches Playwright's Chromium
  const broken = fakeBrowser();
  broken.newPage = recorder(async () => {
    throw new Error('no page');
  });
  t.mock.method(chromium, 'launch', async () => broken);
  await assert.rejects(bg.makeDmgBackground({ dir: '/art', log }), /no page/);
  assert.equal(broken.close.calls.length, 1);
});

test('make-dmg-background CLI: --help, a render, and a failure', async () => {
  const log = recorder();
  assert.equal(await bg.main(['--help'], { make: () => assert.fail('no render'), log }), 0);
  assert.match(log.calls[0][0], /^usage: node scripts\/make-dmg-background\.mjs/);
  const make = recorder(async () => []);
  assert.equal(await bg.main([], { make }), 0);
  assert.equal(make.calls.length, 1);
  const error = recorder();
  assert.equal(
    await bg.main([], {
      make: async () => {
        throw new Error('no chromium');
      },
      error,
    }),
    1,
  );
  assert.deepEqual(error.calls, [['no chromium']]);
  const r = runScript('scripts/make-dmg-background.mjs', ['--help']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^usage:/);
});
