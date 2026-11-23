// Native browser input forwards only recognized, live shortcuts and suppresses duplicate native/menu execution.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
const { browserShortcuts } = createRequire(import.meta.url)('../electron/capabilities/browser/browserShortcuts.cjs');
test('native input honors platform bindings, focus, repeat, IME and destroyed owners', () => {
  const wc: any = new EventEmitter();
  let destroyed = false,
    focused = true;
  wc.isDestroyed = () => destroyed;
  wc.isFocused = () => focused;
  let bindings: any = {};
  const delivered: string[] = [];
  browserShortcuts(
    wc,
    () => bindings,
    (combo: string) => delivered.push(combo),
    'darwin',
  );
  const input = (mods: any = {}) => {
    let prevented = false;
    wc.emit(
      'before-input-event',
      {
        preventDefault: () => {
          prevented = true;
        },
      },
      { type: 'keyDown', key: 'c', code: 'KeyC', meta: true, control: false, shift: true, alt: false, ...mods },
    );
    return prevented;
  };
  assert.equal(input(), true);
  assert.deepEqual(delivered, ['⇧⌘C']);
  assert.equal(input({ isAutoRepeat: true }), true);
  assert.equal(delivered.length, 1);
  assert.equal(input({ type: 'keyUp' }), false);
  assert.equal(input({ isComposing: true }), true);
  focused = false;
  assert.equal(input(), false);
  focused = true;
  destroyed = true;
  assert.equal(input(), false);
  destroyed = false;
  bindings = { pin: 'A', rename: '⌘Z', 'browser-copy-url': null, 'copy-cwd': null };
  assert.equal(input({ key: 'a', code: 'KeyA', meta: false, shift: false }), false);
  assert.equal(input({ key: 'z', code: 'KeyZ', meta: true, shift: false }), false);
  assert.equal(input(), false);
  assert.equal(input({ key: 'Meta', code: 'MetaLeft', shift: false }), false);
  assert.equal(input({ key: 'ArrowLeft', code: 'ArrowLeft', shift: false, isAutoRepeat: true }), true);
  assert.equal(delivered.at(-1), '⌘ArrowLeft');
  wc.emit('destroyed');
  assert.equal(wc.listenerCount('before-input-event'), 0);
  delete wc.isFocused;
  browserShortcuts(
    wc,
    () => ({}),
    (combo: string) => delivered.push(combo),
    'win32',
  );
  assert.equal(input({ key: 'r', code: 'KeyR', shift: false, meta: false, control: true }), true);
  assert.equal(delivered.at(-1), '⌘R');
});

test('main-window native menus cannot repeat one-shot actions or act during composition', async () => {
  const { blockAppShortcutInput } = createRequire(import.meta.url)('../electron/capabilities/browser/browserShortcuts.cjs');
  const wc = new EventEmitter();
  blockAppShortcutInput(wc, () => ({ pin: 'A' }), 'darwin');
  const input = (mods: any) => {
    let count = 0;
    wc.emit('before-input-event', { preventDefault: () => count++ }, { type: 'keyDown', code: 'KeyW', key: 'w', meta: true, ...mods });
    return count;
  };
  assert.equal(input({}), 0);
  assert.equal(input({ key: 'a', code: 'KeyA', meta: false, isComposing: true }), 0);
  assert.equal(input({ isAutoRepeat: true }), 1);
  assert.equal(input({ isComposing: true }), 1);
  assert.equal(input({ type: 'keyUp', isAutoRepeat: true }), 0);
  assert.equal(input({ code: 'ArrowLeft', key: 'ArrowLeft', meta: false, isAutoRepeat: true }), 0);
  assert.equal(input({ code: 'MetaLeft', key: 'Meta', isAutoRepeat: true }), 0);
  assert.equal(input({ code: 'BracketLeft', key: '[', isAutoRepeat: true }), 0);
});

for (const platform of ['darwin', 'win32', 'linux']) {
  test(`native reload uses the primary modifier on ${platform}`, () => {
    const wc: any = new EventEmitter();
    wc.isDestroyed = () => false;
    const delivered: string[] = [];
    browserShortcuts(
      wc,
      () => ({}),
      (combo: string) => delivered.push(combo),
      platform,
    );
    const input = (meta: boolean, control: boolean) => {
      let prevented = false;
      wc.emit(
        'before-input-event',
        {
          preventDefault: () => {
            prevented = true;
          },
        },
        { type: 'keyDown', key: 'r', code: 'KeyR', meta, control },
      );
      return prevented;
    };
    assert.equal(input(platform !== 'darwin', platform === 'darwin'), false);
    assert.deepEqual(delivered, []);
    assert.equal(input(platform === 'darwin', platform !== 'darwin'), true);
    assert.deepEqual(delivered, ['⌘R']);
    wc.emit('destroyed');
    assert.equal(wc.listenerCount('before-input-event'), 0);
  });
}

