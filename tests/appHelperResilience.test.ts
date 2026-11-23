// The background desktop_app_* tools (electron/capabilities/tools/appScoped.cjs) over the real helper
// client (computer.cjs) and a scripted helper socket: a helper that crashed between calls is relaunched
// by the next tool call, a helper that dies during an input action yields "restarted, look again"
// instead of a replay, and desktop_app_menu refreshes the top-level menu (app.menuRefresh) before it
// resolves an item, telling a disabled item apart from a missing one. Shared by every harness: Claude
// Code (mopilot_computer app_*), Codex and ACP sessions call these same handlers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { scriptedHelper, type Reply } from './helpers/scriptedHelper.ts';

const require = createRequire(import.meta.url);
const { sessionAnchorOf } = require('../electron/capabilities/anchor.cjs');
const { AppScopedControl, SPECS, isMenuDisabled, menuDisabledError } = require('../electron/capabilities/tools/appScoped.cjs');
const { DesktopControl } = require('../electron/capabilities/tools/desktop.cjs');
const { ComputerHelper } = require('../electron/capabilities/computer.cjs');
const { ComputerPermissions } = require('../electron/capabilities/tools/computerPermissions.cjs');
const { ToolError } = require('../electron/capabilities/contract/registry.cjs');

const TEXTEDIT = { pid: 77, bundleId: 'com.apple.TextEdit', name: 'TextEdit' };
const WIN = { window_id: 5, title: 'Untitled', state: 'visible', is_main: true, bounds: { x: 0, y: 0, width: 400, height: 300 } };
const TREE = {
  root: {
    id: '0',
    role: 'AXWindow',
    children: [{ id: '0.0', role: 'AXButton', title: 'Close', frame: { x: 10, y: 10, w: 20, h: 20 }, actions: ['AXPress'] }],
  },
};

/** Answers the requests the tools send; `over` replaces an answer per method (n: how many times it was asked). */
function answers(over: Record<string, (p: any, n: number) => Reply> = {}) {
  return (method: string, params: any, n: number): Reply => {
    if (over[method]) return over[method](params, n);
    switch (method) {
      case 'apps.list':
        return { result: { apps: [{ ...TEXTEDIT, frontmost: false }] } };
      case 'input.idle':
        return { result: { seconds: 0 } };
      case 'app.screenshot':
        return {
          result: { jpeg: 'J', width: 400, height: 300, frame: { width: 400, height: 300 }, pixelsPerPoint: 1, window: WIN, tree: TREE },
        };
      case 'app.press':
        return { result: { ok: true, route: 'ax' } };
      case 'app.menuRefresh':
        return { result: { ok: true, refreshed: true, menu: params.menu } };
      case 'app.menu':
        return { result: params.path ? { ok: true, route: 'ax' } : { ok: true, items: [{ title: 'Make Plain Text' }] } };
      default:
        return { result: { ok: true } };
    }
  };
}

async function rig(over: Record<string, (p: any, n: number) => Reply> = {}) {
  const fake = await scriptedHelper(answers(over));
  const helper = new ComputerHelper({ connectTo: fake.socket });
  const cu: any = Object.assign(new ComputerPermissions(), {
    controlling: null,
    liveHolder: () => cu.controlling,
    chatOf: (id: string) => id,
    session: () => ({ permission: 'default' }),
    harness: () => 'claude',
    anchor: (id: string) => sessionAnchorOf(cu.harness(id), cu.session(id)),
    unattended: async () => null,
    unattendedAllowed: () => true,
    onUnattended: () => {},
    release: async () => {},
  });
  const broker = { ask: async () => ({ decision: 'allow' }) };
  const grants = { forChat: () => [{ bundleId: TEXTEDIT.bundleId, name: 'TextEdit', level: 'full' }], deny: () => [] };
  const desktop = new DesktopControl({ helper, cu, grants, broker, hostPids: async () => new Set() });
  const apps = new AppScopedControl({ desktop, helper, cu, broker });
  const call = (tool: string, args: any = {}) => apps.run(tool, { app: 'TextEdit', ...args }, { chatId: 'c1' });
  const methods = () => fake.log.map((l) => l.method).filter((m) => !['hello', 'apps.list', 'input.idle'].includes(m));
  return {
    fake,
    helper,
    call,
    methods,
    done: async () => {
      helper.stop();
      await fake.close();
      fake.cleanup();
    },
  };
}

