// scripts/signing.mjs: the signing identity, per-file entitlements, the designated requirement baked into
// the helper, and where the helper and sage-mcp sit in the package (matching what main resolves at runtime).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import edition from '../shared/edition.json' with { type: 'json' };
import {
  ENTITLEMENTS,
  isMainApp,
  mainSigningInfo,
  nestedCodePaths,
  parseDesignated,
  pickDevIdentity,
  resolveIdentity,
  signOptionsForFile,
  isHostCore,
  signHostCores,
} from '../scripts/signing.mjs';
import { swiftArchArgs } from '../scripts/swift-product.mjs';
import { defined } from './support/defined.ts';

const require = createRequire(import.meta.url);
const { helperAppPath } = require('../electron/capabilities/computer.cjs');
const { sageMcpPath } = require('../electron/capabilities/mcp/socket.cjs');
const { authCommandPath } = require('../electron/identity/contract/codexProvider.cjs');

const FIND = `  1) B9DB34BF6768770CF3868A3C9A8B4C7675F9A57E "Apple Development: Jane Doe (29RC33CGL6)"
  2) 0123456789ABCDEF0123456789ABCDEF01234567 "Developer ID Application: MoPilot Inc (AB12CD34EF)"
     2 valid identities found
`;

test('dev identity: MoPilot Code Dev, then Developer ID, then Apple Development, else none', () => {
  assert.deepEqual(pickDevIdentity(FIND), {
    hash: '0123456789ABCDEF0123456789ABCDEF01234567',
    name: 'Developer ID Application: MoPilot Inc (AB12CD34EF)',
  });
  assert.equal(defined(pickDevIdentity(FIND.split('\n')[0])).name, 'Apple Development: Jane Doe (29RC33CGL6)');
  const dev = `  1) FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF "MoPilot Code Dev"\n${FIND}`;
  assert.equal(defined(pickDevIdentity(dev)).name, 'MoPilot Code Dev');
  assert.equal(defined(pickDevIdentity(dev.replaceAll('MoPilot Code Dev', 'MoPilot Dev'))).name, 'MoPilot Dev');
  assert.equal(defined(pickDevIdentity(`  2) AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA "MoPilot Dev"\n${dev}`)).name, 'MoPilot Code Dev');
  assert.equal(pickDevIdentity('     0 valid identities found\n'), null);
});

test('identity: release from MOPILOT_SIGN_IDENTITY, dev override, keychain pick, else ad-hoc', () => {
  const none = () => '     0 valid identities found\n';
  assert.deepEqual(resolveIdentity({ MOPILOT_SIGN_IDENTITY: 'Developer ID Application: X (AB12CD34EF)' }, none), {
    identity: 'Developer ID Application: X (AB12CD34EF)',
    release: true,
  });
  assert.deepEqual(
    resolveIdentity({ MOPILOT_DEV_SIGN_IDENTITY: '-' }, () => FIND),
    { identity: '-', release: false },
  );
  assert.deepEqual(
    resolveIdentity({}, () => FIND),
    { identity: '0123456789ABCDEF0123456789ABCDEF01234567', release: false },
  );
  assert.deepEqual(resolveIdentity({}, none), { identity: '-', release: false });
  const warned: string[] = [];
  const warn = console.warn;
  console.warn = (m: string) => void warned.push(m);
  try {
    assert.deepEqual(
      resolveIdentity({}, () => {
        throw new Error('no security');
      }),
      { identity: '-', release: false },
    );
    resolveIdentity({}, () => {
      throw 'odd';
    });
  } finally {
    console.warn = warn;
  }
  // the build says why it signs ad hoc
  assert.deepEqual(warned, [
    'signing: could not list code-signing identities, signing ad hoc (no security)',
    'signing: could not list code-signing identities, signing ad hoc (odd)',
  ]);
});

test('designated requirement: read from codesign -d -r-, none for ad-hoc', () => {
  const req = 'identifier "ai.mopilot.code" and anchor apple generic and certificate leaf[subject.OU] = AB12CD34EF';
  assert.equal(parseDesignated(`Executable=/x\ndesignated => ${req}\n`), req);
  assert.equal(parseDesignated('designated => cdhash H"abcdef"\n'), undefined);
  assert.equal(parseDesignated(''), undefined);
  assert.equal(mainSigningInfo('-').designatedRequirement, undefined);
  assert.equal(mainSigningInfo('').designatedRequirement, undefined);
});

