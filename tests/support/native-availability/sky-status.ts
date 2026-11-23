// sky status native availability cases using shared in-memory fixtures.
import {
  test,
  assert,
  codexNativeSurfaces,
  availabilityStatus,
  NativeAvailability,
  SKY_BUNDLE_ID,
  APP,
  CACHE,
  SKY,
  fullMac,
  probe,
  without,
  SKY_RES,
  skyPlist,
  skyFacts,
  REPORT,
  facts,
  live,
  row,
} from './fixture.ts';

export function registerSkyStatus() {
  /* ------------------------------------------------- Codex Computer Use version */

  test('probe: the installed Sky version, and the one the ChatGPT app ships, from their Info.plist', () => {
    const files = {
      ...fullMac(),
      [`${SKY}/Contents/Info.plist`]: skyPlist('26.1005.1001425'),
      [`${SKY_RES}/Contents/Info.plist`]: skyPlist('26.1007.2'),
    };
    assert.deepEqual(probe(files).codex.sky, {
      present: true,
      path: SKY,
      version: '26.1005.1001425',
      bundled: '26.1007.2',
      source: SKY_RES,
      canonical: SKY,
    });
    // a plist without the version key, or a binary one, reads as unknown; a shipped app without Sky's id is not Sky
    const unknown = {
      ...fullMac(),
      [`${SKY}/Contents/Info.plist`]: `bplist00${SKY_BUNDLE_ID}`,
      [`${SKY_RES}/Contents/Info.plist`]: skyPlist('1.0', 'com.example.other'),
    };
    assert.deepEqual(probe(unknown).codex.sky, { present: true, path: SKY, version: null, bundled: null, source: null, canonical: SKY });
    assert.equal(probe({ ...fullMac(), [`${SKY}/Contents/Info.plist`]: skyPlist(null) }).codex.sky.version, null);
    // the shipped version is known even where Sky isn't installed yet
    assert.deepEqual(probe({ ...without(fullMac(), SKY), [`${SKY_RES}/Contents/Info.plist`]: skyPlist('26.1007.2') }).codex.sky, {
      present: false,
      path: null,
      version: null,
      bundled: '26.1007.2',
      source: SKY_RES,
      canonical: SKY,
    });
  });

  test('probe: from the plugins cache, the shipped Sky is found in the node_modules folders its .mcp.json names', () => {
    const mods = '/opt/cua/node_modules';
    const files = {
      ...without(fullMac(), APP, SKY, CACHE),
      '/opt/node': '',
      [`${CACHE}/1.0/.codex-plugin/plugin.json`]: '{}',
      [`${CACHE}/1.0/.mcp.json`]: JSON.stringify({
        mcpServers: {
          cua_repl: { command: '/opt/node', env: { SKY_CUA_SERVICE_PATH: SKY, NODE_REPL_NODE_MODULE_DIRS: `/nowhere::${mods}` } },
        },
      }),
      [`${mods}/@oai/sky/Codex Computer Use.app/Contents/Info.plist`]: skyPlist('26.2000.1'),
      [`${SKY}/Contents/Info.plist`]: skyPlist('26.1005.1'),
    };
    assert.deepEqual(probe(files).codex.sky, {
      present: true,
      path: SKY,
      version: '26.1005.1',
      bundled: '26.2000.1',
      source: `${mods}/@oai/sky/Codex Computer Use.app`,
      canonical: SKY,
    });
    // a non-text list of folders is ignored
    const odd = {
      ...files,
      [`${CACHE}/1.0/.mcp.json`]: JSON.stringify({
        mcpServers: { cua_repl: { command: '/opt/node', env: { NODE_REPL_NODE_MODULE_DIRS: 4 } } },
      }),
    };
    assert.equal(probe(odd).codex.sky.bundled, null);
  });

  test('status: the Codex computer row names the installed Codex Computer Use version', () => {
    const codex = row(availabilityStatus(skyFacts('26.1005.1001425', '26.1005.1001425'), live()), 'codex');
    assert.deepEqual(codex.computer, {
      state: 'native',
      label: 'Native (Codex Computer Use)',
      detail: null,
      actions: [],
      version: 'Codex Computer Use 26.1005.1001425',
    });
    // a newer installed Sky than the shipped one, or a version that can't be compared, is no update
    assert.equal(row(availabilityStatus(skyFacts('26.2000.0', '26.1005.1'), live()), 'codex').computer.state, 'native');
    assert.equal(row(availabilityStatus(skyFacts('26.1005.1-beta', '26.2000.0'), live()), 'codex').computer.state, 'native');
    // known on the fallback row too (native computer use switched off)
    assert.equal(
      row(availabilityStatus(skyFacts('26.1', null), live({ codexNative: false })), 'codex').computer.version,
      'Codex Computer Use 26.1',
    );
  });

  test('status: an installed Codex Computer Use older than the bundled one is no reason to leave the native path', () => {
    // MoPilot updates it itself (NativeAvailability.syncSky); until then the row stays native
    const codex = row(availabilityStatus(skyFacts('26.1005.1001425', '26.1007.1'), live()), 'codex');
    assert.deepEqual([codex.computer.state, codex.computer.actions], ['native', []]);
  });

  test('status: a version mismatch with no newer copy sends new chats to MoPilot computer use, and says so without naming another app', () => {
    const f = skyFacts('26.1005.1', '26.1005.1');
    assert.deepEqual(codexNativeSurfaces(f, { enabled: true, skyReport: REPORT }), { chrome: true, computer: false });
    const codex = row(availabilityStatus(f, live(), { skyReport: REPORT }), 'codex');
    assert.deepEqual(codex.computer, {
      state: 'fallback',
      label: 'Fallback (MoPilot computer use)',
      reasonCode: 'codex.incompatible',
      detail:
        "Codex Computer Use 26.1005.1 reported a version the Codex plugin doesn't support (“Sky Computer Use API version mismatch: client=CodexComputerUseIPC-5 server=CodexComputerUseIPC-6”), and this Mac has no newer copy. New chats use MoPilot's computer use instead.",
      actions: [],
      version: 'Codex Computer Use 26.1005.1',
    });
    assert.doesNotMatch(codex.computer.detail, /ChatGPT/);
    // an unknown installed version is named plainly
    const unknown = row(availabilityStatus(skyFacts(null, null), live(), { skyReport: { ...REPORT, version: null } }), 'codex');
    assert.match(unknown.computer.detail, /^Codex Computer Use reported a version/);
    // after an update (a different version is installed) the report no longer applies
    const updated = skyFacts('26.1006.0', '26.1006.0');
    assert.equal(row(availabilityStatus(updated, live(), { skyReport: REPORT }), 'codex').computer.state, 'native');
    assert.deepEqual(codexNativeSurfaces(updated, { enabled: true, skyReport: REPORT }), { chrome: true, computer: true });
    // a report never turns a fallback into native
    assert.equal(
      row(availabilityStatus(skyFacts('26.1005.1', null), live({ codexNative: false }), { skyReport: REPORT }), 'codex').computer.state,
      'fallback',
    );
  });

  test('status: while MoPilot installs or updates Codex Computer Use, and when that fails', () => {
    const missing = { ...facts({ sky: false }) };
    const installing = { phase: 'running', action: 'install', version: '26.1007.1', error: null };
    assert.deepEqual(row(availabilityStatus(missing, live(), { install: installing }), 'codex').computer, {
      state: 'fallback',
      label: 'Fallback (MoPilot computer use)',
      reasonCode: 'codex.installing',
      detail: 'MoPilot is installing Codex Computer Use 26.1007.1.',
      actions: [],
      version: null,
    });
    const failed = { ...installing, phase: 'failed', error: 'ditto: No space left on device' };
    assert.deepEqual(row(availabilityStatus(missing, live(), { install: failed }), 'codex').computer, {
      state: 'fallback',
      label: 'Fallback (MoPilot computer use)',
      reasonCode: 'codex.installFailed',
      detail: "MoPilot couldn't install Codex Computer Use 26.1007.1: ditto: No space left on device",
      actions: [{ kind: 'retry', label: 'Try again' }],
      version: null,
    });
    // an update of a copy the plugin rejected: the chats fall back meanwhile
    const old = skyFacts('26.1005.1', '26.1007.1');
    const updating = { ...installing, action: 'update' };
    assert.equal(
      row(availabilityStatus(old, live(), { install: updating, skyReport: REPORT }), 'codex').computer.detail,
      'MoPilot is updating Codex Computer Use 26.1007.1.',
    );
    assert.equal(
      row(availabilityStatus(old, live(), { install: { ...updating, phase: 'failed', error: 'x' }, skyReport: REPORT }), 'codex').computer
        .detail,
      "MoPilot couldn't update Codex Computer Use 26.1007.1: x",
    );
    // an update of a working copy: the row stays on the native path and says what is happening
    assert.deepEqual(row(availabilityStatus(old, live(), { install: updating }), 'codex').computer, {
      state: 'update',
      label: 'Updating',
      reasonCode: 'codex.installing',
      detail: 'MoPilot is updating Codex Computer Use to 26.1007.1.',
      actions: [],
      version: 'Codex Computer Use 26.1005.1',
    });
    assert.deepEqual(row(availabilityStatus(old, live(), { install: { ...updating, phase: 'failed', error: 'x' } }), 'codex').computer, {
      state: 'update',
      label: 'Update failed',
      reasonCode: 'codex.installFailed',
      detail: "MoPilot couldn't update Codex Computer Use to 26.1007.1: x",
      actions: [{ kind: 'retry', label: 'Try again' }],
      version: 'Codex Computer Use 26.1005.1',
    });
  });

  test('status: a permission Codex Computer Use reported missing opens System Settings from MoPilot, then Check again', () => {
    const codex = row(availabilityStatus(facts(), live(), { permissions: { kind: 'permissions' } }), 'codex');
    assert.deepEqual(codex.computer, {
      state: 'permissions',
      label: 'Needs permission',
      reasonCode: 'codex.permissions',
      detail:
        'Codex Computer Use needs Accessibility and Screen & System Audio Recording. In System Settings → Privacy & Security, turn on “Codex Computer Use” in both lists, then choose Check again. Already on? It may still belong to an older copy of Codex Computer Use: in both lists, select Codex Computer Use, remove it with −, add it again with +, then choose Check again.',
      actions: [
        {
          kind: 'url',
          label: 'Open Accessibility settings',
          url: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
        },
        {
          kind: 'url',
          label: 'Open Screen Recording settings',
          url: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
        },
        { kind: 'retry', label: 'Check again' },
      ],
      version: null,
    });
  });

  test('NativeAvailability.noteSkyProblem: a version mismatch (once per message and version) and a missing permission count', () => {
    let changes = 0;
    const l = { ...live(), claudeEligible: () => true };
    const a = new NativeAvailability({ probe: () => skyFacts('26.1', '26.1'), live: () => l, onChange: () => changes++ });
    a.noteSkyProblem(null);
    a.noteSkyProblem({ kind: 'appRefused', message: 'not allowed' });
    assert.equal(changes, 0);
    assert.equal(row(a.status(), 'codex').computer.state, 'native');
    const mismatch = { kind: 'versionMismatch', message: 'Sky Computer Use API version mismatch: client=a server=b' };
    a.noteSkyProblem(mismatch);
    a.noteSkyProblem(mismatch);
    assert.equal(changes, 1);
    assert.equal(row(a.status(), 'codex').computer.state, 'fallback');
    assert.deepEqual(a.codexSurfaces(), { chrome: true, computer: false });
    a.noteSkyProblem({ ...mismatch, message: 'incompatibleClientVersion' });
    assert.equal(changes, 2);
    assert.match(row(a.status(), 'codex').computer.detail, /“incompatibleClientVersion”/);
    assert.match(a.degradedNote({ chrome: true, computer: false }, 'sage_z'), /“incompatibleClientVersion”/);

    const b = new NativeAvailability({ probe: () => skyFacts('26.1', '26.1'), live: () => l, onChange: () => changes++ });
    changes = 0;
    b.noteSkyProblem({ kind: 'permissions', message: 'Computer Use permissions are not granted' });
    b.noteSkyProblem({ kind: 'permissions', message: 'again' });
    assert.equal(changes, 1);
    assert.equal(row(b.status(), 'codex').computer.state, 'permissions');
    b.noteSkyProblem({ kind: 'permissionsPending', message: 'pending' });
    assert.equal(changes, 2);
    // Check again forgets it; the next computer-use step checks for real
    const after = b.retry();
    assert.equal(row(after, 'codex').computer.state, 'native');
    assert.equal(changes, 3);
  });

  test('NativeAvailability.noteSkyProblem: a service that did not start sends Codex chats to MoPilot until Sky works, Check again or the retry time (#1381)', () => {
    let changes = 0;
    let t = 1000;
    const l = { ...live(), claudeEligible: () => true };
    const a = new NativeAvailability({
      probe: () => skyFacts('26.1', '26.1'),
      live: () => l,
      onChange: () => changes++,
      now: () => t,
      skyDownRetryMs: 60_000,
    });
    const down = { kind: 'serviceUnavailable', message: 'Sky Computer Use native pipe startup failed' };
    a.noteSkyProblem(down);
    a.noteSkyProblem({ ...down, message: 'again' });
    assert.equal(changes, 1, 'only the change to down is told');
    assert.deepEqual(a.codexSurfaces(), { chrome: true, computer: false });
    const computer = row(a.status(), 'codex').computer;
    assert.equal(computer.state, 'fallback');
    assert.match(computer.detail, /Codex Computer Use didn't start, so chats use MoPilot's computer use for now\./);
    assert.match(a.degradedNote({ chrome: true, computer: false }, 'sage_z'), /didn't start/);
    // a desktop step that works: Sky is back
    a.noteSkyProblem({ kind: 'worked' });
    assert.equal(changes, 2);
    assert.deepEqual(a.codexSurfaces(), { chrome: true, computer: true });
    a.noteSkyProblem({ kind: 'worked' });
    assert.equal(changes, 2, 'a step that works with nothing to clear changes nothing');
    // the retry time: the next new chat tries Sky again (still down there reports it again)
    a.noteSkyProblem(down);
    t += 59_999;
    assert.equal(a.codexSurfaces().computer, false);
    t += 1;
    assert.equal(a.codexSurfaces().computer, true);
    assert.equal(row(a.status(), 'codex').computer.state, 'native');
    a.noteSkyProblem(down);
    assert.equal(changes, 4, 'down again after the retry time is a change again');
    // Check again forgets it at once
    assert.equal(row(a.retry(), 'codex').computer.state, 'native');
    assert.equal(a.codexSurfaces().computer, true);
    // a report without its vendor message still counts
    a.noteSkyProblem({ kind: 'serviceUnavailable' });
    assert.equal(a.codexSurfaces().computer, false);
    assert.equal(a.snapshot().skyDown?.message, '');
  });
}
