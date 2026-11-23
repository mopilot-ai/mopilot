// A text field busy with its own work keeps the keyboard (#1658): busyField (src/lib/focus.ts) makes it read-only rather
// than disabled, and lint/rules/focus-drop.grit keeps every input, textarea and editor in src on it.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { busyField } from '../src/lib/focus.ts';
import { focusFixup, keyTarget, pressKey } from './support/focus-fixup.ts';
import { lintFixtures } from '../scripts/biome-fixtures.mjs';
import { assertRendererRuleAtZero } from './support/lint-rule-kit.ts';

afterEach(() => document.body.replaceChildren());

test('busyField is read-only and aria-disabled while busy, and plain otherwise', () => {
  assert.deepEqual(busyField(true), { readOnly: true, 'aria-disabled': true });
  assert.deepEqual(busyField(false), { readOnly: false, 'aria-disabled': undefined });
});

test("the focus fixup moves a disabled field's or a non-editable editor's focus to <body>; a read-only field keeps it", async () => {
  const uninstall = focusFixup();
  try {
    const cases: [string, (el: HTMLElement) => void, boolean][] = [
      ['<input>', (el) => ((el as HTMLInputElement).disabled = true), false],
      ['<textarea></textarea>', (el) => ((el as HTMLTextAreaElement).disabled = true), false],
      ['<div contenteditable="true"></div>', (el) => (el.contentEditable = 'false'), false],
      ['<div contenteditable="true"></div>', (el) => el.remove(), false],
      ['<input>', (el) => ((el as HTMLInputElement).readOnly = true), true],
      ['<div contenteditable="true"></div>', (el) => el.setAttribute('aria-disabled', 'true'), true],
      ['<div tabindex="0" contenteditable="true"></div>', (el) => (el.contentEditable = 'false'), true],
      ['<a href="#x">x</a>', (el) => el.setAttribute('tabindex', '-1'), true],
      ['<button>x</button>', (el) => el.setAttribute('tabindex', '0'), true],
    ];
    for (const [html, change, keeps] of cases) {
      document.body.innerHTML = html;
      const el = document.body.firstElementChild as HTMLElement;
      el.focus();
      assert.equal(keyTarget(), el, html);
      change(el);
      await new Promise((r) => setTimeout(r, 0));
      assert.equal(keyTarget() === el, keeps, `${html} keeps the focus: ${keeps}`);
    }
  } finally {
    uninstall();
  }
  // a key goes to whatever has the focus, <body> when nothing has
  const seen: EventTarget[] = [];
  document.body.innerHTML = '<input>';
  const field = document.body.firstElementChild as HTMLInputElement;
  document.addEventListener('keydown', (e) => seen.push(e.target!), { once: true });
  field.focus();
  assert.equal(await pressKey('Escape'), false);
  field.blur();
  document.addEventListener('keydown', (e) => (seen.push(e.target!), e.preventDefault()), { once: true });
  assert.equal(await pressKey('Escape'), true);
  assert.deepEqual(seen, [field, document.body]);
});

/** The [focus-drop] warnings Biome reports for `input`, written as a .tsx file under src. */
function hits(input: string): number {
  return lintFixtures({ 'src/components/Field.tsx': input }).diagnostics.filter((d) => d.message.includes('[focus-drop]')).length;
}

test('a text field disabled or made non-editable by an expression warns; read-only, literals and other controls do not', () => {
  for (const [input, expected] of [
    ['export const A = () => <input disabled={busy} />;', 1],
    ['export const B = () => <textarea value={v} disabled={saving}>x</textarea>;', 1],
    ['export const C = () => <div contentEditable={!disabled} />;', 1],
    ['export const K = () => <input\n  className="a"\n  disabled={a || b}\n/>;', 1],
    ['export const D = () => <input type="checkbox" disabled={busy} />;', 0],
    ['export const J = () => <input\n  type="radio"\n  disabled={x}\n/>;', 0],
    ['export const E = () => <button disabled={busy} />;', 0],
    ['export const F = () => <input disabled />;', 0],
    ['export const G = () => <input disabled={true} />;', 0],
    ['export const H = () => <div contentEditable suppressContentEditableWarning />;', 0],
    ['export const I = () => <input {...busyField(busy)} />;', 0],
    ['export const L = () => <textarea readOnly={busy} />;', 0],
  ] as const)
    assert.equal(hits(input), expected, input);
});

test('the rule covers the renderer and starts at zero', () => assertRendererRuleAtZero('./lint/rules/focus-drop.grit'));
