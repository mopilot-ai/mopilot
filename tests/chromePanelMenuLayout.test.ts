// Chrome panel menus use the real stylesheet and stay compact beside the composer, even with a long model catalog.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Window, type HTMLElement, type HTMLButtonElement } from 'happy-dom';
import { trackMenuSpace } from '../electron/chrome-extension/src/panelMenuLayout.mjs';
import { PanelMenus } from '../electron/chrome-extension/src/panelMenus.mjs';

const root = new URL('../electron/chrome-extension/', import.meta.url);

function panel() {
  const window = new Window({ width: 720, height: 682, settings: { disableCSSFileLoading: true, disableJavaScriptFileLoading: true } });
  const { document } = window;
  document.write(fs.readFileSync(new URL('sidepanel.html', root), 'utf8'));
  const style = document.createElement('style');
  style.textContent = ['panel.css', 'sidepanel.css'].map((file) => fs.readFileSync(new URL(file, root), 'utf8')).join('\n');
  document.head.append(style);
  (document.getElementById('composer') as HTMLElement).hidden = false;
  return { window, document };
}

test('model, permission and add menus have a compact width; command and mention results keep their full width', async () => {
  const { window, document } = panel();
  try {
    for (const id of ['model-menu', 'perm-menu', 'plus-menu']) {
      const style = window.getComputedStyle(document.getElementById(id)!);
      assert.equal(style.width, '300px', `${id} is a compact popup on a wide panel`);
      assert.equal(style.maxWidth, 'calc(100% - 16px)', `${id} also fits a narrow panel`);
      assert.equal(style.left, id === 'model-menu' ? 'auto' : '8px');
      assert.equal(style.right, id === 'model-menu' ? '8px' : 'auto');
    }
    for (const id of ['slash-menu', 'mention-menu']) {
      const style = window.getComputedStyle(document.getElementById(id)!);
      assert.equal(style.left, '8px');
      assert.equal(style.right, '8px');
      assert.notEqual(style.width, '300px');
    }
  } finally {
    await window.happyDOM.close();
  }
});

test('every composer menu scrolls within the available space without passing scroll gestures to the chat', async () => {
  const { window, document } = panel();
  try {
    for (const id of ['model-menu', 'perm-menu', 'plus-menu', 'slash-menu', 'mention-menu']) {
      const style = window.getComputedStyle(document.getElementById(id)!);
      assert.equal(style.maxHeight, 'min(360px, 409.2px, 409.2px)');
      assert.equal(style.overflow, 'auto');
      assert.equal(style.overscrollBehavior, 'contain');
      assert.equal(style.overflowWrap, 'anywhere');
      assert.equal(style.bottom, 'calc(100% + 6px - 0px)');
    }
  } finally {
    await window.happyDOM.close();
  }
});

test('composer and viewport resizes read the latest bounds and constrain every menu without resetting its scroll or draft', async () => {
  const { window, document } = panel();
  let resized!: () => void;
  const observed: unknown[] = [];
  Object.defineProperty(window, 'ResizeObserver', {
    value: class {
      constructor(callback: () => void) {
        resized = callback;
      }
      observe(target: unknown) {
        observed.push(target);
      }
    },
  });
  const composer = document.getElementById('composer') as HTMLElement;
  const menu = document.getElementById('model-menu')!;
  const draft = document.getElementById('text') as any;
  let top = 500;
  composer.getBoundingClientRect = () => ({ top }) as any;
  draft.value = 'Keep this multiline\ndraft';
  menu.scrollTop = 140;
  try {
    trackMenuSpace(document);
    assert.deepEqual(observed, [composer, document.documentElement]);
    assert.equal(composer.style.getPropertyValue('--menu-space'), '488px');
    // Several resizes before delivery still use the current composer, not a captured size.
    top = 300;
    top = 186.9;
    resized();
    assert.equal(composer.style.getPropertyValue('--menu-space'), '174px');
    for (const id of ['model-menu', 'perm-menu', 'plus-menu', 'slash-menu', 'mention-menu']) {
      assert.equal(window.getComputedStyle(document.getElementById(id)!).maxHeight, 'min(360px, 409.2px, 174px)');
    }
    top = 8;
    resized();
    assert.equal(composer.style.getPropertyValue('--menu-space'), '20px', 'a hidden anchor retains room for popup padding and borders');
    top = 460;
    resized();
    assert.equal(composer.style.getPropertyValue('--menu-space'), '448px', 'shrinking a draft restores menu space');
    assert.equal(menu.scrollTop, 140);
    assert.equal(draft.value, 'Keep this multiline\ndraft');
  } finally {
    await window.happyDOM.close();
  }
});

test('documents without a browser observer keep the stylesheet fallback', () => {
  trackMenuSpace({});
  trackMenuSpace({ defaultView: {} });
});

