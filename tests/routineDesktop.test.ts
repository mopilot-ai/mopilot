// Action memory on the desktop (#3571, G4; electron/capabilities/routines/routineDesktop.cjs): desktop_* calls as steps
// (elements by accessibility identity, never element_index; menus, scripts and Shortcuts as recorded; anything a replay
// can't run kept as a step it hands off at), the window state found by bundle id or app name, and a replay that runs none of
// them (it only reads: the steps come back as a plan), on a real Registry with the routine tools.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { routineKit } from './support/routine-kit.ts';

const require = createRequire(import.meta.url);
const D = require('../electron/capabilities/routines/routineDesktop.cjs');
const S = require('../electron/capabilities/routines/routineSteps.cjs');
const { ToolError } = require('../electron/capabilities/contract/registry.cjs');

const el = (index: number, role: string, label: string, extra: any = {}) => ({
  index,
  role,
  label,
  frame: { x: index * 100, y: 0, w: 90, h: 20 },
  ...extra,
});
const NOTE = el(1, 'AXTextArea', 'Note body');
const SAVE = el(2, 'AXButton', 'Save');
const SAVE2 = el(3, 'AXButton', 'Save');
/** The app-scoped control's state for one chat: Notes, with its last window's elements. */
const appsWith = (elements: any[]) => ({
  sessions: new Map([
    ['c1', { apps: new Map([['com.apple.notes', { name: 'Notes', lastWindow: 7, windows: new Map([[7, { geom: {}, elements }]]) }]]) }],
  ]),
});
const GEOMETRY = {
  toPoints: (_g: any, p: any) => p,
  elementAt: (els: any[], p: any) => els.find((e) => p.x >= e.frame.x && p.x <= e.frame.x + e.frame.w) ?? null,
};

test('windowOf: by bundle id or app name in any case; nothing for another chat, app or none', () => {
  const apps = appsWith([NOTE]);
  assert.equal(D.windowOf(apps, 'c1', 'com.apple.Notes')!.app, 'com.apple.notes');
  assert.equal(D.windowOf(apps, 'c1', 'notes')!.w.elements[0], NOTE);
  assert.equal(D.windowOf(apps, 'c1', 'Mail'), null);
  assert.equal(D.windowOf(apps, 'c2', 'Notes'), null);
  assert.equal(D.windowOf(apps, 'c1', ''), null);
  assert.equal(D.windowOf(null, 'c1', 'Notes'), null);
  const noWindow = { sessions: new Map([['c1', { apps: new Map([['x', { name: 'X', lastWindow: null, windows: new Map() }]]) }]]) };
  assert.deepEqual(D.windowOf(noWindow, 'c1', 'x'), { app: 'x', w: null });
});

test('identityOf: role, label and the place among twins', () => {
  assert.deepEqual(D.identityOf([NOTE, SAVE, SAVE2], SAVE2), { role: 'AXButton', label: 'Save', nth: 1 });
});

