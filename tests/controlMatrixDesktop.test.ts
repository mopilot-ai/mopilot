// Control matrix, computer use on MoPilot's helper (docs/control-plane/matrix.md, group D): an element_index acts
// only on the element its screenshot listed, Claude reads refusals under the tool names it has, the screen-reading
// consent card, what goes to another vendor's vision model, the display a screenshot shows, the screen staged before
// an action, and picking a display. The desktop_* and desktop_app_* tools, the vision fallback and Claude's channel
// are real; the helper, the cards and the harnesses are fakes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import * as DK from './support/desktop-kit.ts';
import * as AK from './support/app-scoped-kit.ts';
import { fakeSdk, z } from './support/control-matrix-kit.ts';

export const GUARDS = ['electron/capabilities/', 'native/helper/'];

const require = createRequire(import.meta.url);
const P = require('../electron/capabilities/contract/desktopPolicy.cjs');
const { Registry } = require('../electron/capabilities/contract/registry.cjs');
const { sdkMcpServers } = require('../electron/capabilities/mcp/sdkMcp.cjs');
const { placement, VERBATIM_RESULTS } = require('../electron/capabilities/contract/hostServers.cjs');
const { VisionFallback } = require('../electron/capabilities/vision/index.cjs');
const { ComputerUse } = require('../electron/capabilities/tools/computer.cjs');
const { SPECS: DESKTOP_SPECS } = require('../electron/capabilities/tools/desktopSpecs.cjs');
const { SPECS: APP_SPECS } = require('../electron/capabilities/tools/appScopedSpecs.cjs');
const { BROWSER_TOOL_NAMES } = require('../electron/capabilities/browser/hostTools.cjs');

const ROOT = new URL('../', import.meta.url);
const read = (p: string) => fs.readFileSync(new URL(p, ROOT), 'utf8');
const helperFailure = (reason: string, message = reason) => Object.assign(new Error(message), { reason });
const OTHER = { source: 'mopilot', vendor: 'MoPilot', model: 'vision-1', crossVendor: true };

/* -- an element_index acts on the element its screenshot listed ---------------------------------------------- */

test('CM-D01: a desktop element_index sends what the screenshot showed of the element, and a stale one is refused, not clicked at its old center', async () => {
  const r = DK.rig();
  await r.ready([DK.NOTES]);
  await r.call('desktop_left_click', { element_index: 1 });
  assert.deepEqual(r.callsOf('axPress')[0].args, [
    7,
    '0.0',
    { bundleIds: ['com.apple.Notes'], expectElement: { role: 'AXButton', title: 'Send' } },
  ]);
  for (const reason of ['element_changed', 'element_gone']) {
    r.helper.fail.axPress = helperFailure(
      reason,
      'element 0.0 is now AXButton "Delete", not the element in the screenshot; take a new screenshot',
    );
    const before = r.callsOf('click').length;
    await DK.rejects(
      r.call('desktop_left_click', { element_index: 1 }),
      'changed',
      /The element changed since the latest screenshot \(element 0\.0 is now AXButton "Delete", not the element in the screenshot\), so nothing was done\. Take a new desktop_screenshot/,
    );
    assert.equal(r.callsOf('click').length, before, `${reason}: no pointer click at the old center`);
  }
  // typing into a field that is now another field: refused before a key is typed
  r.helper.fail.axFocus = helperFailure('element_changed', 'element 0.1 is now AXSearchField "Search"; take a new screenshot');
  await DK.rejects(r.call('desktop_type', { element_index: 2, text: 'hi' }), 'changed', /AXSearchField "Search"/);
  assert.equal(r.callsOf('type').length, 0);
  assert.deepEqual(r.callsOf('axFocus')[0].args[2].expectElement, { role: 'AXTextField' });
  // the identity leaves out the value (it changes as the user types) and keeps the title as the snapshot gave it (the
  // helper already cut it to 200 characters, and cuts the live one the same way; a second cut in UTF-16 units would
  // disagree on emoji)
  const long = `${'x'.repeat(198)}🙂🙂`;
  assert.deepEqual(P.identityOf({ role: 'AXTextField', title: long, description: '', value: 'typed' }), {
    role: 'AXTextField',
    title: long,
  });
  assert.deepEqual(P.identityOf({ role: 7 }), { role: '' });
  // an absent title or description is the same as an empty one, on either side
  assert.equal(P.sameIdentity({ role: 'AXButton' }, { role: 'AXButton', title: '', description: '' }), true);
  assert.equal(
    P.sameIdentity({ role: 'AXButton', title: 'a', description: 'b' }, { role: 'AXButton', title: 'a', description: 'b' }),
    true,
  );
  assert.equal(P.sameIdentity({ role: 'AXButton', title: 'a' }, { role: 'AXButton' }), false);
});