test("entitlements: the helper and sage-mcp get their own, everything else the app's", () => {
  const app = '/out/MoPilot.app';
  const helper = `${app}/Contents/Helpers/MoPilot.app`;
  assert.equal(signOptionsForFile(helper).entitlements, ENTITLEMENTS.helper);
  assert.equal(signOptionsForFile(`${helper}/Contents/MacOS/ComputerUseHelper`).entitlements, ENTITLEMENTS.helper);
  const mcp = signOptionsForFile(`${app}/Contents/Helpers/sage-mcp`);
  assert.equal(mcp.entitlements, ENTITLEMENTS.sageMcp);
  assert.deepEqual(mcp.additionalArguments, ['--identifier', 'ai.mopilot.code.sage-mcp']);
  const ac = signOptionsForFile(`${app}/Contents/Helpers/auth-command`);
  assert.equal(ac.entitlements, ENTITLEMENTS.authCommand);
  assert.deepEqual(ac.additionalArguments, ['--identifier', 'ai.mopilot.code.auth-command']);
  const dc = signOptionsForFile(`${app}/Contents/Helpers/disclaim`);
  assert.equal(dc.entitlements, ENTITLEMENTS.disclaim);
  assert.deepEqual(dc.additionalArguments, ['--identifier', 'ai.mopilot.code.disclaim']);
  for (const f of [
    app,
    `${app}/Contents/Frameworks/MoPilot Helper (Renderer).app`,
    `${app}/Contents/Resources/app.asar.unpacked/node_modules/@vscode/ripgrep-darwin-arm64/bin/rg`,
  ]) {
    assert.deepEqual(signOptionsForFile(f), { hardenedRuntime: true, entitlements: ENTITLEMENTS.app });
  }
});

test("only the app bundle and its main executable are the main app; a helper's or framework's MacOS is not", () => {
  // a parent folder named Contents is not the app's own
  const app = '/Users/x/Contents/out/MoPilot.app';
  for (const f of [app, `${app}/`, `${app}/Contents/MacOS/MoPilot`]) assert.equal(isMainApp(f), true, f);
  for (const f of [
    `${app}/Contents/Helpers/passkeys.node`,
    `${app}/Contents/Helpers/MoPilot.app/Contents/MacOS/ComputerUseHelper`,
    `${app}/Contents/Frameworks/MoPilot Helper.app/Contents/MacOS/MoPilot Helper`,
    // check-entitlements lets only the executable named after the bundle claim the profile's entitlements
    `${app}/Contents/MacOS/launcher`,
    `${app}/Contents/Resources/core/mopilot_core.node`,
    '/out/sage-mcp',
  ])
    assert.equal(isMainApp(f), false, f);
});

test('an ad-hoc package pins only the helper to its bundle identifier; an identity keeps its certificate requirement', () => {
  const app = '/out/MoPilot.app';
  const helper = `${app}/Contents/Helpers/MoPilot.app`;
  const req = `=designated => identifier "${edition.desktop.appId}.computer-use"`;
  for (const f of [helper, `${helper}/Contents/MacOS/ComputerUseHelper`]) {
    assert.deepEqual(signOptionsForFile(f, { release: false, adHoc: true }), {
      hardenedRuntime: true,
      entitlements: ENTITLEMENTS.helper,
      requirements: req,
      timestamp: 'none',
    });
    assert.equal('requirements' in signOptionsForFile(f, { release: false }), false);
    assert.equal('requirements' in signOptionsForFile(f, { release: true }), false);
  }
  for (const f of [app, `${app}/Contents/Helpers/sage-mcp`, `${app}/Contents/Frameworks/MoPilot Helper (Renderer).app`])
    assert.equal('requirements' in signOptionsForFile(f, { release: false, adHoc: true }), false);
});

test('the package puts the helper and sage-mcp where main looks for them when packaged', () => {
  const app = '/Applications/MoPilot.app';
  const resourcesPath = `${app}/Contents/Resources`;
  const nested = nestedCodePaths(app);
  assert.equal(helperAppPath({ packaged: true, resourcesPath }), nested.helper);
  assert.equal(sageMcpPath({ packaged: true, resourcesPath, platform: 'darwin' }), nested.sageMcp);
  assert.equal(authCommandPath({ packaged: true, resourcesPath }), nested.authCommand);
  assert.equal(require('../electron/platform/disclaim.cjs').disclaimPath({ packaged: true, resourcesPath }), nested.disclaim);
  assert.equal(
    require('../electron/capabilities/browser/systemPasskeys.cjs').addonPath({ packaged: true, resourcesPath }),
    nested.passkeys,
  );
});

