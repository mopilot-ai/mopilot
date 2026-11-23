// Codex's computer use defaults to MoPilot's helper; Codex Computer Use (Sky) is an opt-in in Settings → Computer use
// (#1381: the managed helper passed more of the 12-grid tasks and acts about 4× faster). The choice decides the surface a
// newly loaded Codex thread gets, the Codex row and the model's note, and whether Codex Computer Use is installed at all;
// Codex's native Chrome is left as it was.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  NativeAvailability,
  SKY,
  codexNativeSurfaces,
  availabilityStatus,
  codexDegradedNote,
  facts,
  live,
  row,
} from './support/native-availability/fixture.ts';
import { CAPABILITY_REASONS, capabilityReasonText } from '../shared/capabilityReasons.mjs';

const require = createRequire(import.meta.url);
const { GrantStore } = require('../electron/capabilities/grants.cjs');

test('the surfaces: computer use goes native only for someone who chose it; Chrome is untouched', () => {
  const f = facts();
  assert.deepEqual(codexNativeSurfaces(f, { enabled: true, codexNativeComputer: false }), { chrome: true, computer: false });
  assert.deepEqual(codexNativeSurfaces(f, { enabled: true, codexNativeComputer: true }), { chrome: true, computer: true });
  // callers that don't say (older live facts) keep the vendor path where it runs
  assert.deepEqual(codexNativeSurfaces(f, { enabled: true }), { chrome: true, computer: true });
  // the kill switch still wins over the choice
  assert.deepEqual(codexNativeSurfaces(f, { enabled: false, codexNativeComputer: true }), { chrome: false, computer: false });
});

test('the Codex row and the model note say Codex uses MoPilot’s computer use by choice, with no Try again', () => {
  const f = facts();
  const status = availabilityStatus(f, live({ codexNativeComputer: false }), { nativeComputer: false });
  const computer = row(status, 'codex').computer;
  assert.notEqual(computer.state, 'native');
  assert.equal(computer.reasonCode, 'native.choice');
  // the default is MoPilot's own row, not a fallback, and names no Codex Computer Use version
  assert.equal(computer.state, 'mopilot');
  assert.equal(computer.label, 'MoPilot computer use');
  assert.equal(computer.version, null);
  assert.deepEqual(computer.actions ?? [], []);
  assert.match(capabilityReasonText('native.choice'), /^Codex uses MoPilot’s computer use\. Turn on Codex Computer Use below/);
  assert.ok(CAPABILITY_REASONS['native.choice']);
  // a Codex thread loaded with Chrome native and computer use managed is told to use the desktop_* tools
  const note = codexDegradedNote(
    f,
    { chrome: true, computer: false },
    { serverName: 'sage_x', health: live().health },
    { nativeComputer: false },
  );
  assert.match(note, /unavailable here \(Codex Computer Use is off in Settings\.\); use the desktop_\* tools of the sage_x MCP server/);
  // opted in: the row is native again
  assert.equal(row(availabilityStatus(f, live({ codexNativeComputer: true }), { nativeComputer: true }), 'codex').computer.state, 'native');
});

test('NativeAvailability: the choice reaches newly loaded threads and the row; Codex Computer Use is installed only once chosen', async () => {
  const f = facts();
  const installable = {
    ...f,
    codex: { ...f.codex, sky: { present: false, path: null, version: null, bundled: '26.2', source: '/b/Sky.app', canonical: SKY } },
  };
  let chosen = false;
  const plans: any[] = [];
  const a = new NativeAvailability({
    probe: () => installable,
    live: () => ({ ...live(), claudeEligible: () => true, codexNativeComputer: chosen }),
    install: async (plan: any) => {
      plans.push(plan.action);
    },
  });
  assert.equal(a.codexSurfaces().computer, false);
  assert.equal(a.codexSurfaces().chrome, true);
  assert.equal(row(a.status(), 'codex').computer.reasonCode, 'native.choice');
  assert.match(
    a.degradedNote({ chrome: true, computer: false }, 'sage_x') ?? '',
    /Codex Computer Use is off in Settings\.\); use the desktop_\* tools/,
  );
  await a.installing;
  assert.deepEqual(plans, [], 'nothing is installed for a path chats do not take');
  // turned on in Settings: the next probe installs it
  chosen = true;
  a.refresh({ force: true });
  await a.installing;
  assert.deepEqual(plans, ['install']);
});