test('CM-D02: a desktop_app_* element request carries what the screenshot showed, and the helper refusing a changed element reads as changed', async () => {
  const r = AK.rig();
  await r.shoot();
  await r.call('desktop_app_click', { app: 'Notes', element_index: 1 });
  assert.deepEqual(r.last('app.press').expectElement, { role: 'AXButton', title: 'Send' });
  await r.call('desktop_app_type', { app: 'Notes', element_index: 2, text: 'x' });
  assert.deepEqual(r.last('app.setText').expectElement, { role: 'AXTextArea' });
  await r.call('desktop_app_key', { app: 'Notes', element_index: 2, combo: 'delete' });
  assert.deepEqual(r.last('app.key').expectElement, { role: 'AXTextArea' });
  await r.call('desktop_app_scroll', { app: 'Notes', element_index: 2, dy: 3 });
  assert.deepEqual(r.last('app.scroll').expectElement, { role: 'AXTextArea' });
  await r.call('desktop_app_focus', { app: 'Notes', element_index: 2 });
  assert.deepEqual(r.last('app.focus').expectElement, { role: 'AXTextArea' });
  r.helper.fail['app.press'] = helperFailure(
    'element_changed',
    'element 0.0 is now AXButton "Delete", not the element in the screenshot; take a new screenshot',
  );
  await AK.rejects(r.call('desktop_app_click', { app: 'Notes', element_index: 1 }), 'changed', /is now AXButton "Delete"/);
});

test('CM-D03: in a desktop_batch, an element_index after an action is read again: the same element at its new place, or the batch stops', async () => {
  const r = DK.rig();
  await r.ready([DK.NOTES]);
  // the first click moved the Send button
  const moved = DK.snapshot();
  moved.root.children[0].frame = { x: 300, y: 100, w: 40, h: 20 };
  r.helper.snap = moved;
  await r.call('desktop_batch', {
    actions: [
      { action: 'left_click', coordinate: [10, 10] },
      { action: 'double_click', element_index: 1 },
    ],
  });
  assert.deepEqual(r.callsOf('axSnapshot')[0].args[0], { pid: 7, bundleIds: ['com.apple.Notes'] });
  assert.deepEqual(r.callsOf('click')[1].args.slice(0, 2), [320, 110], 'the double click lands where the button is now');
  // an element_index before any action uses the screenshot as it is
  r.helper.snap = DK.snapshot();
  await r.ready([DK.NOTES]);
  await r.call('desktop_batch', { actions: [{ action: 'double_click', element_index: 1 }] });
  assert.equal(r.callsOf('axSnapshot').length, 1, 'only the closing screenshot reads the tree');
  // the path now names another control, or nothing, or a control with no size: the batch stops before acting
  for (const [node, why] of [
    [{ id: '0.0', role: 'AXButton', title: 'Delete', frame: { x: 200, y: 100, w: 40, h: 20 } }, /it is now Button "Delete"/],
    [{ id: '0.0', role: 'AXButton', frame: { x: 200, y: 100, w: 40, h: 20 } }, /it is now Button\)/],
    [{ id: '0.0', frame: { x: 200, y: 100, w: 40, h: 20 } }, /it is now an element\)/],
    [{ id: '0.0', role: 'AXButton', title: 'Send', frame: { x: 200, y: 100, w: 0, h: 20 } }, /it is gone or has no size/],
    [{ id: '0.9', role: 'AXButton' }, /it is gone or has no size/],
  ] as const) {
    r.helper.snap = DK.snapshot();
    await r.ready([DK.NOTES]);
    r.helper.snap = { root: { id: '0', role: 'AXApplication', children: [null, node] } };
    const out = await r.call('desktop_batch', {
      actions: [
        { action: 'key', text: 'Tab' },
        { action: 'left_click', element_index: 1 },
      ],
    });
    const summary = JSON.parse(out[0].text);
    assert.equal(summary.stoppedAt, 1);
    assert.match(summary.results[1].reason, /^Element \[1\] changed after actions\[0\] \(/);
    assert.match(summary.results[1].reason, why);
    assert.equal(r.callsOf('axPress').length, 0, 'nothing was pressed');
  }
  // reading the tree again fails for a missing permission: the permission guide, as for any helper call
  r.helper.snap = DK.snapshot();
  await r.ready([DK.NOTES]);
  r.helper.fail.axSnapshot = helperFailure('permission_denied', 'accessibility permission not granted');
  await DK.rejects(
    r.call('desktop_batch', {
      actions: [
        { action: 'key', text: 'Tab' },
        { action: 'left_click', element_index: 1 },
      ],
    }),
    'permission',
  );
});