test('view and guest pages forward keys only to live owning surfaces', async () => {
  const { setup, FakeWC } = await import('./support/browser-view-fixture.ts');
  const { BrowserWindows } = createRequire(import.meta.url)('../electron/capabilities/browser/windows.cjs');
  const { views } = setup();
  const session = {};
  const view = views.create({ session });
  view.wc.setWindowOpenHandler = () => {};
  const broadcasts: any[] = [];
  const owner: any = new FakeWC();
  const guest: any = new FakeWC();
  guest.session = session;
  guest.hostWebContents = owner;
  guest.getType = () => 'webview';
  guest.setWindowOpenHandler = () => {};
  const policy = new BrowserWindows({
    BrowserWindow: { fromWebContents: () => null },
    appContents: () => [owner],
    panelSession: () => session,
    broadcast: (...args: any[]) => broadcasts.push(args),
  });
  policy.register(view.wc);
  policy.register(guest);
  guest.focus = () => {};
  const popup: any = new FakeWC();
  popup.session = session;
  popup.setWindowOpenHandler = () => {};
  let ignores = false;
  popup.setIgnoreMenuShortcuts = (on: boolean) => {
    ignores = on;
  };
  policy.register(popup, guest);
  assert.equal(ignores, true);
  const reloadInput = {
    type: 'keyDown',
    key: 'r',
    code: 'KeyR',
    meta: process.platform === 'darwin',
    control: process.platform !== 'darwin',
  };
  let popupPrevented = false;
  popup.emit(
    'before-input-event',
    {
      preventDefault: () => {
        popupPrevented = true;
      },
    },
    reloadInput,
  );
  assert.equal(popupPrevented, false);
  assert.equal(owner.sent.length, 0);
  popup.emit('destroyed');
  owner.sent.length = 0;
  const key = (wc: any) => {
    wc.emit('before-input-event', { preventDefault() {} }, { ...reloadInput, key: 'Meta', code: 'MetaLeft' });
    wc.emit('before-input-event', { preventDefault() {} }, reloadInput);
  };
  key(view.wc);
  assert.deepEqual(broadcasts, [
    ['browser:shortcut', { rootId: view.id, combo: '⌘', modifiers: true }],
    ['browser:shortcut', { rootId: view.id, combo: '', modifiers: true }],
    ['browser:shortcut', { rootId: view.id, combo: '⌘R' }],
  ]);
  key(guest);
  assert.deepEqual(owner.sent, [
    ['browser:shortcut', { rootId: guest.id, combo: '⌘', modifiers: true }],
    ['browser:shortcut', { rootId: guest.id, combo: '', modifiers: true }],
    ['browser:shortcut', { rootId: guest.id, combo: '⌘R' }],
  ]);
  owner.destroyed = true;
  key(guest);
  assert.equal(broadcasts.length, 3);
  view.wc.emit('destroyed');
  guest.emit('destroyed');
  const plain = views.create({ session });
  plain.wc.setWindowOpenHandler = () => {};
  const silent = new BrowserWindows({ BrowserWindow: { fromWebContents: () => null }, appContents: () => [], panelSession: () => session });
  silent.register(plain.wc);
  key(plain.wc);
  plain.wc.emit('destroyed');
});

for (const platform of ['darwin', 'win32', 'linux']) {
  test(`browser modifier state on ${platform} reveals, releases, composes and retires without intercepting typing`, () => {
    const wc: any = new EventEmitter();
    wc.isDestroyed = () => false;
    wc.isFocused = () => true;
    const modifiers: string[] = [];
    const commands: string[] = [];
    browserShortcuts(
      wc,
      () => ({}),
      (combo: string) => commands.push(combo),
      platform,
      (combo: string) => modifiers.push(combo),
    );
    const press = (over: any = {}) => {
      let prevented = false;
      wc.emit(
        'before-input-event',
        {
          preventDefault: () => {
            prevented = true;
          },
        },
        {
          type: 'keyDown',
          key: platform === 'darwin' ? 'Meta' : 'Control',
          code: platform === 'darwin' ? 'MetaLeft' : 'ControlLeft',
          meta: platform === 'darwin',
          control: platform !== 'darwin',
          ...over,
        },
      );
      return prevented;
    };
    assert.equal(press(), false);
    assert.equal(press(), false);
    assert.deepEqual(modifiers, ['⌘']);
    assert.deepEqual(commands, []);
    press({ key: 'c', code: 'KeyC' });
    assert.deepEqual(modifiers, ['⌘', ''], 'ordinary editing shortcuts cancel hint metadata');
    press({ type: 'keyUp', key: 'c', code: 'KeyC' });
    assert.deepEqual(modifiers, ['⌘', ''], 'a command key-up cannot restart a modifier hold');
    press({ key: 'r', code: 'KeyR' });
    assert.deepEqual(commands, ['⌘R'], 'native commands still dispatch immediately');
    press();
    press({ type: 'keyUp', meta: false, control: false });
    assert.deepEqual(modifiers.slice(-2), ['⌘', '']);
    press();
    wc.emit('blur');
    assert.deepEqual(modifiers.slice(-2), ['⌘', '']);
    press();
    press({ isComposing: true });
    assert.deepEqual(modifiers.slice(-2), ['⌘', '']);
    press();
    wc.emit('destroyed');
    assert.deepEqual(modifiers.slice(-2), ['⌘', '']);
    assert.equal(wc.listenerCount('blur'), 0);
    assert.equal(wc.listenerCount('before-input-event'), 0);
  });
}
