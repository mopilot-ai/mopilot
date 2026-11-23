// Capability presentation: exhaustive producer codes, safe malformed-code fallback, and copy-only diagnostic retention.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, Module } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CAPABILITY_REASONS, capabilityReasonText, UNKNOWN_CAPABILITY_REASON } from '../shared/capabilityReasons.mjs';
import { WHY, WHY_FALLBACK } from '../src/harness/copy.ts';
import { whyText } from '../src/harness/caps.ts';

const require = createRequire(import.meta.url);
const { computerHealth, yourChromeHealth, chromeRelayHealth } = require('../electron/capabilities/capabilityHealth.cjs');
const { availabilityStatus, NativeAvailability } = require('../electron/capabilities/nativeAvailability.cjs');
const { buildDiagnostics } = require('../electron/support/diagnostics.cjs');
const raw = '/Users/private/native/helper/build/Computer Use.app; node scripts/build-helper.mjs';
const helper = { path: raw, installed: true, packaged: true, platform: 'darwin', running: true, version: '1', error: null };
const permissions = { accessibility: true, screenRecording: true };
const computer = (o: any = {}) => computerHealth({ enabled: true, helper, permissions, ...o });
const chrome = (o: any = {}) => yourChromeHealth({ chosen: true, active: true, extension: '1', ...o });
const health = (o: any = {}) => ({ computer: computer(), yourChrome: chrome(), channels: { codex: true, claude: true, acp: true }, ...o });
const facts = (o: any = {}) => ({
  platform: 'darwin',
  codex: {
    runtime: { present: true, version: '1', surfaces: null, backends: null, ...o.runtime },
    sky: { present: true, version: '1', ...o.sky },
    chrome: { extension: true, ready: true, ...o.chrome },
  },
  claude: { chrome: { extension: true, ready: true, ...o.claudeChrome } },
  ...(o.platform ? { platform: o.platform } : {}),
});
const status = (f: any = {}, live: any = {}, sky: any = {}) =>
  availabilityStatus(facts(f), { codexNative: true, claudeFlag: true, claudeEligible: true, health: health(), ...live }, sky);

