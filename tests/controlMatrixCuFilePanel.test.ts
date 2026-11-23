// Control matrix, computer use on MoPilot's helper (docs/control-plane/matrix.md, group D): a Save or Open panel
// of an app in the background (#1528). desktop_app_file_panel reaches the helper the same way from a Claude Code
// session (app_file_panel on mopilot_computer), a Codex chat and an ACP chat, a stopped call sends nothing, and the
// refusals that met a Save panel in the 12-grid bench (#1381) name it instead of a dead end. The desktop_app_* tools,
// the Registry and Claude's channel are real; the helper, the cards and the harnesses are fakes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import * as AK from './support/app-scoped-kit.ts';
import { fakeSdk, z } from './support/control-matrix-kit.ts';

export const GUARDS = ['electron/capabilities/', 'native/helper/'];

const require = createRequire(import.meta.url);
const { Registry } = require('../electron/capabilities/contract/registry.cjs');
const { sdkMcpServers } = require('../electron/capabilities/mcp/sdkMcp.cjs');
const { placement } = require('../electron/capabilities/contract/hostServers.cjs');

/** The real background tools in a Registry, as main registers them, and a Claude session's servers over it. */
function world() {
  const r = AK.rig();
  r.helper.answers['app.filePanel'] = () => ({ ok: true, reached: true, location: 'Reports', route: 'ax+pid' });
  const reg = new Registry();
  for (const t of r.apps.tools()) reg.register(t);
  const servers = sdkMcpServers({
    sdk: fakeSdk,
    z,
    registry: reg,
    serverName: 'sage_aaaaaaaaaaaa',
    owner: { chatId: 'c1', segmentId: 's1' },
  });
  const claude = async (registryName: string, args: any) => {
    const p = placement(registryName, 'sage_aaaaaaaaaaaa');
    const t = servers.get(p.server).tools.find((x: any) => x.name === p.name);
    return t.handler(args, { _meta: { 'claudecode/toolUseId': `toolu_${registryName}` } });
  };
  return { r, reg, claude };
}