test('GrantStore: the choice is off by default, saved with the computer permissions, and a bad value refuses the file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cu-choice-'));
  const file = path.join(dir, 'computer.json');
  const changes: (string | null)[] = [];
  const chats = { get: () => null, patchMeta: () => true };
  const g = new GrantStore({ file, chats, onChange: (id: string | null) => changes.push(id) });
  assert.equal(g.codexNativeComputer(), false);
  assert.equal(g.setCodexNativeComputer(true), true);
  assert.deepEqual(changes, [null]);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).codexNativeComputer, true);
  assert.equal(new GrantStore({ file, chats }).codexNativeComputer(), true);
  assert.equal(g.setCodexNativeComputer(false), false);
  // a non-boolean is not a choice: the store reads as unreadable rather than guessing
  fs.writeFileSync(file, JSON.stringify({ codexNativeComputer: 'yes' }));
  const bad = new GrantStore({ file, chats });
  assert.equal(bad.codexNativeComputer(), false);
  assert.ok(bad.writeError);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('wiring: Settings saves through main, which re-probes and tells the windows; the Codex thread reads the store', () => {
  const read = (f: string) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
  const tools = read('electron/app/agentTools.cjs');
  assert.match(tools, /codexNativeComputer: computerUse\?\.grants\.codexNativeComputer\(\) === true/);
  const handler = tools.slice(tools.indexOf("ipcMain.handle('computer:setCodexNativeComputer'"));
  assert.match(
    handler.slice(0, 400),
    /setCodexNativeComputer\(on === true\)[\s\S]*nativeAvailability\.refresh\(\{ force: true \}\);[\s\S]*nativeAvailability\.onChange\(\);/,
  );
  assert.match(read('electron/bridge/computer.cjs'), /setCodexNativeComputer: invoke\('computer:setCodexNativeComputer', 1\)/);
  assert.match(read('electron/capabilities/computerUse.cjs'), /\.\.\.grants\.settings\(\),/);
});