test('local packages allow teamless Electron libraries; release packages retain library validation', () => {
  const app = '/out/MoPilot.app';
  for (const file of [
    app,
    `${app}/Contents/MacOS/MoPilot`,
    `${app}/Contents/Frameworks/Electron Framework.framework`,
    `${app}/Contents/Frameworks/MoPilot Helper (Renderer).app`,
  ]) {
    assert.equal(signOptionsForFile(file, { release: false }).entitlements, ENTITLEMENTS.dev);
    assert.equal(signOptionsForFile(file, { release: true }).entitlements, ENTITLEMENTS.app);
  }
  const dev = readFileSync(ENTITLEMENTS.dev, 'utf8');
  const release = readFileSync(ENTITLEMENTS.app, 'utf8');
  assert.match(dev, /<key>com\.apple\.security\.cs\.disable-library-validation<\/key>\s*<true\/>/);
  assert.doesNotMatch(release, /disable-library-validation/);
  // Keep the Electron JIT and microphone permissions in both configurations.
  for (const key of ['allow-jit', 'allow-unsigned-executable-memory', 'device.audio-input']) {
    assert.ok(dev.includes(key));
    assert.ok(release.includes(key));
  }
  for (const file of ['sage-mcp', 'auth-command', 'disclaim', 'MoPilot.app']) {
    const nested = `${app}/Contents/Helpers/${file}`;
    // the same entitlements either way; only a dev build skips the timestamp
    assert.deepEqual(signOptionsForFile(nested, { release: false }), {
      ...signOptionsForFile(nested, { release: true }),
      timestamp: 'none',
    });
  }
});

test('swift --arch follows the package arch', () => {
  assert.deepEqual(swiftArchArgs('x64'), ['--arch', 'x86_64']);
  assert.deepEqual(swiftArchArgs('arm64'), ['--arch', 'arm64']);
  assert.deepEqual(swiftArchArgs(undefined), []);
});

test('WebAuthn signing reads both codesign output streams and cleans up probes on success or failure', async (t) => {
  const { mainSigningInfo } = await import('../scripts/signing.mjs');
  const cp = require('node:child_process');
  const { syncBuiltinESMExports } = await import('node:module');
  const fs = require('node:fs');
  let probe = '';
  const sign = t.mock.method(cp, 'execFileSync', (_cmd: string, args: string[]) => {
    probe = args.at(-1)!;
    return '';
  });
  const inspect = t.mock.method(cp, 'spawnSync', () => ({
    status: 0,
    stdout: 'designated => identifier "ai.mopilot.code"\n',
    stderr: 'TeamIdentifier=AB12CD34EF\n',
  }));
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  assert.deepEqual(mainSigningInfo('Apple identity'), { designatedRequirement: 'identifier "ai.mopilot.code"', teamId: 'AB12CD34EF' });
  assert.equal(fs.existsSync(probe), false);
  inspect.mock.mockImplementation(() => ({ status: 0, stdout: '', stderr: 'TeamIdentifier=not set\n' }));
  assert.deepEqual(mainSigningInfo('Local development'), { designatedRequirement: undefined, teamId: undefined });
  inspect.mock.mockImplementation(() => ({ error: new Error('cannot execute') }));
  assert.throws(() => mainSigningInfo('Apple identity'), /cannot execute/);
  assert.equal(fs.existsSync(probe), false);
  inspect.mock.mockImplementation(() => ({ status: 1 }));
  assert.throws(() => mainSigningInfo('Apple identity'), /inspect the signing identity/);
  sign.mock.mockImplementation(() => {
    throw new Error('cannot sign');
  });
  assert.throws(() => mainSigningInfo('Apple identity'), /cannot sign/);
  assert.deepEqual(mainSigningInfo('-'), {});
});

test('custom WebAuthn app entitlements go to the main app only; helpers, frameworks and natives keep theirs', () => {
  const app = '/out/MoPilot.app';
  assert.equal(signOptionsForFile(app, { release: false }).entitlements, ENTITLEMENTS.dev);
  assert.equal(signOptionsForFile(app, { appEntitlements: '/tmp/webauthn.plist' }).entitlements, '/tmp/webauthn.plist');
  assert.equal(
    signOptionsForFile(`${app}/Contents/MacOS/MoPilot`, { appEntitlements: '/tmp/webauthn.plist' }).entitlements,
    '/tmp/webauthn.plist',
  );
  // the provisioning profile is embedded in the main app alone: anything else claiming the group won't load
  for (const nested of [
    `${app}/Contents/Frameworks/MoPilot Helper (Renderer).app`,
    `${app}/Contents/Frameworks/Electron Framework.framework`,
    `${app}/Contents/Frameworks/Squirrel.framework/Versions/A/Resources/ShipIt`,
    `${app}/Contents/Resources/ripgrep/rg`,
  ]) {
    assert.equal(signOptionsForFile(nested, { appEntitlements: '/tmp/webauthn.plist' }).entitlements, ENTITLEMENTS.app);
    assert.equal(signOptionsForFile(nested, { release: false, appEntitlements: '/tmp/webauthn.plist' }).entitlements, ENTITLEMENTS.dev);
  }
  assert.equal(
    signOptionsForFile(`${app}/Contents/Helpers/sage-mcp`, { appEntitlements: '/tmp/webauthn.plist' }).entitlements,
    ENTITLEMENTS.sageMcp,
  );
});

