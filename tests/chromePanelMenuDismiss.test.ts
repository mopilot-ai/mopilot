// The Chrome side panel's model, permission and + menus close on Escape (focus returns to the button that opened the menu) and on a press outside them (electron/chrome-extension/src/panelMenuDismiss.mjs, wired in sidePanel.mjs).
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { HTMLElement } from 'happy-dom';
import { window } from './support/dom.ts';
import { panelPage } from './support/side-panel-page.ts';

const { PanelMenuDismiss } = await import('../electron/chrome-extension/src/panelMenuDismiss.mjs');
const { startSidePanel } = await import('../electron/chrome-extension/src/sidePanel.mjs');

const doc = window.document;
const live: any[] = [];
afterEach(() => {
  live.splice(0).forEach((d) => d.dispose());
  doc.body.replaceChildren();
});

function fixture() {
  doc.body.innerHTML = `<div id="outside"></div>
    <div id="model-menu" hidden><button id="model-row"></button></div><div id="perm-menu" hidden><button id="perm-row"></button></div><div id="plus-menu" hidden><button id="plus-row"></button></div>
    <button id="model"></button><button id="perm"></button><button id="plus"></button>`;
  const $ = (id: string) => doc.getElementById(id)! as HTMLElement;
  let closed = 0;
  const dismiss = new PanelMenuDismiss({
    document: doc,
    close: () => {
      closed++;
      for (const id of ['model-menu', 'perm-menu', 'plus-menu']) $(id).hidden = true;
    },
  });
  live.push(dismiss);
  const press = (target: HTMLElement) => target.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true }));
  const key = (init: any) => doc.dispatchEvent(new window.KeyboardEvent('keydown', init));
  return { $, press, key, closed: () => closed };
}

for (const [menu, button] of [
  ['model-menu', 'model'],
  ['perm-menu', 'perm'],
  ['plus-menu', 'plus'],
] as const) {
  test(`Escape closes the ${menu} and puts focus back on its ${button} button`, () => {
    const f = fixture();
    f.$(menu).hidden = false;
    f.$(`${button}-row`).focus();
    f.key({ key: 'Escape' });
    assert.equal(f.$(menu).hidden, true);
    assert.equal(doc.activeElement, f.$(button));
    assert.equal(f.closed(), 1);
  });

  test(`a press outside the ${menu} closes it and leaves focus alone`, () => {
    const f = fixture();
    f.$(menu).hidden = false;
    f.$('outside').setAttribute('tabindex', '0');
    f.$('outside').focus();
    f.press(f.$('outside'));
    assert.equal(f.$(menu).hidden, true);
    assert.equal(doc.activeElement, f.$('outside'));
  });

  test(`a press inside the ${menu} or on its button is the menu's own: it stays open`, () => {
    const f = fixture();
    f.$(menu).hidden = false;
    f.press(f.$(`${button}-row`));
    f.press(f.$(button));
    assert.equal(f.$(menu).hidden, false);
    assert.equal(f.closed(), 0);
  });
}

test("a press on another menu's button is that button's own (it switches the menus itself)", () => {
  const f = fixture();
  f.$('model-menu').hidden = false;
  f.press(f.$('perm'));
  assert.equal(f.$('model-menu').hidden, false);
  assert.equal(f.closed(), 0);
});

test('with no menu open, Escape and a press do nothing', () => {
  const f = fixture();
  f.key({ key: 'Escape' });
  f.press(f.$('outside'));
  assert.equal(f.closed(), 0);
  assert.notEqual(doc.activeElement, f.$('model'));
});

test("another key, and an Escape that ends an input method's composition, leave the menu open", () => {
  const f = fixture();
  f.$('perm-menu').hidden = false;
  f.key({ key: 'a' });
  f.key({ key: 'Escape', isComposing: true });
  f.key({ key: 'Escape', keyCode: 229 });
  assert.equal(f.$('perm-menu').hidden, false);
  assert.equal(f.closed(), 0);
  f.key({ key: 'Escape' });
  assert.equal(f.$('perm-menu').hidden, true);
});

test('after dispose, nothing closes the menus', () => {
  const f = fixture();
  live.splice(0).forEach((d) => d.dispose());
  f.$('model-menu').hidden = false;
  f.key({ key: 'Escape' });
  f.press(f.$('outside'));
  assert.equal(f.$('model-menu').hidden, false);
  assert.equal(f.closed(), 0);
});

test("the panel's own menus close through the listeners it registers on its document", async () => {
  const p = panelPage();
  await startSidePanel(p.g).ready;
  const { keydown, pointerdown } = p.g.document.listeners;
  // hidden until opened, as in sidepanel.html
  for (const id of ['model-menu', 'perm-menu', 'plus-menu']) {
    p.els[id].hidden = true;
    p.els[id].contains = () => false;
  }
  for (const id of ['model', 'perm', 'plus']) p.els[id].contains = () => false;
  p.els['plus-menu'].hidden = false;
  keydown({ key: 'Escape' });
  assert.equal(p.els['plus-menu'].hidden, true);
  assert.equal(p.els.plus.focused, 1);
  p.els['model-menu'].hidden = false;
  pointerdown({ target: {} });
  assert.equal(p.els['model-menu'].hidden, true);
  // a press on the open menu's own button stays its own
  p.els['model-menu'].hidden = false;
  p.els.model.contains = (t: any) => t === p.els.model;
  pointerdown({ target: p.els.model });
  assert.equal(p.els['model-menu'].hidden, false);
});