// Every code is exercised at the production branch that creates it, not by reimplementing the formatter.
test('every health and native-control reason code has user copy; every family retains diagnostic detail and capability decisions', () => {
  const seen = new Set<string>();
  const check = (s: any, code: string) => {
    assert.equal(s.reasonCode, code);
    assert.ok(Object.hasOwn(CAPABILITY_REASONS, code));
    assert.notEqual(capabilityReasonText(code), UNKNOWN_CAPABILITY_REASON);
    assert.doesNotMatch(capabilityReasonText(code), /\/Users\/|build-helper|EPERM/);
    seen.add(code);
    return s;
  };
  const cases: [any, string][] = [
    [computer({ enabled: false }), 'computer.off'],
    [computer({ helper: { ...helper, installed: false, platform: 'linux' } }), 'computer.platform'],
    [computer({ helper: { ...helper, installed: false } }), 'computer.missing'],
    [computer({ helper: { ...helper, installed: false, packaged: false } }), 'computer.build'],
    [computer({ helper: { ...helper, running: false, error: raw } }), 'computer.start'],
    [computer({ permissions: { accessibility: false, screenRecording: false } }), 'computer.accessibility'],
    [computer({ permissions: { accessibility: true, screenRecording: false } }), 'computer.screenRecording'],
    [computer({ permissions: null }), 'computer.unknown'],
    [chrome({ chosen: false }), 'chrome.off'],
    [chrome({ active: false }), 'chrome.tools'],
    [chrome({ extension: null }), 'chrome.extension'],
  ];
  for (const [surface, code] of cases) {
    check(surface, code);
    const isComputer = code.startsWith('computer.');
    const all = status({ runtime: { present: false } }, { health: health({ [isComputer ? 'computer' : 'yourChrome']: surface }) });
    for (const row of all.harnesses) {
      const out = row[isComputer ? 'computer' : 'chrome'];
      // Claude's native Chrome bypasses the fallback unless its native path is unavailable.
      if (!isComputer && row.harness === 'claude') continue;
      assert.equal(out.reasonCode, code, `${code}: ${row.harness}`);
      assert.ok(out.detail.includes(surface.reason));
      assert.equal(out.actions.includes(surface.fix), Boolean(surface.fix));
    }
  }
  assert.match(cases[3][0].reason, /build-helper/);
  assert.match(cases[4][0].reason, /\/Users\/private/);
  const relay = (o: any) => chromeRelayHealth({ enabled: true, running: true, extension: '1', ...o });
  for (const [o, code] of [
    [{ enabled: false }, 'chrome.relayOff'],
    [{ running: false }, 'chrome.restart'],
    [{ kind: 'extension' }, 'chrome.pair'],
    [{ kind: 'extension', paired: true }, 'chrome.connect'],
    [{ kind: 'extension', paired: true, asking: true }, 'chrome.allow'],
    [{ kind: 'extension', installed: 'missing' }, 'chrome.install'],
    [{ kind: 'extension', installed: 'off' }, 'chrome.extensionOff'],
    [{ extension: null }, 'chrome.extension'],
  ] as const)
    check(relay(o), code);
  const native = (f: any, l: any, s: any, family: string, surface: string, code: string) =>
    check(status(f, l, s).harnesses.find((h: any) => h.harness === family)[surface], code);
  for (const surface of ['computer', 'chrome']) {
    native({}, { codexNative: false }, {}, 'codex', surface, 'native.off');
    native({ runtime: { present: false } }, {}, {}, 'codex', surface, 'native.runtime');
    native({ runtime: { present: false }, platform: 'win32' }, {}, {}, 'codex', surface, 'native.platform');
    native({ runtime: { surfaces: [] } }, {}, {}, 'codex', surface, 'native.surface');
  }
  native({ chrome: { ready: false } }, {}, {}, 'codex', 'chrome', 'codex.chromeDisabled');
  native({ chrome: { ready: false, extension: false } }, {}, {}, 'codex', 'chrome', 'codex.chromeMissing');
  native({ sky: { present: false } }, {}, {}, 'codex', 'computer', 'codex.missing');
  // Codex Computer Use not chosen in Settings (the default): MoPilot's computer use, by choice (#1381)
  native({}, { codexNativeComputer: false }, {}, 'codex', 'computer', 'native.choice');
  native({}, {}, { skyReport: { version: '1', message: raw } }, 'codex', 'computer', 'codex.incompatible');
  for (const present of [false, true]) {
    for (const action of ['install', 'update']) {
      for (const phase of ['running', 'failed']) {
        const code = phase === 'running' ? 'codex.installing' : 'codex.installFailed';
        native({ sky: { present } }, {}, { install: { action, phase, version: '2', error: raw } }, 'codex', 'computer', code);
      }
    }
  }
  native({}, {}, { install: { phase: 'waiting', version: '2' } }, 'codex', 'computer', 'codex.waiting');
  native({}, {}, { permissions: { kind: 'accessibility' } }, 'codex', 'computer', 'codex.permissions');
  native({}, { claudeEligible: false, claudeFlag: false }, {}, 'claude', 'chrome', 'native.off');
  native({ claudeChrome: { ready: false } }, { claudeEligible: false }, {}, 'claude', 'chrome', 'claude.chromeDisabled');
  native({ claudeChrome: { ready: false, extension: false } }, { claudeEligible: false }, {}, 'claude', 'chrome', 'claude.chromeMissing');
  native({}, { claudeEligible: false }, {}, 'claude', 'chrome', 'claude.subscription');
  for (const family of ['codex', 'claude', 'acp']) {
    for (const surface of ['computer', 'chrome'])
      native(
        { runtime: { present: false } },
        { claudeEligible: false, health: health({ channels: { codex: false, claude: false, acp: false } }) },
        {},
        family,
        surface,
        'tools.off',
      );
  }
  // Channel bridge code is produced and asserted by harnessCaps.test.ts.
  seen.add('tools.bridge');
  assert.deepEqual([...seen].sort(), Object.keys(CAPABILITY_REASONS).sort());
});

