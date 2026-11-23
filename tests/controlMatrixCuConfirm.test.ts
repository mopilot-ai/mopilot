// Control matrix, computer-use confirmations (docs/control-plane/matrix.md, group Q): a click asks "this can't be
// undone" only for a control whose label names an irreversible action (a button, link or menu item), never for content
// the user wrote (a reminder called "Buy milk", a text field, a row) or for a toggle or selection, on every route:
// the computer_* tools, the desktop_* display tools and the desktop_app_* background tools.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { treeFiles } from '../scripts/source-tree.mjs';
import { createRequire } from 'node:module';
import * as desktopKit from './support/desktop-kit.ts';
import * as appKit from './support/app-scoped-kit.ts';

export const GUARDS = ['electron/'];

const require = createRequire(import.meta.url);
const policy = require('../electron/capabilities/contract/policy.cjs');
const REMINDERS = { bundleId: 'com.apple.reminders', name: 'Reminders' };
const click = (element: any) => policy.irreversible('computer_click', {}, { app: REMINDERS, element });

test('CM-Q11: a click on content or a toggle named like an action is not irreversible; a control named so still is', () => {
  // what the user wrote: a reminder's title field, a list row, a cell; and toggles, tabs and selection controls
  for (const role of ['AXTextField', 'AXTextArea', 'AXSearchField', 'AXComboBox', 'AXRow', 'AXCell', 'AXOutline', 'AXList', 'AXTable'])
    assert.equal(click({ role, title: '', value: 'Buy milk' }), null, role);
  for (const role of ['AXCheckBox', 'AXRadioButton', 'AXSwitch', 'AXTab', 'AXDisclosureTriangle', 'AXSlider', 'AXIncrementor'])
    assert.equal(click({ role, description: 'Incomplete, Buy milk' }), null, role);
  // controls that act: buttons, links and menu items are judged by what they say
  assert.deepEqual(click({ role: 'AXButton', title: 'Buy now' }), { verb: 'pay', summary: 'Buy now' });
  assert.deepEqual(click({ role: 'AXLink', title: 'Delete account' }), { verb: 'delete', summary: 'Delete account' });
  assert.deepEqual(click({ role: 'AXMenuItem', title: 'Send' }), { verb: 'send', summary: 'Send' });
  // static text and images can be a control's face: still judged, as is an element of unknown role
  assert.equal(click({ role: 'AXStaticText', value: 'Place order' })?.verb, 'pay');
  assert.equal(click({ title: 'Delete' })?.verb, 'delete');
  // the model's own flag still asks on content
  const flagged = policy.irreversible(
    'computer_click',
    { irreversible: true, summary: 'complete it' },
    { app: REMINDERS, element: { role: 'AXCheckBox' } },
  );
  assert.equal(flagged?.verb, 'do this');
});

test('CM-Q12: desktop_* clicks: a text field holding "Buy milk" does not ask; the Send button still does', async () => {
  const r = desktopKit.rig();
  await r.ready([desktopKit.NOTES]);
  r.d.session('c1').consent = true;
  const field = r.d.session('c1').elements.find((e: any) => e.role === 'AXTextField');
  field.label = 'Buy milk';
  await r.call('desktop_left_click', { element_index: field.index });
  assert.equal(r.asks.filter((a: any) => a.kind === 'computerConfirm').length, 0);
  await r.call('desktop_left_click', { element_index: 1 });
  assert.deepEqual(
    r.asks.filter((a: any) => a.kind === 'computerConfirm').map((a: any) => a.params.verb),
    ['send'],
  );
});

test('CM-Q13: desktop_app_* clicks: a text area holding "Pay the bill" does not ask; Send and a Delete menu item still do', async () => {
  const r = appKit.rig();
  const shot = r.helper.answers['app.screenshot'];
  r.helper.answers['app.screenshot'] = () => {
    const out = shot();
    out.tree.root.children[1].value = 'Pay the bill';
    return out;
  };
  await r.shoot();
  await r.call('desktop_app_click', { app: 'Notes', element_index: 2 });
  assert.equal(r.asks.length, 0);
  r.answers.computerConfirm = { decision: 'deny' };
  await appKit.rejects(r.call('desktop_app_click', { app: 'Notes', element_index: 1 }), 'denied', /didn't confirm: send in Notes/);
  const app = { bundleId: 'com.apple.Notes', name: 'Notes' };
  assert.equal(r.apps.consequence({ app }, 'menu', { path: ['Edit', 'Delete'] }, {}, null)?.verb, 'delete');
});

test('CM-Q14: every click judged for an irreversible label passes the element with its role (guard for every route)', () => {
  const dir = fileURLToPath(new URL('../electron/', import.meta.url));
  const files = treeFiles(dir, /\.cjs$/);
  const sites: string[] = [];
  for (const file of files) {
    const f = path.relative(dir, file);
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/irreversible\(\s*'computer_click'[^;\n]*/g)) {
      sites.push(f);
      // a literal element object names its role (computer.cjs judges the helper's own node, role included: CM-Q11)
      const literal = /element:\s*([\w.]+\s*\?\s*)?\{([^}]*)\}/.exec(m[0]);
      assert.ok(literal && /\brole:/.test(literal[2]), `${f} passes a role: ${m[0]}`);
    }
  }
  assert.ok(sites.length >= 3, `found the click routes: ${sites.join(', ')}`);
});