test('CM-D04: the expectElement contract: main sends the fields the helper compares, and every element request of the helper checks them', () => {
  const swift = read('native/helper/Sources/HelperCore/Elements.swift');
  const body = swift.slice(swift.indexOf('public func elementMismatch'));
  const compared = [...body.slice(0, body.indexOf('\n}\n')).matchAll(/expected\["(\w+)"\]/g)].map((m) => m[1]).sort();
  assert.deepEqual(Object.keys(P.identityOf({ role: 'AXButton', title: 't', description: 'd', value: 'v', help: 'h' })).sort(), compared);
  // the desktop tools' ax.press and ax.focus, and every app.* request that names an element by id
  const helper = read('native/helper/Sources/ComputerUseHelper/Helper.swift');
  const press = helper.slice(helper.indexOf('case "ax.press", "ax.focus":'));
  assert.match(press.slice(0, press.indexOf('case "input.key"')), /elementMismatch\(params\["expectElement"\]/);
  const apps = read('native/helper/Sources/ComputerUseHelper/AppScoped.swift');
  const target = apps.slice(apps.indexOf('private func targetElement'));
  assert.match(target.slice(0, target.indexOf('\n    }\n')), /elementMismatch\(params\["expectElement"\]/);
  // and main sends it under that name
  assert.match(read('electron/capabilities/tools/desktopActions.cjs'), /expectElement: el\.expect/);
  assert.match(read('electron/capabilities/tools/appScopedActions.cjs'), /expectElement: el\.expect/);
});

/* -- Claude reads refusals under the names it has ------------------------------------------------------------ */

/** The Registry's computer-use and in-app browser tools as Claude's servers present them, each answering `answer(name)`. */
function claudeServers(answer: (name: string) => { text: string; error?: boolean }) {
  const reg = new Registry();
  const names = [...DESKTOP_SPECS.map((s: any) => s.name), ...APP_SPECS.map((s: any) => s.name), ...BROWSER_TOOL_NAMES, 'peer_note'];
  for (const name of names)
    reg.register({
      name,
      description: name,
      inputSchema: { type: 'object' },
      policy: 'observe',
      authorizesItself: true,
      handler: async () => {
        const a = answer(name);
        if (a.error) throw new Error(a.text);
        return a.text;
      },
    });
  const servers = sdkMcpServers({
    sdk: fakeSdk,
    z,
    registry: reg,
    serverName: 'sage_aaaaaaaaaaaa',
    owner: { chatId: 'c1', segmentId: 's1' },
  });
  const call = async (registryName: string) => {
    const p = placement(registryName, 'sage_aaaaaaaaaaaa');
    const t = servers.get(p.server).tools.find((x: any) => x.name === p.name);
    return t.handler({}, { _meta: { 'claudecode/toolUseId': `toolu_${registryName}` } });
  };
  return { names, call };
}

test('CM-D05: Claude reads a desktop or browser refusal under the tool names it can call (request_access, not desktop_request_access)', async () => {
  const { call } = claudeServers((name) =>
    name === 'desktop_left_click'
      ? { text: 'No apps are granted in this chat yet: call desktop_request_access first', error: true }
      : name === 'browser_find'
        ? { text: 'Take a browser_read_page first; then call desktop_app_screenshot', error: true }
        : { text: `ok; next desktop_screenshot or browser_navigate` },
  );
  const refused = await call('desktop_left_click');
  assert.equal(refused.isError, true);
  assert.deepEqual(refused.content, [{ type: 'text', text: 'No apps are granted in this chat yet: call request_access first' }]);
  // on another host server a tool keeps its full name; images stay as they are
  assert.deepEqual((await call('browser_find')).content, [
    { type: 'text', text: 'Take a read_page first; then call mcp__mopilot_computer__app_screenshot' },
  ]);
  assert.deepEqual((await call('peer_note')).content, [
    { type: 'text', text: 'ok; next mcp__mopilot_computer__screenshot or mcp__mopilot_browser__navigate' },
  ]);
  // the user's own text (the clipboard, a page) goes as it is
  assert.deepEqual((await call('desktop_read_clipboard')).content, [
    { type: 'text', text: 'ok; next desktop_screenshot or browser_navigate' },
  ]);
});

test("CM-D06: every result text from Claude's servers names hosted tools as presented; every desktop_* name the computer-use tools mention is a real tool", async () => {
  // the channel: whatever a tool says about any other tool reaches Claude under the presented name
  const { names, call } = claudeServers(() => ({ text: `see ${names.join(', ')}` }));
  // (browser_batch and browser_script keep their names on mopilot_browser)
  const hosted = names.filter((n) => {
    const p = placement(n, 'sage_aaaaaaaaaaaa');
    return p.server !== 'sage_aaaaaaaaaaaa' && p.name !== n;
  });
  for (const name of [...hosted, 'peer_note'].filter((n) => !VERBATIM_RESULTS.has(n))) {
    const text = (await call(name)).content.map((c: any) => c.text).join('\n');
    const left = hosted.filter((h) => new RegExp(`(?<![\\w])${h}(?![\\w])`).test(text));
    assert.deepEqual(left, [], `${name}: Registry names left in its result`);
  }
  // the tools whose results go verbatim exist
  for (const name of VERBATIM_RESULTS) assert.ok(names.includes(name), `${name} is a hosted tool`);
  // the sources: a tool name the computer-use tools tell the model about must exist, or the rewrite can't map it
  const { SCRIPT_TOOL_NAMES } = require('../electron/capabilities/tools/appScopedScript.cjs');
  const real = new Set([...DESKTOP_SPECS.map((s: any) => s.name), ...APP_SPECS.map((s: any) => s.name), ...SCRIPT_TOOL_NAMES]);
  // card labels (never text for the model) and the desktop_app_* family named as a whole
  const notTools = new Set(['desktop_input', 'desktop_app_input', 'desktop_app_']);
  const dir = 'electron/capabilities/tools/';
  const files = fs.readdirSync(new URL(dir, ROOT)).filter((f) => /^(desktop|appScoped|computer).*\.cjs$/.test(f));
  assert.ok(files.length > 10);
  for (const f of files)
    for (const m of read(dir + f).matchAll(/\bdesktop_[a-z_]+/g))
      assert.ok(real.has(m[0]) || notTools.has(m[0]), `${f}: ${m[0]} is not a desktop tool`);
});

/* -- the screen-reading consent card --------------------------------------------------------------------------- */

function visionRig(answer: () => any) {
  const r = DK.rig({
    hide: true,
    host: {
      hide: () => true,
      show() {
        shown.push(true);
      },
    },
  });
  const shown: boolean[] = [];
  r.helper.call = async (method: string, ...args: any[]) => (
    r.helper.calls.push({ method, args }), method === 'ocr.elements' ? [] : { ok: true }
  );
  const asked: any[] = [];
  const v = new VisionFallback({
    backendFor: () => OTHER,
    read: async () => 'A Notes window',
    broker: { ask: async (_c: string, kind: string) => (asked.push(kind), answer()) },
  });
  r.cu.vision = v;
  r.cu.plan = (chatId: string) => v.plan(chatId, 'text');
  return { r, v, asked, shown };
}

test('CM-D07: the screen-reading card: unanswered is not a refusal, a refusal lasts until the turn ends, and nobody there means no card', async () => {
  // swept unanswered (the turn ended, the harness stopped): asked again next time
  const swept = visionRig(() => null);
  await swept.r.ready([DK.NOTES]);
  swept.asked.length = 0;
  assert.match(
    (await swept.r.call('desktop_screenshot'))[0].text,
    /The card asking to send screenshots to MoPilot went away unanswered \(it is asked again next time\)/,
  );
  await swept.r.call('desktop_screenshot');
  assert.equal(swept.asked.length, 2);
  // refused (Esc or Deny): not asked again in the turn; the next turn may ask
  const refused = visionRig(() => ({ decision: 'deny' }));
  await refused.r.ready([DK.NOTES]);
  await refused.r.call('desktop_screenshot');
  assert.equal(refused.asked.length, 1);
  refused.v.turnEnded('c1');
  refused.v.turnEnded('other');
  await refused.r.call('desktop_screenshot');
  assert.equal(refused.asked.length, 2);
  // allowed for the chat survives the turn's end
  const chat = visionRig(() => ({ decision: 'allow', scope: 'chat' }));
  await chat.r.ready([DK.NOTES]);
  chat.v.turnEnded('c1');
  assert.match((await chat.r.call('desktop_screenshot'))[0].text, /What vision-1 sees:/);
  assert.equal(chat.asked.length, 1);
  // a scheduled run with nobody at the Mac: no card waits for an answer that never comes
  const away = visionRig(() => ({ decision: 'allow' }));
  await away.r.ready([DK.NOTES]);
  away.asked.length = 0;
  away.r.state.unattended = 'a scheduled run';
  assert.match(
    (await away.r.call('desktop_screenshot'))[0].text,
    /Nobody is here to allow sending screenshots to MoPilot \(a scheduled run\)/,
  );
  assert.equal(away.asked.length, 0);
});

test("CM-D08: with hide-before-action, MoPilot's windows come back before the screen-reading card and the desktop_app_* confirmation", async () => {
  const v = visionRig(() => ({ decision: 'allow', scope: 'once' }));
  await v.r.ready([DK.NOTES]);
  v.r.d.session('c1').consent = true;
  await v.r.call('desktop_left_click', { coordinate: [10, 10] });
  assert.equal(v.r.d.screen.hostHidden, true);
  await v.r.call('desktop_screenshot');
  assert.deepEqual(v.shown, [true], 'shown before the vision card');
  // the background tools' confirmation card
  const a = AK.rig();
  let revealed = 0;
  a.desktop.revealHost = () => void revealed++;
  await a.shoot();
  await a.call('desktop_app_click', { app: 'Notes', element_index: 1, irreversible: true });
  assert.deepEqual(
    a.asks.map((x: any) => x.kind),
    ['computerConfirm'],
  );
  assert.equal(revealed, 1);
});

/* -- what goes to another vendor's vision model ---------------------------------------------------------------- */

function computerUse(front: any) {
  const shots: any[] = [];
  const helper: any = {
    running: true,
    start: async () => ({}),
    targetInfo: async () => front,
    glowStart: async () => {},
    glowStop: async () => {},
    screenshot: async (o: any) => (shots.push(o), { png: 'PNG', width: 100, height: 50, display: { x: 0, y: 0 }, pixelsPerPoint: 2 }),
    permissionStatus: async () => ({}),
  };
  const asked: any[] = [];
  const vision = new VisionFallback({
    backendFor: () => OTHER,
    read: async () => '{"x": 10, "y": 10}',
    broker: { ask: async (...a: any[]) => (asked.push(a), { decision: 'allow', scope: 'chat' }) },
  });
  let away: string | null = null;
  const cu = new ComputerUse({
    helper,
    vision,
    grants: { forChat: () => [{ bundleId: 'com.b', level: 'full' }], deny: () => [], grant: () => {} },
    broker: { ask: async () => ({ decision: 'allow', scope: 'once' }) },
    session: () => ({ modality: 'text' }),
    unattended: () => away,
    settleMs: 0,
    waitMs: 0,
    pollMs: 1,
  });
  cu.plan = (chatId: string) => vision.plan(chatId, 'text');
  const by = Object.fromEntries(cu.tools().map((t: any) => [t.name, t.handler]));
  return { by, shots, asked, setAway: (w: string | null) => (away = w) };
}

test('CM-D09: computer_locate and computer_describe send the vision model only the app the consent named, never the whole display', async () => {
  const c = computerUse({ bundleId: 'com.b', name: 'B', pid: 5 });
  await c.by.computer_describe({}, { chatId: 'c' });
  await c.by.computer_locate({ query: 'OK' }, { chatId: 'c' });
  assert.deepEqual(c.shots, [
    { pid: 5, bundleIds: ['com.b'] },
    { pid: 5, bundleIds: ['com.b'] },
  ]);
  assert.equal(c.asked[0][1], 'visionConsent');
  assert.deepEqual(c.asked[0][2].app, { bundleId: 'com.b', name: 'B' });
  // no app with a pid in front: nothing to send
  const none = computerUse({ bundleId: 'com.b', name: 'B' });
  await assert.rejects(none.by.computer_describe({}, { chatId: 'c' }), /No app is in front to look at/);
  assert.equal(none.shots.length, 0);
  // nobody there to answer the consent card: refused without a card
  const away = computerUse({ bundleId: 'com.b', name: 'B', pid: 5 });
  away.setAway('a scheduled run');
  await assert.rejects(
    away.by.computer_describe({}, { chatId: 'c' }),
    /Nobody is here to allow sending screenshots to MoPilot \(a scheduled run\); use computer_elements/,
  );
  assert.equal(away.asked.length, 0);
});

/* -- the display a screenshot shows, and the screen before an action ------------------------------------------ */

test('CM-D10: a screenshot follows the granted apps to their display unless one was picked, and an empty image says so instead of "Shows only"', async () => {
  const r = DK.rig();
  await r.ready([DK.NOTES]);
  r.helper.shot = (o: any) => ({
    jpeg: 'J',
    width: 10,
    height: 10,
    display: { id: 2, x: 2000, y: 0 },
    included: o.includeBundleIds,
    shown: [],
  });
  const empty = (await r.call('desktop_screenshot'))[1].text;
  assert.equal(r.callsOf('screenshot')[0].args[0].display, undefined, "the first screenshot's display does not stick");
  assert.match(empty, /No granted app has a window on this display, so the image is empty\.\n/);
  assert.doesNotMatch(empty, /Shows only/);
  // a zoom stays on the display of the latest screenshot
  await r.call('desktop_zoom', { region: [0, 0, 5, 5] });
  assert.equal(r.callsOf('screenshot')[1].args[0].display, 2);
  // a display picked with desktop_switch_display is kept
  await r.call('desktop_switch_display', { display: 2 });
  await r.call('desktop_screenshot');
  assert.equal(r.callsOf('screenshot')[2].args[0].display, 2);
});

test("CM-D11: an action refused before it runs lets go of the desktop staged for it, and other chats' background apps stay on screen", async () => {
  const r = DK.rig({ hide: true, host: { hide: () => true, show: () => {} } });
  await r.ready([DK.NOTES]);
  r.d.session('c1').consent = true;
  r.d.lockedElsewhere = (chatId: string) => (chatId === 'c1' ? ['com.apple.mail'] : []);
  // the point is on an app that isn't granted: refused, and the desktop is not held until the turn ends
  r.helper.at = DK.FINDER;
  await DK.rejects(r.call('desktop_left_click', { coordinate: [10, 10] }), 'denied', /isn't granted in this chat/);
  assert.equal(r.cu.controlling, null);
  assert.deepEqual(r.released, ['c1']);
  assert.deepEqual(r.callsOf('hideOthers')[0].args, [['com.apple.Notes', 'com.apple.mail']]);
  // the user declines the card for an action that can't be undone: let go too
  r.helper.at = DK.NOTES;
  r.answers.computerConfirm = { decision: 'deny' };
  await DK.rejects(r.call('desktop_left_click', { element_index: 1 }), 'denied', /didn't confirm/);
  assert.equal(r.cu.controlling, null);
  assert.deepEqual(r.released, ['c1', 'c1']);
  // an action that runs keeps the desktop, named for its app; a refusal after that leaves the hold as it was
  await r.call('desktop_left_click', { coordinate: [10, 10] });
  assert.equal(r.cu.controlling, 'c1');
  assert.equal(r.cu.app, 'Notes');
  r.helper.at = DK.FINDER;
  await DK.rejects(r.call('desktop_left_click', { coordinate: [10, 10] }), 'denied');
  assert.equal(r.cu.controlling, 'c1');
  assert.deepEqual(r.released, ['c1', 'c1']);
  // another chat holds the desktop: nothing is hidden for this one
  const other = DK.rig({ hide: true, host: { hide: () => true, show: () => {} } });
  await other.ready([DK.NOTES]);
  other.d.session('c1').consent = true;
  other.cu.controlling = 'c2';
  other.helper.at = DK.NOTES;
  await DK.rejects(other.call('desktop_left_click', { coordinate: [10, 10] }), 'busy', /Another chat is controlling this Mac/);
  assert.equal(other.callsOf('hideOthers').length, 0);
  assert.deepEqual(other.released, []);
});

test('CM-D12: desktop_switch_display takes the list\'s number first, so "1" is the first listed display even when another display\'s id is 1', async () => {
  const r = DK.rig();
  await r.ready([DK.NOTES]);
  r.helper.displays = [
    { id: 724, x: 0, y: 0, width: 2560, height: 1440, main: true, name: 'Studio Display' },
    { id: 1, x: 2560, y: 0, width: 1512, height: 982, name: 'Built-in Retina Display' },
  ];
  assert.match((await r.call('desktop_switch_display', { display: '1' }))[0].text, /display 1 \(Studio Display\)/);
  assert.equal(r.d.session('c1').display, 724);
  assert.match((await r.call('desktop_switch_display', { display: 2 }))[0].text, /display 2 \(Built-in Retina Display\)/);
  // not a list number: an id or a name
  assert.match((await r.call('desktop_switch_display', { display: '724' }))[0].text, /Studio Display/);
  assert.match((await r.call('desktop_switch_display', { display: 'built-in retina display' }))[0].text, /display 2/);
  await DK.rejects(r.call('desktop_switch_display', { display: '9' }), 'bad_args', /No display 9/);
  const listed = JSON.parse((await r.call('desktop_switch_display'))[0].text).displays;
  assert.deepEqual(
    listed.map((d: any) => d.current),
    [false, true],
  );
});