test('default signing identity discovery uses the mocked keychain boundary', async (t) => {
  const cp = require('node:child_process');
  const { syncBuiltinESMExports } = await import('node:module');
  t.mock.method(cp, 'execFileSync', () => FIND);
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  assert.equal(resolveIdentity({}).identity, '0123456789ABCDEF0123456789ABCDEF01234567');
});

test('WebAuthn entitlements: a stable Apple group only for a release with a provisioning profile', async () => {
  const { webAuthnSigning } = await import('../scripts/signing.mjs');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webauthn-signing-'));
  try {
    for (const release of [true, false]) {
      const result = webAuthnSigning({ teamId: 'AB12CD34EF', release, out: dir, profile: '/p/mopilot.provisionprofile' });
      const plist = fs.readFileSync(result.appEntitlements, 'utf8');
      if (release) {
        const group = `AB12CD34EF.${edition.desktop.appId}.webauthn`;
        assert.equal(result.webAuthnAccessGroup, group);
        assert.equal(result.provisioningProfile, '/p/mopilot.provisionprofile');
        assert.match(plist, /keychain-access-groups/);
        assert.ok(plist.includes(`<string>${group}</string>`));
      } else {
        assert.deepEqual(result, { appEntitlements: ENTITLEMENTS.dev, webAuthnAccessGroup: null, provisioningProfile: null });
        assert.doesNotMatch(plist, /keychain-access-groups/);
      }
      assert.equal(plist.includes('com.apple.security.cs.disable-library-validation'), !release);
      const plain = {
        appEntitlements: release ? ENTITLEMENTS.app : ENTITLEMENTS.dev,
        webAuthnAccessGroup: null,
        provisioningProfile: null,
      };
      assert.deepEqual(webAuthnSigning({ teamId: undefined, release, out: dir, profile: '/p/mopilot.provisionprofile' }), plain);
      // no profile, no group: macOS kills an app claiming it unprofiled at launch (0.3.1 to 0.3.7)
      assert.deepEqual(webAuthnSigning({ teamId: 'AB12CD34EF', release, out: dir }), plain);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('dev builds skip the timestamp server for every file; release builds keep the default secure timestamp', () => {
  const app = '/x/MoPilot.app';
  for (const f of [app, `${app}/Contents/Helpers/sage-mcp`, `${app}/Contents/Helpers/MoPilot.app`]) {
    assert.equal(signOptionsForFile(f, { release: false }).timestamp, 'none');
    assert.equal('timestamp' in signOptionsForFile(f, { release: true }), false);
  }
});

test('the macOS Host addons are signed with the hardened runtime before their hashes are taken; an ad-hoc build leaves them', () => {
  const runs: string[][] = [];
  const exec = ((cmd: string, args: string[]) => runs.push([cmd, ...args])) as any;
  signHostCores('/cores', { identity: 'Developer ID', release: true, exec });
  assert.deepEqual(
    runs.map((r) => r.slice(0, -1)),
    Array(2).fill(['codesign', '--force', '--sign', 'Developer ID', '--options', 'runtime', '--timestamp']),
  );
  assert.deepEqual(
    runs.map((r) => r.at(-1)),
    [path.join('/cores', 'darwin-arm64', 'mopilot_core.node'), path.join('/cores', 'darwin-x64', 'mopilot_core.node')],
  );
  runs.length = 0;
  signHostCores('/cores', { identity: 'Dev', release: false, exec });
  assert.ok(runs.every((r) => r.includes('--timestamp=none')));
  runs.length = 0;
  signHostCores('/cores', { identity: '-', release: false, exec });
  signHostCores('/cores', { identity: null, release: false, exec });
  assert.deepEqual(runs, []);
});

test('osx-sign leaves the Host builds alone, and nothing else', () => {
  assert.equal(isHostCore('/a/MoPilot.app/Contents/Resources/host-core/linux-x64-gnu/mopilot_core.node'), true);
  assert.equal(isHostCore('/a/MoPilot.app/Contents/Resources/core/mopilot_core.node'), false);
});