test('a thread keeping the plugin’s Chrome but not its computer use gets cua_repl without the computer surface (not chosen, or Sky down)', () => {
  const {
    cuaWithoutComputer,
    routedSurfaces,
    CUA_SERVER,
    CHROME_PLUGIN,
  } = require('../electron/capabilities/channels/codexPluginChrome.cjs');
  const { nativeThreadConfig, codexThreadConfig } = require('../electron/capabilities/channels/codexThreadContracts.cjs');
  const server = {
    command: '/p/node',
    args: ['cua.js'],
    env: { CUA_REPL_ENABLED_SURFACES: 'computer, browser', BROWSER_USE_AVAILABLE_BACKENDS: 'chrome,iab' },
    description: 'not a config field',
  };
  const narrowed = cuaWithoutComputer(server);
  assert.deepEqual(narrowed, {
    command: '/p/node',
    args: ['cua.js'],
    enabled: true,
    env: { CUA_REPL_ENABLED_SURFACES: 'browser', BROWSER_USE_AVAILABLE_BACKENDS: 'chrome,iab' },
  });
  // a definition without the list enables every surface: it is narrowed to the browser
  assert.equal(cuaWithoutComputer({ command: '/p/node', env: {} }).env.CUA_REPL_ENABLED_SURFACES, 'browser');
  for (const bad of [null, undefined, {}, { command: 1, env: {} }, { command: '/p/node' }]) assert.equal(cuaWithoutComputer(bad), null);
  // routing: Chrome served by MoPilot wins (the plugin's Chrome goes); otherwise a Chrome-only thread loses computer use
  const chromeOff = () => ({ off: 'chrome' });
  const computerOff = () => narrowed;
  assert.deepEqual(
    routedSurfaces({ chrome: true, computer: false }, () => null, computerOff),
    {
      surfaces: { chrome: true, computer: false },
      cua: narrowed,
    },
  );
  assert.deepEqual(routedSurfaces({ chrome: true, computer: false }, chromeOff, computerOff).cua, { off: 'chrome' });
  assert.equal(routedSurfaces({ chrome: true, computer: true }, () => null, computerOff).cua, null);
  assert.equal(routedSurfaces({ chrome: false, computer: false }, chromeOff, computerOff).cua, null);
  assert.equal(routedSurfaces({ chrome: true, computer: false }, () => null).cua, null, 'no computerOff: nothing narrowed');
  // the config: the narrowed cua_repl replaces the plugin's, and the Chrome plugin stays on; a Chrome-off cua turns it off
  const kept = nativeThreadConfig({ cua: narrowed, chrome: true });
  assert.deepEqual(kept.mcp_servers[CUA_SERVER], narrowed);
  assert.equal(kept.plugins[CHROME_PLUGIN], undefined);
  assert.equal(nativeThreadConfig({ cua: { command: 'x' }, chrome: false }).plugins[CHROME_PLUGIN].enabled, false);
  const withTools = codexThreadConfig({
    serverName: 's',
    command: 'c',
    socketPath: '/s',
    token: 't',
    native: true,
    cua: narrowed,
    chrome: true,
  });
  assert.deepEqual(withTools.mcp_servers[CUA_SERVER], narrowed);
  assert.equal(withTools.plugins?.[CHROME_PLUGIN], undefined);
});

test('a Codex thread starting with the vendor’s Chrome and MoPilot’s computer use loads the narrowed cua_repl, with and without sage-mcp', () => {
  const { CodexToolInjection } = require('../electron/capabilities/channels/codexConfig.cjs');
  const { ToolSessions } = require('../electron/capabilities/contract/session.cjs');
  const { cuaWithoutComputer, CHROME_PLUGIN } = require('../electron/capabilities/channels/codexPluginChrome.cjs');
  const narrowed = cuaWithoutComputer({ command: '/p/node', env: { CUA_REPL_ENABLED_SURFACES: 'computer,browser' } });
  const start = (hasTools: boolean) => {
    const hides: any[] = [];
    const inj = new CodexToolInjection({
      sessions: new ToolSessions(),
      command: '/bin/sage-mcp',
      socketPath: '/tmp/s.sock',
      harnessPid: () => 1,
      hasTools: () => hasTools,
      nativeEnabled: () => true,
      nativeSurfaces: () => ({ chrome: true, computer: false }),
      nativeHideFor: (surfaces: any) => (hides.push(surfaces), () => false),
      computerOff: () => narrowed,
    });
    const sent = inj.outgoing({ id: 1, method: 'thread/start', params: {} });
    return { config: sent.params.config, hides };
  };
  for (const hasTools of [true, false]) {
    const { config, hides } = start(hasTools);
    assert.deepEqual(config.mcp_servers.cua_repl, narrowed, String(hasTools));
    assert.equal(config.mcp_servers.cua_repl.env.CUA_REPL_ENABLED_SURFACES, 'browser');
    assert.equal(config.plugins?.[CHROME_PLUGIN], undefined, "the vendor's Chrome stays");
    assert.equal(config.plugins['unified-computer-use@openai-bundled'].enabled, true);
    if (hasTools) assert.deepEqual(hides, [{ chrome: true, computer: false }], 'the desktop_* tools stay visible');
  }
  // main wires it from the plugin's own definition
  const tools = fs.readFileSync(new URL('../electron/app/agentTools.cjs', import.meta.url), 'utf8');
  assert.match(tools, /computerOff: \(\) => cuaWithoutComputer\(cuaServer\(\)\)/);
});