const exited = (h: any) => new Promise<void>((r) => h.once('exit', r));

const toolError = (code: string, re: RegExp) => (e: any) => {
  assert.ok(e instanceof ToolError, `a ToolError, got ${e}`);
  assert.equal(e.code, code, e.message);
  assert.match(e.message, re);
  return true;
};

test('a crashed helper is relaunched by the next tool call: consecutive clicks keep working', async () => {
  const r = await rig();
  try {
    await r.call('desktop_app_screenshot');
    for (let i = 0; i < 3; i++) {
      // the helper process goes away between calls (crash, kill)
      const gone = exited(r.helper);
      r.fake.kill();
      await gone;
      const out = JSON.parse((await r.call('desktop_app_click', { element_index: 1 }))[0].text);
      assert.equal(out.effect, 'confirmed');
    }
    assert.equal(r.fake.connections(), 4);
    // the fixture window is sparse: its screenshot also asks for marks (this fake helper has none)
    assert.deepEqual(r.methods(), ['app.screenshot', 'app.marks', 'app.press', 'app.press', 'app.press']);
  } finally {
    await r.done();
  }
});

test('a helper that dies during a click: not replayed, the model is told to look again, and the next call works', async () => {
  const r = await rig({ 'app.press': (_p, n) => (n === 1 ? { drop: true } : { result: { ok: true, route: 'ax' } }) });
  try {
    await r.call('desktop_app_screenshot');
    await assert.rejects(r.call('desktop_app_click', { element_index: 1 }), (e: any) => {
      toolError('changed', /stopped while running app\.press and was restarted.*not repeated: take a fresh screenshot/)(e);
      assert.equal(e.record.effect, 'refused');
      return true;
    });
    assert.deepEqual(r.methods(), ['app.screenshot', 'app.marks', 'app.press']);
    // a fresh look and the retry go to the relaunched helper
    await r.call('desktop_app_screenshot');
    assert.equal(JSON.parse((await r.call('desktop_app_click', { element_index: 1 }))[0].text).effect, 'confirmed');
    assert.equal(r.fake.connections(), 2);
  } finally {
    await r.done();
  }
});

test('a helper that dies during a screenshot: retried once on the relaunched helper, transparently', async () => {
  const r = await rig({ 'app.screenshot': (_p, n) => (n === 1 ? { drop: true } : answers()('app.screenshot', {}, n)) });
  try {
    const out = await r.call('desktop_app_screenshot');
    assert.equal(out[0].type, 'image');
    assert.deepEqual(r.methods(), ['app.screenshot', 'app.screenshot', 'app.marks']);
  } finally {
    await r.done();
  }
});

test('desktop_app_menu refreshes the top-level menu before it resolves and presses the item', async () => {
  const r = await rig();
  try {
    const out = JSON.parse((await r.call('desktop_app_menu', { path: ['Format', 'Make Plain Text'] }))[0].text);
    assert.equal(out.effect, 'confirmed');
    assert.deepEqual(r.methods(), ['app.menuRefresh', 'app.menu']);
    assert.equal(r.fake.log.find((l) => l.method === 'app.menuRefresh')!.params.menu, 'Format');
    assert.deepEqual(r.fake.log.find((l) => l.method === 'app.menu')!.params.path, ['Format', 'Make Plain Text']);
    // listing a menu refreshes it first too; the menu bar itself needs no refresh
    r.fake.log.length = 0;
    assert.match((await r.call('desktop_app_menu', { list: 'Format' }))[0].text, /^Format:\nMake Plain Text/);
    assert.deepEqual(r.methods(), ['app.menuRefresh', 'app.menu']);
    r.fake.log.length = 0;
    await r.call('desktop_app_menu', { list: null });
    assert.deepEqual(r.methods(), ['app.menu']);
    // the tool description tells the model not to spin on a stale menu
    assert.match(
      SPECS.find((s: any) => s.name === 'desktop_app_menu').description,
      /updates its menus .* only when one opens, so the menu is refreshed first.*never change the app's global preferences/,
    );
    // save panels: the folder and name through desktop_app_file_panel, never a "/" typed into the name field
    assert.match(
      SPECS.find((s: any) => s.name === 'desktop_app_type').description,
      /Save or Open panel, choose the folder and file name with desktop_app_file_panel; a "\/" typed into the name field becomes part of the name/,
    );
  } finally {
    await r.done();
  }
});