test('CM-D13: desktop_app_file_panel reaches the helper the same way from Claude, Codex and ACP chats; a stopped call sends nothing', async () => {
  const { r, reg, claude } = world();
  assert.deepEqual(placement('desktop_app_file_panel', 'sage_aaaaaaaaaaaa'), { server: 'mopilot_computer', name: 'app_file_panel' });
  const args = { app: 'Notes', folder: '/Users/me/Reports', file_name: 'r.txt' };
  const want = {
    pid: 7,
    bundleIds: ['com.apple.Notes'],
    windowId: undefined,
    folder: '/Users/me/Reports',
    fileName: 'r.txt',
    foreground: false,
  };
  const out = await claude('desktop_app_file_panel', args);
  assert.notEqual(out.isError, true, JSON.stringify(out));
  assert.match(out.content[0].text, /"action":"file_panel","effect":"confirmed"/);
  // Claude reads the next step under the names it has (short names on the same server)
  assert.match(
    out.content[0].text,
    /take a app_screenshot to check it, then call app_file_panel again with confirm: true \(or press .* by element_index with app_click;/,
  );
  assert.doesNotMatch(out.content[0].text, /desktop_app_/);
  assert.deepEqual(r.last('app.filePanel'), want);
  // the desktop lock: while the Claude chat works in the app, another chat's panel request is refused, not interleaved
  const busy = await reg.invoke('codex1', 's1', 'desktop_app_file_panel', args);
  assert.equal(busy.error?.code, 'busy');
  r.apps.releaseLocks('c1');
  for (const [chatId, harness] of [
    ['codex1', 'codex'],
    ['acp1', 'acp:opencode'],
  ]) {
    r.cu.harness = () => harness;
    const res = await reg.invoke(chatId, 's1', 'desktop_app_file_panel', args);
    assert.equal(res.ok, true, `${harness}: ${JSON.stringify(res.error)}`);
    assert.deepEqual(r.last('app.filePanel'), want, harness);
    r.apps.releaseLocks(chatId);
  }
  // Stop or Esc before it runs: nothing reaches the panel
  const n = r.callsOf('app.filePanel').length;
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(r.call('desktop_app_file_panel', args, { chatId: 'c1', signal: ac.signal }));
  assert.equal(r.callsOf('app.filePanel').length, n);
});

test('CM-D14: no refusal that meets a Save panel is a dead end: the pop-up, right-click and shortcut refusals name desktop_app_file_panel, on every harness', async () => {
  const { r, claude } = world();
  await r.shoot();
  // the Where pop-up (the kit's [3] is a pop-up button), seen by Claude under its own names
  const popup = await claude('desktop_app_click', { app: 'Notes', element_index: 3 });
  assert.equal(popup.isError, true);
  assert.match(popup.content[0].text, /unsupported\(menu\).*Use app_menu .* with app_file_panel\./);
  assert.doesNotMatch(popup.content[0].text, /desktop_app_/);
  r.cu.harness = () => 'codex';
  await AK.rejects(
    r.call('desktop_app_key', { app: 'Notes', element_index: 2, combo: 'cmd+shift+g' }),
    'unsupported',
    /desktop_app_file_panel/,
  );
  await AK.rejects(
    r.call('desktop_app_click', { app: 'Notes', element_index: 1, button: 'right' }),
    'unsupported',
    /desktop_app_file_panel/,
  );
  // the sources: every background refusal that sends the model to desktop_app_menu for a menu or shortcut offers the panel tool too
  const util = fs.readFileSync(new URL('../electron/capabilities/tools/appScopedUtil.cjs', import.meta.url), 'utf8');
  const actions = fs.readFileSync(new URL('../electron/capabilities/tools/appScopedActions.cjs', import.meta.url), 'utf8');
  for (const m of util.matchAll(/`unsupported\((?:menu|context_menu|use_app_menu)\)[^`]*`/g)) assert.match(m[0], /\$\{PANEL_HINT\}/, m[0]);
  assert.doesNotMatch(actions, /unsupported\((?:menu|context_menu)\)/, 'the refusals live in appScopedUtil.cjs, not in copies');
  const helper = fs.readFileSync(new URL('../native/helper/Sources/ComputerUseHelper/AppScoped.swift', import.meta.url), 'utf8');
  for (const m of helper.matchAll(/HelperError\.unsupported\("menu", "[^"]*"\)/g)) assert.match(m[0], /app_file_panel/, m[0]);
});

test('CM-D16: the panel is found wherever it is, Go to Folder raises its own window, confirm reaches the helper on every harness, and no alert is pressed (#1381 f2)', async () => {
  const { r, reg, claude } = world();
  const args = { app: 'Notes', window_id: 5, folder: '/Users/me/Reports', file_name: 'scan.txt', confirm: true };
  await r.shoot();
  const want = { windowId: 5, folder: '/Users/me/Reports', fileName: 'scan.txt', confirm: true };
  const out = await claude('desktop_app_file_panel', args);
  assert.notEqual(out.isError, true, JSON.stringify(out));
  assert.equal(r.last('app.filePanel').confirm, true);
  r.apps.releaseLocks('c1');
  for (const [chatId, harness] of [
    ['codex1', 'codex'],
    ['acp1', 'acp:opencode'],
  ]) {
    r.cu.harness = () => harness;
    const res = await reg.invoke(chatId, 's1', 'desktop_app_file_panel', args);
    assert.equal(res.ok, true, `${harness}: ${JSON.stringify(res.error)}`);
    const sent = r.last('app.filePanel');
    for (const [k, v] of Object.entries(want)) assert.deepEqual(sent[k], v, `${harness} ${k}`);
    r.apps.releaseLocks(chatId);
  }
  // the helper: a named window (even one that closed since) is only where the search starts, never the whole of it
  const src = (f: string) => fs.readFileSync(new URL(`../native/helper/Sources/ComputerUseHelper/${f}`, import.meta.url), 'utf8');
  const panel = src('FilePanel.swift');
  const body = panel.slice(panel.indexOf('func filePanel('), panel.indexOf('private func confirmPanel('));
  assert.match(body, /locatePanel\(&scope, named: whole\(params\["windowId"\]\)/);
  assert.doesNotMatch(body, /pickWindow\(/, 'pickWindow throws window_gone for a stale id and limits the search to one window');
  const locate = panel.slice(panel.indexOf('func locatePanel('), panel.indexOf('func filePanel('));
  assert.match(locate, /panelSearchOrder\(named: named, listed:/);
  assert.match(locate, /kAXWindowsAttribute/, 'windows only accessibility lists are searched too');
  // a named window still there: another window counts only as a panel of its own, never another document's sheet
  assert.match(locate, /if namedAlive, id != named, !\(role\(p\) == "AXWindow" && CFEqual\(p, root\)\) \{ continue \}/);
  // the press goes only on what was checked: the folder shown (not merely unknown), the name written, the file listed
  const confirmFn = panel.slice(panel.indexOf('private func confirmPanel('), panel.indexOf('private func promptAnswer('));
  assert.match(
    confirmFn,
    /guard so\["reached"\] as\? Bool == true, so\["selected"\] as\? Bool != false, so\["nameField"\] as\? Bool != false/,
  );
  assert.match(
    confirmFn,
    /parts\.okButton \?\? axElementAttr\(panel, kAXDefaultButtonAttribute\)/,
    "the panel's own default button, not the window's",
  );
  // Go to Folder: the foreground rung raises the panel's window, and goToFolder makes it main before the keys
  assert.match(body, /fgParams\["windowId"\] = host/);
  const goTo = panel.slice(panel.indexOf('private func goToFolder('));
  assert.ok(goTo.indexOf('kAXRaiseAction') < goTo.indexOf('press("cmd+shift+g")'));
  const beforeKey = goTo.slice(goTo.indexOf('kAXRaiseAction'), goTo.indexOf('press("cmd+shift+g")'));
  assert.match(beforeKey, /guard inFront\(\)/, 'the app is checked to be in front right before the keys');
  // alerts are reported, never answered: nothing presses inside alertOn or promptAnswer, and the pre-check runs first
  const alert = panel.slice(panel.indexOf('private func alertOn('), panel.indexOf('func poll<T>('));
  const prompt = panel.slice(panel.indexOf('private func promptAnswer('), panel.indexOf('private func goToFolder('));
  for (const s of [alert, prompt]) assert.doesNotMatch(s, /kAXPressAction|AXConfirm|press\(/);
  assert.ok(body.indexOf('alertOn(panel)') < body.indexOf('PanelParts(panel)'), 'an alert already up is reported before anything is set');
  // Finder's route goes to the folder in its own window too, through the same Go to Folder sheet identifiers
  const finder = src('FinderGoTo.swift');
  assert.match(finder, /goToSheetIdentifier/);
  assert.match(finder, /goToFieldIdentifier/);
  // Return only into the Go to Folder field; one hop at most; documents only, in an app the chat was granted
  assert.match(finder, /focused\.map\(\{ CFEqual\(\$0, sheet\.field\) \}\) == true else/);
  assert.match(finder, /hop == 0, identifier\(sheet\.window\) == goToSheetIdentifier/);
  assert.match(finder, /finderOpenRefusal\(/);
  assert.match(finder, /granted\.contains\(where:/);
  assert.match(finder, /policy\.denyList\.rule\(for: bundleId\)/);
});