test('desktop steps: element targets by identity, menus, scripts and Shortcuts as recorded, the rest kept as hand-offs', () => {
  const anchors = new Map<string, any>([
    ['el:2', { app: 'com.apple.notes', el: { role: 'AXButton', label: 'Save', nth: 0 } }],
    ['el:4', { app: 'com.apple.notes', el: { role: 'AXSecureTextField', label: 'Password', nth: 0 }, secret: true }],
  ]);
  const steps = (tool: string, args: any) => S.stepsOfCall(tool, args, anchors, null);
  assert.deepEqual(steps('desktop_app_click', { app: 'Notes', element_index: 2, window_id: 7 }), [
    {
      tool: 'desktop_app_click',
      args: { app: 'Notes' },
      target: { app: 'com.apple.notes', el: { role: 'AXButton', label: 'Save', nth: 0 } },
    },
  ]);
  assert.deepEqual(steps('desktop_app_click', { app: 'Notes', element_index: 9 }), [
    { tool: 'desktop_app_click', args: { app: 'Notes' }, target: null },
  ]);
  // the focused element: no target, as the step before set it
  assert.deepEqual(steps('desktop_app_type', { app: 'Notes', text: 'hi', target: 'focused' }), [
    { tool: 'desktop_app_type', args: { app: 'Notes', text: 'hi', target: 'focused' } },
  ]);
  // a secure field's text is never kept
  assert.deepEqual(steps('desktop_app_type', { app: 'Notes', element_index: 4, text: 'hunter2' }), [
    { tool: 'desktop_app_type', args: { app: 'Notes' }, target: { app: 'com.apple.notes', el: anchors.get('el:4').el }, secret: true },
  ]);
  assert.deepEqual(steps('desktop_app_menu', { app: 'Notes', path: ['File', 'Export as PDF…'] }), [
    { tool: 'desktop_app_menu', args: { app: 'Notes', path: ['File', 'Export as PDF…'] } },
  ]);
  assert.deepEqual(steps('desktop_app_script', { app: 'Notes', script: 'x' }), [
    { tool: 'desktop_app_script', args: { app: 'Notes', script: 'x' } },
  ]);
  assert.deepEqual(steps('desktop_app_screenshot', { app: 'Notes' }), []);
  for (const tool of ['desktop_app_batch', 'desktop_app_drag', 'desktop_app_file_panel', 'desktop_click'])
    assert.deepEqual(steps(tool, { app: 'Notes' }), [{ tool, args: {}, unsupported: true }]);
  assert.equal(S.prefixOf('desktop_app_click'), 'desktop_');
  assert.equal(S.targetKey({ element_index: 3 }), 'el:3');
});

test('desktop steps read and parameterize as the user would say them', () => {
  const target = { app: 'com.apple.notes', el: { role: 'AXTextArea', label: 'Note body', nth: 0 } };
  const { steps, params } = S.parameterize([{ tool: 'desktop_app_type', args: { app: 'Notes', text: 'Buy milk' }, target }]);
  assert.deepEqual(params, [{ name: 'note_body', example: 'Buy milk' }]);
  assert.equal(S.describeStep(steps[0]), 'type "{{note_body}}" "Note body"');
  assert.equal(S.describeStep({ tool: 'desktop_app_type', args: {}, target, secret: true }), 'type into a password field "Note body"');
  assert.equal(S.describeStep({ tool: 'desktop_app_type', args: {} }), 'type ""');
  assert.equal(S.describeStep({ tool: 'desktop_app_key', args: { combo: 'return' } }), 'key return');
  assert.equal(S.describeStep({ tool: 'desktop_app_key', args: {} }), 'key ');
  assert.equal(S.describeStep({ tool: 'desktop_app_menu', args: { path: ['File', 'Save'] } }), 'menu File › Save');
  assert.equal(S.describeStep({ tool: 'desktop_app_menu', args: {} }), 'menu ');
  assert.equal(
    S.describeStep({ tool: 'desktop_app_click', args: {}, target: { app: 'x', el: { role: 'AXButton', label: 'Save', nth: 0 } } }),
    'click "Save"',
  );
  assert.equal(S.describeStep({ tool: 'desktop_shortcut_run', args: {} }), 'shortcut_run');
  assert.equal(S.targetName({ target: { app: 'x', el: { role: 'AXButton', label: '', nth: 0 } } }), null);
});

test('desktop adapter: anchors from the latest screenshot by element_index or coordinate; none without a window; never throws', async () => {
  let apps: any = appsWith([NOTE, SAVE, SAVE2]);
  const a = D.desktopAdapter(() => apps, GEOMETRY);
  assert.equal(a.up(), true);
  assert.equal(a.url(), null);
  const byIndex = await a.anchorsBefore('c1', 'desktop_app_click', { app: 'Notes', element_index: 3 });
  assert.deepEqual(byIndex.anchors.get('el:3'), { app: 'com.apple.notes', el: { role: 'AXButton', label: 'Save', nth: 1 }, secret: false });
  const byPoint = await a.anchorsBefore('c1', 'desktop_app_click', { app: 'Notes', coordinate: [210, 5] });
  assert.deepEqual(byPoint.anchors.get('at:210,5').el, { role: 'AXButton', label: 'Save', nth: 0 });
  assert.equal((await a.anchorsBefore('c1', 'desktop_app_click', { app: 'Mail', element_index: 1 })).anchors.get('el:1'), null);
  assert.equal((await a.anchorsBefore('c1', 'desktop_app_click', { app: 'Notes', element_index: 99 })).anchors.get('el:99'), null);
  assert.equal((await a.anchorsBefore('c1', 'desktop_app_type', { app: 'Notes', target: 'focused' })).anchors.size, 0);
  apps = {
    get sessions() {
      throw new Error('state gone');
    },
  };
  assert.equal((await a.anchorsBefore('c1', 'desktop_app_click', { app: 'Notes', element_index: 1 })).anchors.size, 0);
  apps = null;
  assert.equal(a.up(), false);
});