test('a disabled item is named as disabled (not missing), with what to check and a fallback', async () => {
  const disabled = { error: { code: 17, message: 'Format > Make Plain Text is disabled right now', data: { reason: 'menu_disabled' } } };
  const r = await rig({ 'app.menu': (p) => (p.path ? disabled : { result: { ok: true, items: [] } }) });
  try {
    await assert.rejects(r.call('desktop_app_menu', { path: ['Format', 'Make Plain Text'] }), (e: any) => {
      toolError(
        'disabled',
        /^"Format > Make Plain Text" is in TextEdit's menu but disabled right now\. MoPilot refreshed the menu first/,
      )(e);
      assert.match(e.message, /check that a document window is open/);
      assert.match(e.message, /save sheet/);
      assert.match(e.message, /Don't change the app's global preferences/);
      assert.equal(e.record.effect, 'refused');
      return true;
    });
    assert.deepEqual(r.methods(), ['app.menuRefresh', 'app.menu']);
  } finally {
    await r.done();
  }
});

test('an older helper without app.menuRefresh: the press still runs, and a disabled item says the menu may be stale', async () => {
  const r = await rig({
    'app.menuRefresh': () => ({ error: { code: -32601, message: 'method not found', data: { reason: 'method_not_found' } } }),
    // an older helper reports a disabled item as unsupported(disabled)
    'app.menu': (_p, n) =>
      n === 1
        ? { result: { ok: true } }
        : {
            error: {
              code: 12,
              message: 'unsupported(disabled): Format > Make Plain Text is disabled right now',
              data: { reason: 'unsupported' },
            },
          },
  });
  try {
    assert.equal(JSON.parse((await r.call('desktop_app_menu', { path: ['Format', 'Make Plain Text'] }))[0].text).effect, 'confirmed');
    await assert.rejects(
      r.call('desktop_app_menu', { path: ['Format', 'Make Plain Text'] }),
      toolError('disabled', /disabled right now\. The app may not have updated this menu in the background yet/),
    );
    assert.deepEqual(r.methods(), ['app.menuRefresh', 'app.menu', 'app.menuRefresh', 'app.menu']);
  } finally {
    await r.done();
  }
});

test('menu error helpers: what counts as disabled', () => {
  assert.equal(isMenuDisabled({ reason: 'menu_disabled', message: 'x' }), true);
  assert.equal(isMenuDisabled({ reason: 'unsupported', message: 'unsupported(disabled): x' }), true);
  assert.equal(isMenuDisabled({ reason: 'unsupported', message: 'unsupported(submenu): x' }), false);
  assert.equal(isMenuDisabled({ reason: 'invalid_params', message: 'no "Save" in File' }), false);
  assert.equal(isMenuDisabled(null), false);
  const e = menuDisabledError('Notes', ['File', 'Save'], false);
  assert.equal(e.code, 'disabled');
  assert.match(e.message, /^"File > Save" is in Notes's menu but disabled/);
  // every document command disabled together is the signature of an app with no key window (CM-D21)
  assert.match(e.message, /no key window.*Close and Save included.*desktop_open_application/);
});