test('scrolling moves the popup budget with the composer and falls back to the visible toolbar when the form scrolls offscreen', async () => {
  const { window, document } = panel();
  Object.defineProperty(window, 'ResizeObserver', {
    value: class {
      observe() {}
    },
  });
  const composer = document.getElementById('composer') as HTMLElement;
  const menu = document.getElementById('model-menu')!;
  let top = 500;
  let toolbarTop = 240;
  const writes: string[] = [];
  const setProperty = composer.style.setProperty.bind(composer.style);
  composer.style.setProperty = (name, value) => {
    writes.push(name);
    setProperty(name, value);
  };
  composer.getBoundingClientRect = () => ({ top }) as any;
  document.getElementById('plus')!.getBoundingClientRect = () => ({ top: toolbarTop }) as any;
  try {
    trackMenuSpace(document);
    assert.equal(writes.length, 2);
    menu.dispatchEvent(new window.Event('scroll'));
    assert.equal(writes.length, 2, 'scrolling within a stationary menu does not rewrite inherited styles');
    top = 200;
    document.dispatchEvent(new window.Event('scroll'));
    assert.equal(composer.style.getPropertyValue('--menu-space'), '188px', 'scrolling invalidates bounds without any resize');
    top = 20;
    document.dispatchEvent(new window.Event('scroll'));
    assert.equal(composer.style.getPropertyValue('--menu-space'), '228px', 'a near-edge form still leaves room for a visible choice');
    assert.equal(composer.style.getPropertyValue('--menu-shift'), '220px');
    top = -100;
    // Scroll does not bubble; a captured descendant scroll also refreshes viewport-relative geometry.
    menu.dispatchEvent(new window.Event('scroll'));
    assert.equal(composer.style.getPropertyValue('--menu-space'), '228px');
    assert.equal(composer.style.getPropertyValue('--menu-shift'), '340px', 'the offscreen form uses its visible toolbar');
    toolbarTop = 0;
    top = 8;
    document.dispatchEvent(new window.Event('scroll'));
    assert.equal(composer.style.getPropertyValue('--menu-space'), '20px', 'the popup box floor keeps its top margin');
    assert.equal(composer.style.getPropertyValue('--menu-shift'), '24px');
    top = 900;
    document.dispatchEvent(new window.Event('scroll'));
    assert.equal(composer.style.getPropertyValue('--menu-space'), '664px', 'an offscreen lower anchor is clamped to this viewport');
    assert.equal(composer.style.getPropertyValue('--menu-shift'), '-224px');
    const count = writes.length;
    document.dispatchEvent(new window.Event('scroll'));
    assert.equal(writes.length, count, 'equivalent geometry is coalesced');
  } finally {
    await window.happyDOM.close();
  }
});

test('an ACP effort with a long native label keeps room for the model in the compact first view', async () => {
  const { window, document } = panel();
  const label = 'Maximum reasoning for difficult multi-step tasks';
  const menus = new PanelMenus({
    document,
    request: async () => ({
      harness: 'ACP',
      model: 'native-model',
      effort: 'maximum',
      models: [{ id: 'native-model', label: 'Provider / Model', efforts: [{ id: 'maximum', label }] }],
    }),
    onError: assert.fail,
    onHarness: assert.fail,
  });
  try {
    await menus.load({ harness: 'acp:native' });
    (document.getElementById('model') as HTMLButtonElement).click();
    const name = document.querySelector('.effort-name')!;
    const style = window.getComputedStyle(name);
    assert.equal(name.textContent, label);
    assert.equal(style.maxWidth, '50%');
    assert.equal(style.overflow, 'hidden');
    assert.equal(style.whiteSpace, 'nowrap');
    assert.equal(style.textOverflow, 'ellipsis');
    assert.equal(document.querySelector('#model-rows [aria-checked=true]')!.textContent, label, 'the full effort name stays in its row');
    assert.equal(document.querySelector('.effort-model')!.textContent, 'ACP · Provider / Model');
  } finally {
    await window.happyDOM.close();
  }
});

for (const harness of ['Codex', 'Claude Code', 'ACP']) {
  test(`${harness}: a long catalog stays behind the effort view, with descriptions in tooltips and older models collapsed`, async () => {
    const { window, document } = panel();
    const models = Array.from({ length: 30 }, (_, i) => ({
      id: `model-${i}`,
      label: `${harness} provider / model ${i}`,
      description: 'A long explanation that should not make every model row two lines tall.',
      efforts: harness === 'ACP' ? [] : [{ id: 'high', label: 'High' }],
      defaultEffort: harness === 'ACP' ? null : 'high',
      more: i >= 5,
    }));
    const menus = new PanelMenus({
      document,
      request: async () => ({ harness, model: models[0].id, models, effort: models[0].defaultEffort, permission: null }),
      onError: assert.fail,
      onHarness: assert.fail,
    });
    try {
      await menus.load({ harness });
      (document.getElementById('model') as HTMLButtonElement).click();
      assert.equal(document.querySelectorAll('#model-rows .menu-item').length, harness === 'ACP' ? 1 : 2);
      const name = document.querySelector('.effort-name')!;
      assert.equal(window.getComputedStyle(name).flexShrink, '0');
      assert.equal(window.getComputedStyle(document.querySelector('.effort-model')!).minWidth, '0');
      document.querySelector<HTMLButtonElement>('.effort-title')!.click();
      assert.equal(document.querySelectorAll('#model-rows [role=menuitemradio]').length, 5);
      assert.equal(document.querySelector('#model-rows small'), null);
      assert.equal(document.querySelector('#model-rows [role=menuitemradio]')!.getAttribute('title'), models[0].description);
      document.querySelector<HTMLButtonElement>('#model-rows .more')!.click();
      assert.equal(document.querySelectorAll('#model-rows [role=menuitemradio]').length, 30);
      assert.equal(document.querySelector('#model-rows .more')!.getAttribute('aria-expanded'), 'true');
    } finally {
      await window.happyDOM.close();
    }
  });
}
