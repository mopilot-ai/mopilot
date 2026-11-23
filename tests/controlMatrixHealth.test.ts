// The control matrix, group H (docs/control-plane/matrix.md, design D2): one capability-health record per surface,
// built from real state, that Settings, the tools each session gets and the notes the model reads all derive from.
// Computer use on MoPilot's helper, Codex's native Computer use and Chrome, Claude in Chrome and Your Chrome:
// a surface that cannot work is hidden from the model, the note says why and what the user can do, and Settings
// shows the true state with a fix that works. The routing modules are real (Registry, ToolVisibility, the Claude
// SDK servers, the Codex thread injection, ToolSocket, NativeAvailability, the health record, the helper client);
// the file system, the helper process and the harnesses are fakes.
// Tests marked `todo` reproduce known bugs: they run and report, but do not fail the suite until fixed.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { CU, BU, type ComputerCase, claudeSession, codexConnection, healthOf, switchingChat, world } from './support/control-matrix-kit.ts';

export const GUARDS = ['electron/', 'shared/'];

const require = createRequire(import.meta.url);
const {
  availabilityStatus,
  codexDegradedNote,
  codexNativeSurfaces,
  probeNativeAvailability,
  NativeAvailability,
} = require('../electron/capabilities/nativeAvailability.cjs');
const { computerHealth, yourChromeHealth, CapabilityHealth } = require('../electron/capabilities/capabilityHealth.cjs');
const { ComputerHelper, outdatedHelperText } = require('../electron/capabilities/computer.cjs');
const { guarded } = require('../electron/capabilities/contract/actionGuard.cjs');
const { CodexToolInjection } = require('../electron/capabilities/channels/codexConfig.cjs');
const { ToolSessions } = require('../electron/capabilities/contract/session.cjs');
const { NativeCodexLifecycle } = require('../electron/capabilities/contract/codexLifecycle.cjs');
const { pluginBrowserEnv } = require('../electron/capabilities/browser/iabBackend.cjs');

/* ---------- the facts a status row and a note are built from ---------- */

/** What NativeAvailability probed: Codex's runtime (with what its plugin enables), Sky, and each extension. */
const facts = (
  o: { runtime?: boolean; sky?: boolean; chrome?: boolean; claude?: boolean; surfaces?: string[] | null; backends?: string[] | null } = {},
) => ({
  platform: 'darwin',
  codex: {
    runtime: {
      present: o.runtime ?? true,
      source: 'plugins-cache',
      version: '26.1',
      app: null,
      surfaces: o.surfaces ?? null,
      backends: o.backends ?? null,
    },
    sky: { present: o.sky ?? true, path: '/x/Codex Computer Use.app', version: '1.0', bundled: null, source: null, canonical: null },
    chrome: { host: true, extension: o.chrome ?? true, enabled: o.chrome ?? true, ready: o.chrome ?? true },
  },
  claude: { chrome: { host: true, extension: o.claude ?? true, enabled: o.claude ?? true, ready: o.claude ?? true } },
});
const live = (health: any, o: any = {}) => ({ codexNative: true, claudeFlag: true, claudeEligible: true, health, ...o });
const row = (status: any, harness: string) => status.harnesses.find((h: any) => h.harness === harness);
/** A status row is green when it says the surface works on MoPilot's own path. */
const green = (r: any) => r.state === 'mopilot' || r.state === 'fallback';
const COMPUTER_CASES: ComputerCase[] = ['ready', 'unknown', 'permission', 'error', 'missing', 'packaged-missing', 'windows', 'off'];

