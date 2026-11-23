// lifecycle native availability cases using shared in-memory fixtures.
import {
  test,
  assert,
  NativeAvailability,
  RES,
  CACHE,
  mcpJson,
  SKY,
  fullMac,
  probe,
  without,
  skyPlist,
  facts,
  live,
  row,
} from './fixture.ts';

export function registerLifecycle() {
  /* ---------------------------------------------------------- the cached probe */

  test('NativeAvailability: probes once, refreshes when stale or forced, and tells onChange only of a change', () => {
    let t = 0;
    let current = facts();
    let probes = 0;
    let changes = 0;
    const l = { ...live({ drivesUserChrome: true }), claudeEligible: () => true };
    const a = new NativeAvailability({
      probe: () => (probes++, current),
      now: () => t,
      minIntervalMs: 100,
      live: () => l,
      onChange: () => changes++,
    });
    assert.equal(a.facts(), current);
    assert.equal(a.facts(), current);
    assert.equal(probes, 1);
    a.refresh();
    assert.equal(probes, 1);
    t = 150;
    a.refresh();
    assert.equal(probes, 2);
    assert.equal(changes, 0);
    current = facts({ sky: false });
    a.refresh({ force: true });
    assert.equal(changes, 1);
    assert.deepEqual(a.codexSurfaces(), { chrome: true, computer: false });
    assert.equal(a.claudeChromeReady(), true);
    assert.match(a.degradedNote({ chrome: true, computer: false }, 'sage_y'), /desktop_\* tools of the sage_y MCP server/);
    const s = a.status();
    assert.deepEqual(
      [s.platform, s.at, row(s, 'codex').computer.state, row(s, 'claude').chrome.state],
      ['darwin', 150, 'fallback', 'native'],
    );
    l.claudeEligible = () => false;
    assert.equal(row(a.status(), 'claude').chrome.state, 'fallback');
    // a probe that throws reads as nothing native, not as a crash (and without onChange, a change is fine)
    let calls = 0;
    const broken = new NativeAvailability({
      probe: () => {
        if (calls++) throw new Error('boom');
        return facts();
      },
      live: () => l,
    });
    assert.deepEqual(broken.codexSurfaces(), { chrome: true, computer: true });
    broken.refresh({ force: true });
    assert.deepEqual(broken.codexSurfaces(), { chrome: false, computer: false });
    assert.equal(broken.claudeChromeReady(), false);
    // defaults: the real probe, the real clock, no onChange
    // (native Codex off, so nothing is ever installed into this machine's Codex home)
    const real = new NativeAvailability({ live: () => ({ ...l, codexNative: false }) });
    assert.equal(typeof real.facts().platform, 'string');
    real.refresh({ force: true });
  });

  /* ------------------------------------------- installing Codex Computer Use itself */

  test('probe: the Codex home MoPilot runs with is where Sky and the plugins cache are looked for; bin/mac/normal ships Sky too', () => {
    const home = '/opt/codex-home';
    const normal = `${RES}/cua_node/lib/node_modules/@oai/sky/bin/mac/normal/Codex Computer Use.app`;
    const files = {
      ...without(fullMac(), SKY, CACHE),
      [`${home}/plugins/cache/openai-bundled/unified-computer-use/26.2/.codex-plugin/plugin.json`]: '{}',
      [`${home}/plugins/cache/openai-bundled/unified-computer-use/26.2/.mcp.json`]: mcpJson(),
      [`${normal}/Contents/Info.plist`]: skyPlist('26.2'),
      [`${home}/computer-use/Codex Computer Use.app/Contents/Info.plist`]: skyPlist('26.1'),
    };
    assert.deepEqual(probe(files, { extra: { codexHome: home } }).codex.sky, {
      present: true,
      path: `${home}/computer-use/Codex Computer Use.app`,
      version: '26.1',
      bundled: '26.2',
      source: normal,
      canonical: `${home}/computer-use/Codex Computer Use.app`,
    });
  });

  /** Facts whose Sky can be installed from the bundled copy. */
  const installable = (sky: any) => {
    const f = facts();
    return {
      ...f,
      codex: {
        ...f.codex,
        sky: { present: false, path: null, version: null, bundled: '26.2', source: '/b/Sky.app', canonical: SKY, ...sky },
      },
    };
  };

  test('NativeAvailability: installs a missing Codex Computer Use from the bundled copy, once, and then probes again', async () => {
    let current: any = installable({});
    const plans: any[] = [];
    let changes = 0;
    const l = { ...live(), claudeEligible: () => true };
    const a = new NativeAvailability({
      probe: () => current,
      live: () => l,
      onChange: () => changes++,
      install: async (plan: any) => {
        plans.push(plan);
        current = installable({ present: true, path: SKY, version: '26.2' });
      },
    });
    // while it runs: the chats fall back, and the row says MoPilot is installing it
    assert.equal(row(a.status(), 'codex').computer.detail, 'MoPilot is installing Codex Computer Use 26.2.');
    assert.deepEqual(plans, []);
    await a.installing;
    assert.deepEqual(plans, [{ action: 'install', source: '/b/Sky.app', target: SKY, version: '26.2' }]);
    assert.equal(row(a.status(), 'codex').computer.state, 'native');
    assert.ok(changes >= 2);
    // up to date now: nothing more to do
    a.refresh({ force: true });
    assert.equal(plans.length, 1);
  });

  test('NativeAvailability: an older canonical copy is updated; a copy the plugin keeps elsewhere, or native Codex off, is left alone', async () => {
    const l = { ...live(), claudeEligible: () => true };
    const plans: any[] = [];
    const install = async (plan: any) => {
      plans.push(plan.action);
    };
    const older = new NativeAvailability({
      probe: () => installable({ present: true, path: SKY, version: '26.1' }),
      live: () => l,
      install,
    });
    assert.equal(row(older.status(), 'codex').computer.label, 'Updating');
    await older.installing;
    // the probe still finds the old copy: the same plan is not tried again
    older.refresh({ force: true });
    await older.installing;
    assert.deepEqual(plans, ['update']);
    const elsewhere = new NativeAvailability({
      probe: () => installable({ present: true, path: '/Other/Sky.app', version: '26.1' }),
      live: () => l,
      install,
    });
    assert.equal(row(elsewhere.status(), 'codex').computer.state, 'native');
    const off = new NativeAvailability({ probe: () => installable({}), live: () => ({ ...l, codexNative: false }), install });
    off.status();
    // nothing to install from, or no version known for the bundled copy
    new NativeAvailability({ probe: () => installable({ source: null }), live: () => l, install }).status();
    new NativeAvailability({ probe: () => installable({ bundled: null }), live: () => l, install }).status();
    assert.deepEqual(plans, ['update']);
    assert.equal(off.installing, null);
  });

  test('NativeAvailability: a failed install says why and offers Try again, which installs once more', async () => {
    const l = { ...live(), claudeEligible: () => true };
    let fail: any = new Error('ditto: No space left on device');
    let tries = 0;
    const a = new NativeAvailability({
      probe: () => installable({}),
      live: () => l,
      install: async () => {
        tries++;
        if (fail) throw fail;
      },
    });
    a.status();
    await a.installing;
    const failed = row(a.status(), 'codex').computer;
    assert.equal(failed.detail, "MoPilot couldn't install Codex Computer Use 26.2: ditto: No space left on device");
    assert.deepEqual(failed.actions, [{ kind: 'retry', label: 'Try again' }]);
    // not again on its own
    a.refresh({ force: true });
    assert.equal(tries, 1);
    // a rejection that isn't an Error is named as it is
    fail = 'EPERM';
    a.retry();
    await a.installing;
    assert.equal(tries, 2);
    assert.match(row(a.status(), 'codex').computer.detail, /: EPERM$/);
    // Try again while an install runs leaves it alone
    fail = null;
    let release!: () => void;
    const b = new NativeAvailability({
      probe: () => installable({}),
      live: () => l,
      install: () => new Promise<void>((r) => (release = r)),
    });
    b.status();
    b.retry();
    assert.match(row(b.status(), 'codex').computer.detail, /is installing/);
    await new Promise((r) => setImmediate(r));
    release();
    await b.installing;
  });
}