test('CU: desktop steps record by identity; a replay runs none of them and plans all five, with no screenshot taken', async () => {
  const k = routineKit();
  let elements = [NOTE, SAVE];
  const apps = appsWith(elements);
  const did: any[] = [];
  let moved = false;
  const set = (els: any[]) => {
    elements = els;
    (apps.sessions.get('c1')!.apps.get('com.apple.notes') as any).windows.get(7).elements = els;
  };
  const fake = (name: string) => ({
    name,
    policy: name === 'desktop_app_screenshot' ? 'observe' : 'act',
    authorizesItself: true,
    schema: { type: 'object' },
    handler: async (args: any) => {
      if (name === 'desktop_app_screenshot') {
        // a new screenshot: the window's elements as they are now (on the replay, the Save button moved to [1])
        if (moved) set([SAVE, NOTE].map((e, i) => ({ ...e, index: i + 1 })));
        return 'shot';
      }
      if (typeof args.element_index === 'number' && !elements[args.element_index - 1]) throw new ToolError('no such element', 'bad_args');
      did.push([name, args]);
      return `${name} ok`;
    },
  });
  const rec = k.recorder.recording(k.registry, () => apps, 'desktop_');
  for (const n of ['desktop_app_screenshot', 'desktop_app_click', 'desktop_app_type', 'desktop_app_menu']) rec.register(fake(n));
  await k.call('desktop_app_screenshot', { app: 'Notes' }, 'c1');
  await k.call('desktop_app_click', { app: 'Notes', element_index: 1 }, 'c1');
  await k.call('desktop_app_type', { app: 'Notes', text: 'Buy milk', target: 'focused' }, 'c1');
  await k.call('desktop_app_click', { app: 'Notes', element_index: 1 }, 'c1');
  await k.call('desktop_app_click', { app: 'Notes', element_index: 2 }, 'c1');
  await k.call('desktop_app_menu', { app: 'Notes', path: ['File', 'Close'] }, 'c1');
  k.end('c1');
  const saved = await k.call('routine_save', { name: 'Note it' }, 'c1');
  assert.equal(saved.ok, true, JSON.stringify(saved.error));
  const r = k.store.get('Note it');
  assert.equal(r.kind, 'desktop');
  assert.deepEqual(r.params, [{ name: 'note_body', example: 'Buy milk' }]);
  // the routine runs on the window as it is now: a replay only reads, so no step runs and no screenshot is taken
  did.length = 0;
  moved = true;
  const res = await k.call('routine_run', { routine: 'Note it', params: { note_body: 'Call Sam' } }, 'c1');
  assert.equal(res.ok, true, JSON.stringify(res.error));
  const text = k.text(res);
  assert.match(text, /read 0 of 5 steps again and changed nothing/);
  assert.match(text, /1\. click "Note body"\n2\. type "Call Sam"\n3\. click "Note body"\n4\. click "Save"\n5\. menu File/);
  assert.deepEqual(did, [], 'nothing acted');
  // computer use not up: refused, nothing runs
  k.recorder.recording(k.registry, () => null, 'desktop_');
  const down = await k.call('routine_run', { routine: 'Note it' }, 'c1');
  assert.match(down.error.message, /Computer use isn't available yet/);
});

test('windowOf: no app named finds nothing; an app state without a name is found by its bundle id only', () => {
  assert.equal(D.windowOf(appsWith([NOTE]), 'c1', undefined), null);
  const unnamed = {
    sessions: new Map([['c1', { apps: new Map([['com.x', { lastWindow: 1, windows: new Map([[1, { elements: [] }]]) }]]) }]]),
  };
  assert.equal(D.windowOf(unnamed, 'c1', 'X'), null);
  assert.equal(D.windowOf(unnamed, 'c1', 'com.x')!.app, 'com.x');
});