/** An in-memory file system (files with contents; folders implied by their paths). */
function fakeFs(files: Record<string, string>) {
  const dirs = new Set<string>();
  for (const p of Object.keys(files)) {
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/') || '/');
  }
  return {
    existsSync: (p: string) => p in files || dirs.has(p),
    readFileSync: (p: string) => {
      if (!(p in files)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return files[p];
    },
    readdirSync: (p: string) => {
      if (!dirs.has(p)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      const prefix = `${p}/`;
      return [
        ...new Set([...Object.keys(files), ...dirs].filter((x) => x.startsWith(prefix)).map((x) => x.slice(prefix.length).split('/')[0])),
      ];
    },
  };
}
const HOME = '/Users/u';
const CACHE = `${HOME}/.codex/plugins/cache/openai-bundled/unified-computer-use`;
const NODE = '/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node';
const CHROME = `${HOME}/Library/Application Support/Google/Chrome`;
const OPENAI_EXT = 'hehggadaopoacecdllhhajmbjkdcmajg';
const CLAUDE_EXT = 'fcoeoabgfenejglbffodgkkbkcdhcgfn';
const SKY = `${HOME}/.codex/computer-use/Codex Computer Use.app`;
/** A Mac as the ChatGPT app leaves it: the plugin materialized in ~/.codex, Sky, both extensions on. */
function mac(env: Record<string, string> = {}, o: { cache?: boolean; prefs?: Record<string, unknown> } = {}): Record<string, string> {
  const host = (bin: string, id: string) => JSON.stringify({ path: bin, allowed_origins: [`chrome-extension://${id}/`] });
  const prefs = (id: string) => JSON.stringify({ extensions: { settings: { [id]: o.prefs ?? { state: 1 } } } });
  return {
    '/Applications/ChatGPT.app/Contents/Resources/plugins/openai-bundled/plugins/unified-computer-use/.codex-plugin/plugin.json': '{}',
    [NODE]: '',
    ...(o.cache === false
      ? {}
      : {
          [`${CACHE}/26.1/.codex-plugin/plugin.json`]: '{}',
          [`${CACHE}/26.1/.mcp.json`]: JSON.stringify({ mcpServers: { cua_repl: { command: NODE, env } } }),
        }),
    [`${SKY}/Contents/Info.plist`]: '<key>CFBundleIdentifier</key><string>com.openai.sky.CUAService</string>',
    [`${CHROME}/NativeMessagingHosts/com.openai.codexextension.json`]: host('/bin/oai', OPENAI_EXT),
    [`${CHROME}/NativeMessagingHosts/com.anthropic.claude_code_browser_extension.json`]: host('/bin/claude', CLAUDE_EXT),
    '/bin/oai': '',
    '/bin/claude': '',
    [`${CHROME}/Default/Extensions/${OPENAI_EXT}/1/manifest.json`]: '{}',
    [`${CHROME}/Default/Extensions/${CLAUDE_EXT}/1/manifest.json`]: '{}',
    [`${CHROME}/Default/Preferences`]: JSON.stringify({
      extensions: {
        settings: { ...JSON.parse(prefs(OPENAI_EXT)).extensions.settings, ...JSON.parse(prefs(CLAUDE_EXT)).extensions.settings },
      },
    }),
  };
}
const probe = (files: Record<string, string>) =>
  probeNativeAvailability({ fs: fakeFs(files), home: HOME, platform: 'darwin', appDirs: ['/Applications'] });

/** The reason MoPilot's computer use can't work, as visibility.cjs gets it from the record (agentTools.cjs). */
const unavailable = (c: ComputerCase) => {
  const h = healthOf({ computer: c }).computer;
  return h.state === 'unavailable' ? h.reason : null;
};

/* ---------- CM-H: the capability health record ---------- */

describe('CM-H: the status matches reality', () => {
  test("CM-H01: each state of MoPilot's helper gives the computer row the same truth on every harness and segment, green only when ready", () => {
    for (const c of COMPUTER_CASES) {
      const health = healthOf({ computer: c });
      // Codex without its own computer use falls back to MoPilot's; Claude Code and ACP always use it
      const status = availabilityStatus(facts({ sky: false }), live(health));
      for (const harness of ['codex', 'claude', 'acp']) {
        const r = row(status, harness).computer;
        assert.equal(green(r), c === 'ready', `${c} on ${harness}: green only when the helper is ready`);
        if (c !== 'ready') assert.ok(r.detail.endsWith(health.computer.reason), `${c} on ${harness}: says why`);
      }
      // a chat that switched harness reads the same record on its new segment: same verdict, same fix
      assert.deepEqual(row(status, 'claude').computer.actions, row(status, 'acp').computer.actions);
    }
    // the reported repro: an unpackaged build without the helper is not green, and names where it looked
    const missing = row(availabilityStatus(facts(), live(healthOf({ computer: 'missing' }))), 'claude').computer;
    assert.deepEqual([missing.state, missing.label], ['unavailable', 'Unavailable']);
    assert.match(missing.detail, /MoPilot Computer Use isn't built in this checkout \(.*MoPilot\.app\)/);
    // the fixes that work: a permission pane, or checking the helper again
    const perm = row(availabilityStatus(facts(), live(healthOf({ computer: 'permission' }))), 'claude').computer;
    assert.deepEqual(
      [perm.state, perm.label, perm.actions],
      ['permissions', 'Needs permission', [{ kind: 'computerPermission', label: 'Open System Settings', permission: 'screenRecording' }]],
    );
    const failed = row(availabilityStatus(facts(), live(healthOf({ computer: 'error' }))), 'acp').computer;
    assert.deepEqual([failed.label, failed.actions], ["Couldn't start", [{ kind: 'computerCheck', label: 'Try again' }]]);
    // a harness whose tool channel is off gets none of MoPilot's tools: never green
    const off = availabilityStatus(facts(), live(healthOf({ channels: { claude: false } })));
    assert.deepEqual(
      [row(off, 'claude').computer.state, row(off, 'claude').computer.detail],
      ['unavailable', "MoPilot's tools are turned off for Claude Code sessions."],
    );
    assert.equal(row(off, 'acp').computer.state, 'mopilot');
  });

  test('CM-H02: a helper that cannot work here is hidden from Claude Code sessions and Codex threads, before and after a switch, and refused with why', async () => {
    const w = world();
    w.state.computerUnavailable = unavailable('missing');
    assert.ok(w.state.computerUnavailable);
    const claude = claudeSession(w, { chatId: 'c1', segmentId: 's1' });
    assert.ok(!claude.tools.includes(CU), 'Claude Code is not offered desktop_*');
    const chat = switchingChat(w);
    const { thread } = await chat.codex.startThread();
    const codex = await chat.codex.session(thread.id);
    assert.ok(!codex.tools.includes(CU), 'a Codex thread is not offered desktop_*');
    assert.ok(!codex.tools.includes('computer_click'), 'nor computer_*');
    // a session that listed it before: the call is refused with the reason, and never runs
    const refused = await codex.call(CU);
    assert.equal(refused.isError, true);
    assert.match(
      refused.content[0].text,
      /isn't built in this checkout .*Tell the user computer use is unavailable \(Settings → Computer use says why\); do not work around it\./,
    );
    assert.deepEqual(w.calls, []);
    assert.equal(w.vis.managedComputer(), false);
    // the helper is there again (built, or the app reinstalled): the next session gets desktop_*
    w.state.computerUnavailable = null;
    assert.ok(claudeSession(w, { chatId: 'c1', segmentId: 's2' }).tools.includes(CU));
    assert.ok((await chat.codex.session(thread.id)).tools.includes(CU));
    // a missing permission or a failed launch keeps the tools: the in-chat permission card and the next launch fix it
    for (const c of ['permission', 'error', 'unknown'] as ComputerCase[]) assert.equal(unavailable(c), null, c);
  });

  test("CM-H03: a native Codex thread's note sends the model to desktop_* only while MoPilot's computer use can work", () => {
    const missingSky = facts({ sky: false });
    const usable = codexDegradedNote(missingSky, { chrome: true, computer: false }, { serverName: 'sage_x', health: healthOf() });
    assert.match(usable!, /use the desktop_\* tools of the sage_x MCP server/);
    for (const c of ['missing', 'packaged-missing', 'windows', 'off'] as ComputerCase[]) {
      const health = healthOf({ computer: c });
      const note = codexDegradedNote(missingSky, { chrome: true, computer: false }, { serverName: 'sage_x', health })!;
      assert.doesNotMatch(note, /desktop_\*/, `${c}: no tool that fails every call`);
      assert.ok(note.includes(health.computer.reason), `${c}: says why`);
      assert.match(note, /say it is unavailable.*Do not work around it\./);
    }
    // through the real thread injection, as the first turn of a native thread carries it
    const w = world();
    const na = new NativeAvailability({
      probe: () => missingSky,
      live: () => ({
        codexNative: true,
        claudeFlag: false,
        claudeEligible: () => false,
        health: healthOf({ computer: 'packaged-missing' }),
      }),
      install: async () => {},
    });
    const sessions = new ToolSessions();
    const inj = new CodexToolInjection({
      sessions,
      command: '/bin/sage-mcp',
      socketPath: '/tmp/s.sock',
      harnessPid: () => 1,
      nativeEnabled: () => true,
      nativeSurfaces: () => na.codexSurfaces(),
      nativeHideFor: (s: any) => w.vis.forHost({ nativeChrome: s.chrome, nativeComputer: s.computer }),
      degradedNote: (s: any, name: string) => na.degradedNote(s, name),
      visibleTools: () => w.r.list().map((t: any) => t.name),
    });
    inj.outgoing({ id: 1, method: 'thread/start', params: {} });
    inj.observe({ id: 1, result: { thread: { id: 'cx-1' } } });
    const note = inj.turnContext('cx-1')?.context.value ?? '';
    assert.match(note, /missing from this installation .*update or reinstall MoPilot/);
    assert.doesNotMatch(note, /build-helper|desktop_\* tools of/);
  });

  test("CM-H04: the helper's developer advice never reaches a packaged app's users or its model", async () => {
    const packaged = new ComputerHelper({ appPath: '/A/Helper.app', platform: 'darwin', packaged: true, exists: () => false });
    assert.equal(packaged.installed, false);
    const states: string[] = [];
    packaged.on('state', () => states.push(packaged.lastError));
    await assert.rejects(packaged.start(), (e: Error) => !/build-helper/.test(e.message) && /update or reinstall MoPilot/.test(e.message));
    assert.match(states[0], /not found at \/A\/Helper\.app/);
    const dev = new ComputerHelper({ appPath: '/A/Helper.app', platform: 'darwin', exists: () => false });
    await assert.rejects(dev.start(), /run node scripts\/build-helper\.mjs/);
    // a helper too old for a request: the fix it carries, not a script name, in a packaged app
    assert.equal(
      outdatedHelperText({ fix: packaged.fix }),
      'The computer-use helper is out of date; update or reinstall MoPilot and try again',
    );
    assert.match(
      outdatedHelperText({ fix: dev.fix }, 'for background control'),
      /out of date for background control; rebuild it \(node scripts\/build-helper\.mjs\)/,
    );
    assert.match(outdatedHelperText(null), /update or reinstall MoPilot/);
    // the record's reason, which Settings shows and hidden tools are refused with, follows the same rule
    assert.doesNotMatch(healthOf({ computer: 'packaged-missing' }).computer.reason, /build-helper/);
    // not macOS: there is no helper to launch
    assert.equal(new ComputerHelper({ appPath: '/A', platform: 'win32', exists: () => true }).installed, false);
    assert.equal(new ComputerHelper({ connectTo: '/tmp/x.sock' }).installed, true);
  });
});

describe('CM-H: what the installed vendor pieces really enable', () => {
  test("CM-H05: Codex's native path is chosen only where this Codex home's materialized plugin enables the surface", () => {
    // everything materialized and enabled: native for both
    assert.deepEqual(codexNativeSurfaces(probe(mac()), { enabled: true }), { chrome: true, computer: true });
    // ChatGPT.app's bundle alone is not what threads load: no native path, so desktop_* and Your Chrome stay
    const appOnly = probe(mac({}, { cache: false }));
    assert.deepEqual(codexNativeSurfaces(appOnly, { enabled: true }), { chrome: false, computer: false });
    // the plugin enables only the browser surface: computer use stays MoPilot's
    const browserOnly = probe(mac({ CUA_REPL_ENABLED_SURFACES: 'browser' }));
    assert.deepEqual(codexNativeSurfaces(browserOnly, { enabled: true }), { chrome: true, computer: false });
    const status = availabilityStatus(browserOnly, live(healthOf()));
    assert.equal(row(status, 'codex').computer.detail, "The installed Codex plugin (26.1) doesn't enable computer use.");
    // its browser service has no Chrome backend: the user's Chrome stays MoPilot's
    const noChrome = probe(mac({ BROWSER_USE_AVAILABLE_BACKENDS: 'iab,mcpapps' }));
    assert.deepEqual(codexNativeSurfaces(noChrome, { enabled: true }), { chrome: false, computer: true });
    assert.match(
      row(availabilityStatus(noChrome, live(healthOf({ yourChrome: true }))), 'codex').chrome.detail,
      /doesn't enable the user's Chrome/,
    );
    // so the thread's sage-mcp keeps the tools for what the plugin leaves out
    const w = world();
    w.state.yourChrome = true;
    const hide = w.vis.forHost({ nativeChrome: false, nativeComputer: true });
    assert.equal(hide(BU), false);
    assert.equal(hide(CU), true);
  });

  test("CM-H06: an extension turned off in Chrome is not ready: Claude Code keeps Your Chrome, Codex keeps MoPilot's", () => {
    for (const prefs of [{ state: 0 }, { state: 1, disable_reasons: [1] }, { disable_reasons: 2 }]) {
      const f = probe(mac({}, { prefs }));
      assert.deepEqual(f.claude.chrome, { host: true, extension: true, enabled: false, ready: false }, JSON.stringify(prefs));
      assert.equal(f.codex.chrome.ready, false);
      const status = availabilityStatus(f, live(healthOf({ yourChrome: true }), { claudeEligible: false }));
      assert.deepEqual(
        [row(status, 'claude').chrome.state, row(status, 'claude').chrome.detail],
        ['fallback', 'The Claude in Chrome extension is turned off in Chrome; turn it on in Chrome → Extensions.'],
      );
      assert.match(row(status, 'codex').chrome.detail, /ChatGPT for Chrome extension is turned off in Chrome/);
    }
    // a Claude Code session starts with --chrome only while the extension is on (harness/claude/index.cjs nativeChrome)
    const na = new NativeAvailability({
      probe: () => probe(mac({}, { prefs: { state: 0 } })),
      live: () => ({ codexNative: false, claudeFlag: true, claudeEligible: () => true, health: healthOf() }),
      install: async () => {},
    });
    assert.equal(na.claudeChromeReady(), false);
    // and Your Chrome's tools stay for it: no second controller, none missing
    const w = world();
    w.state.yourChrome = true;
    assert.ok(claudeSession(w, { chatId: 'c', segmentId: 's' }).tools.includes(BU));
    // an extension in the folder that Chrome never registered is not ready either
    const unregistered = probe(Object.fromEntries(Object.entries(mac()).filter(([k]) => !k.endsWith('/Preferences'))));
    assert.equal(unregistered.claude.chrome.ready, false);
  });

  test('CM-H07: Your Chrome is green only when its tools loaded and the Playwright Extension is installed; otherwise the note never sends the model to sage_browser_*', () => {
    const rows = (yc: any) =>
      availabilityStatus(
        facts({ claude: false, chrome: false }),
        live(healthOf({ yourChrome: yc }), { claudeFlag: false, claudeEligible: false }),
      );
    const ready = rows(true);
    assert.equal(row(ready, 'acp').chrome.state, 'mopilot');
    // chosen, but configure('chrome') registered no tools: not "Your Chrome", and why
    const unloaded = rows('unloaded');
    for (const h of ['acp', 'claude', 'codex']) assert.equal(row(unloaded, h).chrome.state, 'unavailable', h);
    assert.match(row(unloaded, 'acp').chrome.detail, /couldn't be loaded; test the connection in Browser settings/);
    assert.deepEqual(row(unloaded, 'acp').chrome.actions, [{ kind: 'settings', label: 'Browser settings', section: 'browser' }]);
    // loaded, but the extension isn't installed: needs setup, with the extension's page
    const noExt = row(rows('noExtension'), 'acp').chrome;
    assert.deepEqual([noExt.state, noExt.label, noExt.actions[0].label], ['permissions', 'Needs setup', 'Get the extension']);
    // a native Codex thread without Chrome is told the truth about Your Chrome
    const note = (yc: any) =>
      codexDegradedNote(
        facts({ chrome: false }),
        { chrome: false, computer: true },
        { serverName: 'sage_x', health: healthOf({ yourChrome: yc }) },
      )!;
    assert.match(note(true), /use the sage_browser_\* tools of the sage_x MCP server/);
    assert.match(note('noExtension'), /use the sage_browser_\* tools/);
    assert.doesNotMatch(note('unloaded'), /sage_browser_\* tools of/);
    assert.match(
      note('unloaded'),
      /Your Chrome can't be used either .*fix Your Chrome in MoPilot's Browser settings\. Do not work around it\./,
    );
    assert.match(note(false), /choose Your Chrome in MoPilot's Browser settings/);
    // the record's verdicts themselves
    assert.equal(yourChromeHealth({ chosen: true, active: true, extension: null }).fix, null);
    // a harness without MoPilot's tools never shows Your Chrome as working
    const noCodexTools = availabilityStatus(facts({ chrome: false }), live(healthOf({ yourChrome: true, channels: { codex: false } })));
    assert.deepEqual(
      [row(noCodexTools, 'codex').chrome.state, row(noCodexTools, 'codex').chrome.detail],
      ['unavailable', "The ChatGPT for Chrome extension isn't installed. MoPilot's tools are turned off for Codex threads."],
    );
  });

  test("CM-H08: a thread native only for Chrome is told the plugin's computer use is unavailable here, and given desktop_* only when they work", () => {
    const chromeOnly = facts({ sky: false });
    assert.deepEqual(codexNativeSurfaces(chromeOnly, { enabled: true }), { chrome: true, computer: false });
    const note = codexDegradedNote(chromeOnly, { chrome: true, computer: false }, { serverName: 'sage_x', health: healthOf() })!;
    assert.match(note, /Computer use through the Computer plugin is unavailable here \(Codex Computer Use isn't installed/);
    assert.doesNotMatch(note, /Browser plugin cannot reach/);
    const none = codexDegradedNote(
      chromeOnly,
      { chrome: true, computer: false },
      { serverName: 'sage_x', health: healthOf({ computer: 'off' }) },
    )!;
    assert.match(none, /say it is unavailable/);
  });

  test('CM-H09: the newest plugin version is picked by number, never by text, and a `latest` folder is no version', () => {
    const files = mac();
    const env = (v: string) =>
      JSON.stringify({
        mcpServers: { cua_repl: { command: NODE, env: { BROWSER_USE_CODEX_APP_VERSION: v, BROWSER_USE_AVAILABLE_BACKENDS: 'iab' } } },
      });
    const many = {
      ...files,
      [`${CACHE}/26.9/.codex-plugin/plugin.json`]: '{}',
      [`${CACHE}/26.9/.mcp.json`]: env('26.9'),
      [`${CACHE}/26.10/.codex-plugin/plugin.json`]: '{}',
      [`${CACHE}/26.10/.mcp.json`]: env('26.10'),
      [`${CACHE}/latest/.codex-plugin/plugin.json`]: '{}',
      [`${CACHE}/latest/.mcp.json`]: env('latest'),
    };
    assert.equal(probe(many).codex.runtime.version, '26.10');
    // the in-app browser backend reads the same copy
    assert.equal(pluginBrowserEnv({ fs: fakeFs(many), codexHome: `${HOME}/.codex` }).version, '26.10');
  });
});

describe('CM-H: Settings shows the true state and a fix that works', () => {
  test('CM-H10: required permissions decide the verdict; Input Monitoring is optional; unknown is never shown as missing', () => {
    const helper = { path: '/h.app', installed: true, packaged: true, platform: 'darwin', running: true, version: '1', error: null };
    const v = (permissions: any) => computerHealth({ enabled: true, helper, permissions });
    assert.equal(v({ accessibility: true, screenRecording: true, inputMonitoring: false }).state, 'ready');
    assert.equal(
      v({ accessibility: false, screenRecording: false }).reason,
      'MoPilot needs Accessibility and Screen Recording in System Settings → Privacy & Security.',
    );
    assert.deepEqual(v({ accessibility: false, screenRecording: true }).fix, {
      kind: 'computerPermission',
      label: 'Open System Settings',
      permission: 'accessibility',
    });
    assert.deepEqual([v(null).state, v(null).usable], ['unknown', true]);
    // off macOS the record says what is true there, not "turned off"
    assert.equal(
      computerHealth({ enabled: true, helper: { ...helper, platform: 'win32', installed: false }, permissions: null }).reason,
      "MoPilot's computer use needs macOS.",
    );
    // a helper reachable anyway (the e2e tests' fake helper socket) is judged on what it reports
    assert.equal(
      computerHealth({
        enabled: true,
        helper: { ...helper, platform: 'linux' },
        permissions: { accessibility: true, screenRecording: true },
      }).state,
      'ready',
    );
  });

  test('CM-H11: a Screen Recording grant made while the helper runs is read by a new helper, never while it holds the desktop or answers a request', async () => {
    const helper = new ComputerHelper({ appPath: '/A', platform: 'darwin', exists: () => true });
    let generation = 0;
    const stops: number[] = [];
    // a running helper process: its permission answers come from the generation it was launched in
    const launch = () => {
      generation++;
      helper.socket = { write() {}, end() {}, gen: generation };
    };
    launch();
    helper.call = async (method: string) => {
      if (!helper.socket) launch();
      assert.equal(method, 'permissions.status');
      return { accessibility: true, screenRecording: helper.socket.gen > 1 };
    };
    const stop = helper.stop.bind(helper);
    helper.stop = () => (stops.push(generation), stop());
    // first read: the pre-grant process says off
    assert.deepEqual(await helper.freshPermissionStatus(), { accessibility: true, screenRecording: false });
    assert.deepEqual(stops, []);
    // the user granted it meanwhile; a chat holds the desktop: the process is kept
    assert.equal((await helper.freshPermissionStatus(() => false)).screenRecording, false);
    // a request in flight: kept too
    helper.pending.set(99, {});
    assert.equal((await helper.freshPermissionStatus()).screenRecording, false);
    helper.pending.clear();
    // idle: a new process reads the grant
    assert.equal((await helper.freshPermissionStatus()).screenRecording, true);
    assert.deepEqual(stops, [1]);
    assert.deepEqual(helper.permissions, { accessibility: true, screenRecording: true });
    // granted: never relaunched again
    await helper.freshPermissionStatus();
    assert.deepEqual(stops, [1]);
    // a call that was stopped (it may only give the Mac back) never relaunches it, even with Screen Recording off
    helper.permissions = { accessibility: true, screenRecording: false };
    await guarded({ signal: AbortSignal.abort() }, () => helper.freshPermissionStatus());
    assert.deepEqual(stops, [1]);
    // nor does a live call's chat moving on (Esc, turn end) between its checks
    let epoch = 0;
    await guarded({ epoch: () => epoch }, async () => {
      epoch++;
      await helper.freshPermissionStatus();
    });
    assert.deepEqual(stops, [1]);
  });

  test('CM-H12: the helper launching, failing, exiting or reporting permissions reaches the health record and every open Settings page', () => {
    const changes: number[] = [];
    let facts: any = {
      path: '/h',
      installed: true,
      packaged: false,
      platform: 'darwin',
      running: false,
      version: null,
      error: null,
      permissions: null,
    };
    let flags: Record<string, boolean> = {
      'shared.computerUse.enabled': true,
      'channel.claude.sdkMcp': true,
      'channel.codex.threadConfigMcp': true,
      'channel.acp.sessionMcp': true,
    };
    const record = new CapabilityHealth({
      isEnabled: (k: string) => !!flags[k],
      helper: () => facts,
      yourChrome: () => ({ chosen: false, active: false, extension: null }),
      sageMcp: () => true,
      onChange: () => changes.push(1),
    });
    assert.equal(record.changed(), true);
    assert.equal(record.changed(), false, 'nothing changed: nothing is said');
    facts = { ...facts, error: 'open failed (1)' };
    assert.equal(record.changed(), true);
    assert.equal(record.computer().state, 'error');
    facts = { ...facts, error: null, running: true, permissions: { accessibility: true, screenRecording: true } };
    record.changed();
    assert.equal(record.computer().state, 'ready');
    // a remote switch turns a channel off: the record (and the rows) follow at once
    flags = { ...flags, 'channel.acp.sessionMcp': false };
    assert.deepEqual(record.channels(), { claude: true, codex: true, acp: false });
    record.changed();
    assert.equal(changes.length, 4);
    // before computer use is set up nothing is known yet, and nothing is hidden for it
    const early = new CapabilityHealth({
      isEnabled: () => true,
      helper: () => null,
      yourChrome: () => ({ chosen: false, active: false, extension: null }),
    });
    assert.deepEqual([early.computer().state, early.computer().usable], ['unknown', true]);
    assert.equal(early.changed(), true);
    // no sage-mcp: Codex threads and ACP sessions get none of MoPilot's tools
    const noSage = new CapabilityHealth({
      isEnabled: () => true,
      helper: () => null,
      yourChrome: () => ({ chosen: false, active: false, extension: null }),
      sageMcp: () => false,
    });
    assert.deepEqual(noSage.channels(), { claude: true, codex: false, acp: false });
  });

  test('CM-H13: an update of Codex Computer Use waits while a loaded native thread may run the installed copy', async () => {
    const installs: any[] = [];
    let inUse = true;
    const sky = { present: true, path: '/c/Sky.app', version: '1.0', bundled: '2.0', source: '/b/Sky.app', canonical: '/c/Sky.app' };
    const f = { ...facts(), codex: { ...facts().codex, sky } };
    let t = 0;
    const na = new NativeAvailability({
      probe: () => f,
      now: () => (t += 10_000),
      live: () => ({ codexNative: true, claudeFlag: false, claudeEligible: () => false, health: healthOf() }),
      install: async (plan: any) => installs.push(plan),
      skyInUse: () => inUse,
    });
    let changes = 0;
    na.onChange = () => changes++;
    na.refresh({ force: true });
    await na.installing;
    assert.equal(installs.length, 0, 'not while a native thread runs it');
    // the Codex row says the update waits, and why
    assert.equal(na.installState.phase, 'waiting');
    const waiting = row(na.status(), 'codex').computer;
    assert.deepEqual([waiting.state, waiting.label], ['update', 'Update waiting']);
    assert.match(waiting.detail, /updates Codex Computer Use to 2\.0 once no loaded Codex chat is using it/);
    // looked at again while still in use: said once
    na.refresh({ force: true });
    assert.equal(changes, 1);
    // the thread unloaded: the next look (window focus) updates it
    inUse = false;
    na.refresh();
    await na.installing;
    assert.equal(installs.length, 1);
    assert.equal(na.installState, null);
    // a copy Codex reported broken never waits: no loaded thread can use it
    const broken = new NativeAvailability({
      probe: () => f,
      live: () => ({ codexNative: true, claudeFlag: false, claudeEligible: () => false, health: healthOf() }),
      install: async (plan: any) => installs.push(plan),
      skyInUse: () => true,
    });
    broken.skyReport = { message: 'unsupported version', version: '1.0' };
    broken.refresh({ force: true });
    await broken.installing;
    assert.equal(installs.length, 2);
    // native Codex switched off while an update waits: nothing waits any more
    let native = true;
    const off = new NativeAvailability({
      probe: () => f,
      live: () => ({ codexNative: native, claudeFlag: false, claudeEligible: () => false, health: healthOf() }),
      install: async (plan: any) => installs.push(plan),
      skyInUse: () => true,
    });
    off.refresh({ force: true });
    assert.equal(off.installState.phase, 'waiting');
    native = false;
    off.refresh({ force: true });
    assert.equal(off.installState, null);
    // a failed install shown before stays shown while an update would wait
    off.installState = { phase: 'failed', action: 'update', version: '2.0', error: 'e' };
    native = true;
    off.refresh({ force: true });
    assert.equal(off.installState.phase, 'failed');
    // an install where none is in place never waits: no thread can be using a copy that isn't there
    const missing = { ...f, codex: { ...f.codex, sky: { ...sky, present: false, path: null, version: null } } };
    const fresh = new NativeAvailability({
      probe: () => missing,
      live: () => ({ codexNative: true, claudeFlag: false, claudeEligible: () => false, health: healthOf() }),
      install: async (plan: any) => installs.push(plan),
      skyInUse: () => true,
    });
    fresh.refresh({ force: true });
    await fresh.installing;
    assert.equal(installs.at(-1).action, 'install');
    assert.equal(installs.length, 3);
    // the thread injection says whether a loaded native thread runs the vendor's computer use
    const w = world();
    const conn = codexConnection(w, (id) => id, { chrome: false, computer: true });
    assert.equal(conn.inj.nativeComputerLoaded(), false);
    const { thread } = await conn.startThread();
    assert.equal(conn.inj.nativeComputerLoaded(), true);
    conn.unload(thread.id);
    assert.equal(conn.inj.nativeComputerLoaded(), false);
    const chromeOnly = codexConnection(w, (id) => id, { chrome: true, computer: false });
    await chromeOnly.startThread();
    assert.equal(chromeOnly.inj.nativeComputerLoaded(), false);
  });

  test('CM-H14: guard: every Settings status row and every model note derives from the health record, never from the registry or a probe of its own', () => {
    const src = (p: string) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
    const na = [
      'electron/capabilities/nativeAvailability.cjs',
      'electron/capabilities/nativeAvailability/probe.cjs',
      'electron/capabilities/nativeAvailability/status.cjs',
    ]
      .map(src)
      .join('\n');
    // the rows and notes read MoPilot's own surfaces only from live.health
    for (const word of ['managedComputer', 'drivesUserChrome', 'registry', 'toolVisibility', 'computerEnabled'])
      assert.doesNotMatch(na, new RegExp(`\\b${word}\\b`), `nativeAvailability.cjs reads ${word} itself`);
    const tools = src('electron/app/agentTools.cjs');
    const liveBlock = tools.slice(
      tools.indexOf('nativeAvailability = new NativeAvailability('),
      tools.indexOf("app.on('browser-window-focus'"),
    );
    assert.match(liveBlock, /health: health\.snapshot\(\)/);
    assert.doesNotMatch(liveBlock, /managedComputer|drivesUserChrome|computerEnabled/);
    // the tool sets hide what the record says cannot work
    assert.match(tools, /computerUnavailable: \(\) => \{\s+const c = health\.computer\(\);/);
    // Settings → Computer use: map the record's reason code, never raw diagnostics or guesses from permission rows
    const page = src('src/components/pages/settings/ComputerUse.tsx');
    assert.match(page, /\{capabilityReasonText\(health\.reasonCode\)\}/);
    assert.doesNotMatch(page, /couldn't start: \{st\.helper\.error\}|\{\s*health\.reason\s*\}|[?:]\s*st\.health\.reason\b/);
    assert.doesNotMatch(page, /const missing = PERMISSIONS/);
    // and every computer row, for every helper state and harness, is the record's verdict
    for (const c of COMPUTER_CASES) {
      const health = healthOf({ computer: c });
      for (const r of availabilityStatus(facts({ sky: false }), live(health)).harnesses) {
        assert.equal(green(r.computer), health.computer.state === 'ready', `${c} ${r.harness}`);
        const n = codexDegradedNote(facts({ sky: false }), { chrome: true, computer: false }, { serverName: 's', health })!;
        assert.equal(/desktop_\*/.test(n), health.computer.usable, `${c}: the note offers desktop_* exactly when usable`);
      }
    }
  });
});

describe('CM-H: a step that works clears a stale failure, in every Chromium browser', () => {
  test('CM-H15: a later successful Codex computer-use step clears the Codex row\'s "Needs permission"', () => {
    let changes = 0;
    const na = new NativeAvailability({
      probe: () => facts(),
      live: () => ({ codexNative: true, claudeFlag: false, claudeEligible: () => false, health: healthOf() }),
      install: async () => {},
      onChange: () => changes++,
    });
    const reports: string[] = [];
    const life = new NativeCodexLifecycle({
      call: async () => ({}),
      isNativeThread: () => true,
      onSkyProblem: (_t: string, p: any) => (reports.push(p.kind), na.noteSkyProblem(p)),
    });
    const step = (id: string, code: string, o: any = {}, method = 'item/completed', tool = 'js') =>
      life.observe({
        method,
        params: {
          threadId: 't',
          turnId: 'u',
          item: {
            id,
            type: 'mcpToolCall',
            server: 'cua_repl',
            tool,
            status: 'completed',
            arguments: { code },
            result: { content: [{ type: 'text', text: 'done' }] },
            ...o,
          },
        },
      });
    const codexRow = () => row(na.status(), 'codex').computer.state;
    assert.equal(codexRow(), 'native');
    na.noteSkyProblem({ kind: 'permissions', message: 'Screen Recording is off' });
    assert.equal(codexRow(), 'permissions');
    // a browser program, plain JS, a step still running and a desktop step that failed prove nothing about Sky
    step('b', 'const tab = await cua.createBrowserTab(); await tab.goto("https://a.test/")');
    step('j', '1 + 1');
    step('s', 'const notes = cua.getApp("Notes"); await notes.click(1, 2)', {}, 'item/started');
    step('f', 'const notes = cua.getApp("Notes"); await notes.click(1, 2)', { status: 'failed', error: { message: 'boom' } });
    step('e', 'await notes.click(1, 2)', { result: { isError: true, content: [{ type: 'text', text: 'boom' }] } });
    // finding or binding an app needs no permission, and a caught Sky error printed among other lines is no success
    step('find', 'const apps = await cua.listApps(); const notes = await cua.getApp("Notes"); notes.name');
    step('caught', 'try { await notes.click(1, 2) } catch (e) { console.log(e.message) } console.log("next")', {
      result: { content: [{ type: 'text', text: 'Computer Use permissions are not granted.\nnext' }] },
    });
    assert.equal(codexRow(), 'permissions');
    // a later program acting on the app bound before finished: Sky had what it needs, the row is green again
    const before = changes;
    step('ok', 'await notes.click(3, 4)');
    assert.equal(codexRow(), 'native');
    assert.equal(changes, before + 1);
    // nothing left to clear: no change reported
    step('ok2', 'await notes.click(5, 6)');
    assert.equal(changes, before + 1);
    // a reset kernel forgot `notes`: the same program no longer counts as a desktop step
    na.noteSkyProblem({ kind: 'permissionsPending' });
    step('r', '', {}, 'item/started', 'js_reset');
    step('after', 'await notes.click(1, 2)');
    assert.equal(codexRow(), 'permissions');
    // a desktop program on its own clears it
    step('own', 'await sky.screenshot()');
    assert.equal(codexRow(), 'native');
    // a closed thread, a forgotten one and a disconnect forget the kernel the same way (each binds in a step that failed)
    const failed = { status: 'failed', error: { message: 'boom' } };
    na.noteSkyProblem({ kind: 'permissions' });
    step('bind', 'const mail = cua.getApp("Mail")', failed);
    life.observe({ method: 'thread/closed', params: { threadId: 't' } });
    step('closed', 'await mail.click(1, 2)');
    step('bind2', 'const mail = cua.getApp("Mail")', failed);
    life.forget('t');
    step('forgot', 'await mail.click(1, 2)');
    step('bind3', 'const mail = cua.getApp("Mail")', failed);
    life.clear();
    step('cleared', 'await mail.click(1, 2)');
    assert.equal(codexRow(), 'permissions');
    assert.ok(reports.filter((k) => k === 'worked').length >= 2);
    // a sub-agent's desktop step clears it for the chat's native root
    const sub = new NativeCodexLifecycle({
      call: async () => ({}),
      isNativeThread: (id: string) => id === 'root',
      onSkyProblem: (_t: string, p: any) => na.noteSkyProblem(p),
    });
    const child = 'root/sub-1';
    sub.adopt(child, 'root');
    sub.observe({
      method: 'item/completed',
      params: {
        threadId: child,
        turnId: 'v',
        item: {
          id: 'k',
          type: 'mcpToolCall',
          server: 'cua_repl',
          tool: 'js',
          status: 'completed',
          arguments: { code: 'await sky.screenshot()' },
          result: { content: [] },
        },
      },
    });
    assert.equal(codexRow(), 'native');
  });

  test('CM-H16: Claude in Chrome and the ChatGPT extension are found in Chromium browsers other than Google Chrome', () => {
    const SUPPORT = `${HOME}/Library/Application Support`;
    const host = (bin: string, id: string) => JSON.stringify({ path: bin, allowed_origins: [`chrome-extension://${id}/`] });
    /** One browser's folder: the hosts it has registered and the extensions on (state 1) or off (state 0) in its Default profile. */
    const browser = (dir: string, o: { hosts?: [string, string, string][]; exts?: [string, number][] }) => {
      const root = `${SUPPORT}/${dir}`;
      const files: Record<string, string> = {};
      for (const [name, bin, id] of o.hosts ?? []) files[`${root}/NativeMessagingHosts/${name}.json`] = host(bin, id);
      const settings: Record<string, unknown> = {};
      for (const [id, state] of o.exts ?? []) {
        files[`${root}/Default/Extensions/${id}/1/manifest.json`] = '{}';
        settings[id] = { state };
      }
      if (o.exts) files[`${root}/Default/Preferences`] = JSON.stringify({ extensions: { settings } });
      return files;
    };
    const CLAUDE_HOST: [string, string, string] = ['com.anthropic.claude_code_browser_extension', '/bin/claude', CLAUDE_EXT];
    const OPENAI_HOST: [string, string, string] = ['com.openai.codexextension', '/bin/oai', OPENAI_EXT];
    const bins = { '/bin/claude': '', '/bin/oai': '' };
    // Edge with Claude in Chrome, Chrome Beta with the ChatGPT extension: both ready, Google Chrome absent
    const edgeAndBeta = probe({
      ...bins,
      ...browser('Microsoft Edge', { hosts: [CLAUDE_HOST], exts: [[CLAUDE_EXT, 1]] }),
      ...browser('Google/Chrome Beta', { hosts: [OPENAI_HOST], exts: [[OPENAI_EXT, 1]] }),
    });
    assert.equal(edgeAndBeta.claude.chrome.ready, true);
    assert.equal(edgeAndBeta.codex.chrome.ready, true);
    // Arc, Brave, Canary, Chromium, Vivaldi, Edge Dev: each browser's own folder counts
    for (const dir of ['Arc/User Data', 'BraveSoftware/Brave-Browser', 'Google/Chrome Canary', 'Chromium', 'Vivaldi', 'Microsoft Edge Dev'])
      assert.equal(probe({ ...bins, ...browser(dir, { hosts: [CLAUDE_HOST], exts: [[CLAUDE_EXT, 1]] }) }).claude.chrome.ready, true, dir);
    // a host registered in one browser and the extension in another: neither browser can connect
    const split = probe({
      ...bins,
      ...browser('Microsoft Edge', { hosts: [CLAUDE_HOST] }),
      ...browser('Google/Chrome', { exts: [[CLAUDE_EXT, 1]] }),
    });
    assert.deepEqual(split.claude.chrome, { host: true, extension: false, enabled: false, ready: false });
    // off in Chrome, on in Brave: ready; off everywhere: installed but off (the row says turn it on)
    const offInChrome = {
      ...bins,
      ...browser('Google/Chrome', { hosts: [CLAUDE_HOST], exts: [[CLAUDE_EXT, 0]] }),
      ...browser('BraveSoftware/Brave-Browser', { hosts: [CLAUDE_HOST], exts: [[CLAUDE_EXT, 1]] }),
    };
    assert.equal(probe(offInChrome).claude.chrome.ready, true);
    const offEverywhere = probe({
      ...offInChrome,
      ...browser('BraveSoftware/Brave-Browser', { hosts: [CLAUDE_HOST], exts: [[CLAUDE_EXT, 0]] }),
    });
    assert.deepEqual(offEverywhere.claude.chrome, { host: true, extension: true, enabled: false, ready: false });
    // the one list every reader uses: Google Chrome first, each platform's folders
    const { CHROMIUM_BROWSERS, chromiumUserDataDirs } = require('../electron/capabilities/browser/chromiumBrowsers.cjs');
    const { chromeUserData, usedClaudeInChrome } = require('../electron/capabilities/browser/chromeMigration.cjs');
    assert.equal(CHROMIUM_BROWSERS[0].id, 'chrome');
    const mac = chromiumUserDataDirs({ home: HOME, platform: 'darwin' });
    assert.equal(mac.length, CHROMIUM_BROWSERS.length);
    assert.equal(mac[0].dir, `${SUPPORT}/Google/Chrome`);
    assert.equal(chromeUserData({ home: HOME, platform: 'darwin' }), `${SUPPORT}/Google/Chrome`);
    const win = chromiumUserDataDirs({ home: '/w', platform: 'win32', env: { LOCALAPPDATA: '/L' } });
    assert.ok(win.some((b: any) => b.dir === '/L/Microsoft/Edge/User Data'));
    assert.ok(!win.some((b: any) => b.id === 'arc'), 'no Arc folder on Windows here');
    assert.equal(chromeUserData({ home: '/w', platform: 'win32', env: {} }), '/w/AppData/Local/Google/Chrome/User Data');
    const linux = chromiumUserDataDirs({ home: HOME, platform: 'linux' });
    assert.ok(linux.some((b: any) => b.dir === `${HOME}/.config/BraveSoftware/Brave-Browser`));
    assert.ok(!linux.some((b: any) => b.id === 'chrome-canary'), 'no Canary on Linux');
    assert.equal(chromeUserData({ home: HOME, platform: 'linux' }), `${HOME}/.config/google-chrome`);
    // the Claude in Chrome migration note finds its host in Edge too
    const used = (files: Record<string, string>) => usedClaudeInChrome({ home: HOME, platform: 'darwin', fs: fakeFs(files) });
    assert.equal(used(browser('Microsoft Edge', { hosts: [CLAUDE_HOST] })), true);
    assert.equal(used(browser('Microsoft Edge', { hosts: [OPENAI_HOST] })), false);
  });

  test("CM-H17: a request MoPilot's helper answers while Accessibility reads off reads the permissions again, so a grant made meanwhile clears the stale report", async () => {
    let clock = 0;
    const helper = new ComputerHelper({ appPath: '/A', platform: 'darwin', exists: () => true, now: () => clock, recheckMs: 1000 });
    const sent: string[] = [];
    let granted = { accessibility: false, screenRecording: true };
    let statusFails = false;
    // a running helper answering each request on the next tick
    helper.socket = {
      write(line: string) {
        const m = JSON.parse(line);
        sent.push(m.method);
        queueMicrotask(() => {
          const p = helper.pending.get(m.id);
          helper.pending.delete(m.id);
          if (m.method === 'permissions.status' && statusFails) p.reject(new Error('gone'));
          else p.resolve(m.method === 'permissions.status' ? { ...granted } : { ok: true });
        });
      },
      end() {},
    };
    const states: number[] = [];
    helper.on('state', () => states.push(clock));
    const tick = () => new Promise((r) => setImmediate(r));
    // nothing reported yet, every required permission on, or only Screen Recording off (a running helper never
    // sees that grant; a new one reads it): no extra read
    await helper.call('input.click', {});
    helper.permissions = { accessibility: true, screenRecording: true, inputMonitoring: false };
    await helper.call('input.click', {});
    helper.permissions = { accessibility: true, screenRecording: false };
    await helper.call('input.click', {});
    assert.deepEqual(sent, ['input.click', 'input.click', 'input.click']);
    // a permission read itself never triggers another one
    helper.permissions = { accessibility: false, screenRecording: true };
    await helper.call('permissions.status');
    assert.deepEqual(sent, ['input.click', 'input.click', 'input.click', 'permissions.status']);
    // the helper reported Accessibility off; the user granted it while it runs; a request works
    sent.length = 0;
    granted = { accessibility: true, screenRecording: true };
    await helper.call('screenshot', {});
    await tick();
    assert.deepEqual(sent, ['screenshot', 'permissions.status']);
    assert.deepEqual(helper.permissions, { accessibility: true, screenRecording: true });
    assert.equal(states.length, 1, 'the health record hears of it');
    // still off: read again at most every recheckMs, and a failed read is only noted
    helper.permissions = { accessibility: false, screenRecording: true };
    granted = { accessibility: false, screenRecording: true };
    sent.length = 0;
    await helper.call('input.click', {});
    assert.deepEqual(sent, ['input.click']);
    clock = 1000;
    statusFails = true;
    await helper.call('input.click', {});
    await tick();
    assert.deepEqual(sent, ['input.click', 'input.click', 'permissions.status']);
    assert.deepEqual(helper.permissions, { accessibility: false, screenRecording: true });
  });
});