test('unknown, inherited and malformed reason codes have a safe fallback; all capability Why codes remain mapped', () => {
  for (const code of [null, undefined, '', 'new.code', 'constructor', '__proto__', 'toString', [], ['computer.build'], {}, 7])
    assert.equal(capabilityReasonText(code), UNKNOWN_CAPABILITY_REASON);
  for (const [code, template] of Object.entries(WHY)) {
    const text = whyText({ code, layer: code.split('.')[0] as any }, { label: 'Harness', semantic: 'computerUse' });
    assert.ok(text.length > 0, code);
    assert.doesNotMatch(text, /undefined|\{(?:label|feature)\}|build-helper|\/Users\//, code);
    assert.ok(template.length > 0);
  }
  for (const layer of Object.keys(WHY_FALLBACK)) {
    const text = whyText({ code: raw, layer: layer as any });
    assert.doesNotMatch(text, /build-helper|\/Users\//);
  }
});

test('Copy diagnostics retains raw capability evidence behind its existing path and secret scrubbing', () => {
  const c = computer({ helper: { ...helper, installed: false, packaged: false } });
  const a = status({ sky: { present: false } }, {}, { install: { phase: 'failed', action: 'install', version: '2', error: raw } });
  const text = buildDiagnostics({
    version: '1',
    platform: 'darwin',
    home: '/Users/private',
    capabilityHealth: { computer: c },
    nativeAvailability: a,
  });
  assert.match(text, /Capability health/);
  assert.match(text, /Native control/);
  assert.match(text, /build-helper/);
  assert.match(text, /computer.build/);
  assert.doesNotMatch(text, /\/Users\/private/);
});

test('the diagnostics IPC copies available snapshots without starting capability work and tolerates startup without services', async () => {
  const captured: any[] = [];
  // a module compiled with some of its requires stubbed; the rest load as usual, relative to it. Each is named by a literal
  // URL, so related-test selection (scripts/related-tests.mjs) sees that this test loads it
  const load = (url: URL, stubs: Record<string, unknown>) => {
    const file = fileURLToPath(url);
    const loaded = new Module(file);
    const real = createRequire(file);
    loaded.require = (id: string) => (Object.hasOwn(stubs, id) ? stubs[id] : real(id));
    (loaded as any)._compile(readFileSync(file, 'utf8'), file);
    return loaded.exports as any;
  };
  const ignored = { recentIgnored: () => [], noteIgnored: () => {} };
  // app:diagnostics runs the collector bug reports share (electron/support/bugReport.cjs)
  const bugReport = load(new URL('../electron/support/bugReport.cjs', import.meta.url), {
    './diagnostics.cjs': { buildDiagnostics: (v: any) => (captured.push(v), 'diagnostics') },
    '../ignored.cjs': ignored,
  });
  const loaded = {
    exports: load(new URL('../electron/app/ipc/app.cjs', import.meta.url), {
      '../../support/bugReport.cjs': bugReport,
      '../../ignored.cjs': ignored,
      '../../platform/userIdentity.cjs': { systemUsername: () => 'test' },
    }),
  };
  for (const available of [false, true]) {
    const handlers = new Map<string, any>();
    const handle = (name: string, fn: any) => handlers.set(name, fn);
    let healthReads = 0;
    let probes = 0;
    let installs = 0;
    let liveReads = 0;
    let eligibilityReads = 0;
    const c = { computer: { reason: raw } };
    const cached = facts({
      sky: { present: false, canonical: '/synthetic/installed.app', source: '/synthetic/bundled.app', bundled: '2' },
    });
    const native = new NativeAvailability({
      probe: () => (++probes, cached),
      install: () => (++installs, new Promise(() => {})),
      live: () => (
        ++liveReads, { codexNative: true, claudeFlag: true, claudeEligible: () => (++eligibilityReads, true), health: health() }
      ),
    });
    const install = { phase: 'failed', action: 'install', version: '2', error: raw };
    const skyReport = { message: raw, version: '1' };
    const permission = { kind: 'permissions' };
    const live = available
      ? {
          capabilityHealth: { snapshot: () => (++healthReads, c) },
          nativeAvailability: native,
        }
      : {};
    (loaded.exports as any).register(
      { handle, on: () => {} },
      {
        live,
        // the app's events too: register stops warming a chat when the app quits (#1848)
        app: { getVersion: () => '1', on: () => {}, isPackaged: false },
        // the IPC helper main passes every module, and the window the Quick Actions' links open in (quickActionsWiring.cjs)
        handle,
        readyMainWindow: async () => null,
        claude: { turnApi: { detect: async () => null } },
        readState: () => ({ prefs: {} }),
        findCodexBinary: async () => null,
        shellEnv: { status: () => null, childEnv: () => ({}) },
      },
    );
    assert.ok(handlers.has('quickActions:status'));
    assert.ok(handlers.has('quickActions:set'));
    assert.equal(await handlers.get('app:diagnostics')(), 'diagnostics');
    assert.equal(healthReads, Number(available));
    assert.equal(probes, 0);
    assert.equal(installs, 0);
    assert.equal(liveReads, 0);
    assert.equal(eligibilityReads, 0);
    assert.equal(captured.at(-1).capabilityHealth, available ? c : undefined);
    assert.deepEqual(
      captured.at(-1).nativeAvailability,
      available ? { facts: null, at: 0, skyReport: null, install: null, permissions: null, skyDown: null } : undefined,
    );
    if (available) {
      // Already-recorded facts and failures are copied verbatim; diagnostics never refreshes them.
      native.cached = cached;
      native.at = 17;
      native.installState = install;
      native.skyReport = skyReport;
      native.permissions = permission;
      const skyDown = { message: raw, at: 16 };
      native.skyDown = skyDown;
      assert.equal(await handlers.get('app:diagnostics')(), 'diagnostics');
      const snapshot = captured.at(-1).nativeAvailability;
      assert.deepEqual(snapshot, { facts: cached, at: 17, skyReport, install, permissions: permission, skyDown });
      assert.equal(snapshot.facts, cached);
      assert.equal(snapshot.install.error, raw);
      assert.equal(snapshot.skyReport.message, raw);
      assert.equal(probes, 0);
      assert.equal(installs, 0);
      assert.equal(liveReads, 0);
      assert.equal(eligibilityReads, 0);
      assert.equal(native.cached, cached);
      assert.equal(native.installState, install);
      assert.equal(native.installing, null);
      assert.equal(native.attempted.size, 0);
    }
  }
});

test('native capability presentation contracts remain type-only at runtime', async () => {
  for (const module of [await import('../src/lib/native/contracts/control.ts'), await import('../src/store/session/capsTypes.ts')]) {
    assert.deepEqual(
      Object.keys(module).filter((key) => key !== 'default' && key !== 'module.exports'),
      [],
    );
    assert.deepEqual((module as any).default ?? {}, {});
  }
});
