// The foreign-frame Chrome repro fixture waits for an explicit attached-debugger trigger rather than elapsed time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { Window } from 'happy-dom';
import { dismissForeignFrame, injectForeignFrame } from './e2e/fixtures/foreignFrame.mjs';

const source = fs.readFileSync(new URL('./e2e/fixtures/frame-extension/content.js', import.meta.url), 'utf8');
for (const login of [false, true]) {
  test(`the frame injector ${login ? 'waits until triggered and injects once' : 'ignores pages without a login form'}`, async () => {
    const win = new Window();
    if (login) win.document.body.innerHTML = '<input type="password">';
    win.document.dispatchEvent(new win.Event('mopilot-test-frame'));
    // the frame sits in a closed shadow root, which the page guard cannot reach: keep the roots the fixture makes
    const roots: { mode: string; root: any }[] = [];
    const attachShadow = win.Element.prototype.attachShadow;
    win.Element.prototype.attachShadow = function (this: any, init: { mode: string }) {
      const root = attachShadow.call(this, init);
      roots.push({ mode: init.mode, root });
      return root;
    };
    const timers: Function[] = [];
    vm.runInNewContext(
      source,
      {
        document: win.document,
        chrome: { runtime: { getURL: (file: string) => `chrome-extension://fixture/${file}` } },
        setTimeout: (f: Function) => timers.push(f),
      },
      { filename: fileURLToPath(new URL('./e2e/fixtures/frame-extension/content.js', import.meta.url)) },
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(timers.length, 0, 'elapsed time must never trigger the repro before attachment');
    assert.equal(roots.length, 0);
    assert.equal(win.document.documentElement.dataset.mopilotFrameReady, login ? 'true' : undefined);
    for (let i = 0; i < 2; i++) win.document.dispatchEvent(new win.Event('mopilot-test-frame'));
    assert.equal(roots.length, login ? 1 : 0);
    assert.equal(win.document.querySelectorAll('iframe').length, 0, 'not in the open tree');
    if (login) {
      assert.equal(roots[0].mode, 'closed');
      assert.equal(roots[0].root.querySelector('iframe')?.src, 'chrome-extension://fixture/frame.html');
      // the menu the journey dismisses by id is the host in the open tree; removing it takes the frame with it
      assert.equal(win.document.getElementById('injected-menu')?.tagName, 'DIV');
      assert.equal(dismissForeignFrame(win.document as any), true);
      assert.equal(win.document.getElementById('injected-menu'), null);
    }
    win.happyDOM.abort();
  });
}

test('readiness can arrive arbitrarily late; only an attached exact tab can trigger, and a trigger rejection still requires the caller to check the native event', async () => {
  const calls: any[] = [];
  let tabs: any[] = [];
  let result: any = undefined;
  let failRead = false;
  let failTrigger = false;
  let triggerResult: any = { result: { value: true } };
  const chrome = {
    tabs: { query: async () => tabs },
    debugger: {
      sendCommand: async (target: any, _method: string, args: any) => {
        calls.push([target, args.expression]);
        if (args.expression === 'document.documentElement.dataset.mopilotFrameReady') {
          if (failRead) throw new Error('not attached');
          return result;
        }
        if (failTrigger) throw new Error('detached while handling command');
        return triggerResult;
      },
    },
  };
  const url = 'http://127.0.0.1:123/login';
  assert.equal(await injectForeignFrame(url, chrome), null);
  tabs = [{ id: 1, url: `${url}#other` }];
  assert.equal(await injectForeignFrame(url, chrome), null);
  tabs = [
    { id: 2, url },
    { id: 3, url },
  ];
  assert.equal(await injectForeignFrame(url, chrome), null);
  tabs = [{ id: 2, url }];
  for (const value of [undefined, {}, { result: {} }, { result: { value: false } }]) {
    result = value;
    assert.equal(await injectForeignFrame(url, chrome), null);
  }
  failRead = true;
  assert.equal(await injectForeignFrame(url, chrome), null);
  assert.ok(calls.every(([, expression]) => expression.includes('dataset')));
  failRead = false;
  result = { result: { value: 'true' } };
  assert.deepEqual(await injectForeignFrame(url, chrome), { tabId: 2, triggerError: '', eventOffset: 0 });
  for (const value of [undefined, {}, { result: {} }, { result: { value: false } }]) {
    triggerResult = value;
    assert.equal(await injectForeignFrame(url, chrome), null, 'a replaced unready document never counts as fired');
  }
  Object.defineProperty(globalThis, '__detached', { configurable: true, value: [{}, {}] });
  triggerResult = { result: { value: true } };
  try {
    assert.equal((await injectForeignFrame(url, chrome))?.eventOffset, 2);
  } finally {
    Reflect.deleteProperty(globalThis, '__detached');
  }
  failTrigger = true;
  assert.deepEqual(await injectForeignFrame(url, chrome), {
    tabId: 2,
    triggerError: 'Error: detached while handling command',
    eventOffset: 0,
  });
  assert.deepEqual(calls.at(-1)[0], { tabId: 2 });
  chrome.tabs.query = async () => {
    throw new Error('transport gone');
  };
  await assert.rejects(injectForeignFrame(url, chrome), /transport gone/);
});

test('the same helper runs directly in an extension page without dynamic evaluation', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
  Object.defineProperty(globalThis, 'chrome', { configurable: true, value: { tabs: { query: async () => [] } } });
  try {
    const copy = vm.runInNewContext(`(${injectForeignFrame.toString()})`, { chrome: (globalThis as any).chrome });
    assert.equal(await copy('http://127.0.0.1/login'), null);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'chrome', previous);
    else Reflect.deleteProperty(globalThis, 'chrome');
  }
});

test('dismissing the owned injector closes its menu without changing page state or unrelated frames', async () => {
  const { dismissForeignFrame } = await import('./e2e/fixtures/foreignFrame.mjs');
  const win = new Window();
  win.document.body.innerHTML = '<input value="unsaved"><iframe id="unrelated"></iframe><iframe id="injected-menu"></iframe>';
  win.document.querySelector('input')!.value = 'User changed this';
  assert.equal(dismissForeignFrame(win.document), true);
  assert.equal(dismissForeignFrame(win.document), false);
  assert.equal(win.document.querySelector('input')!.value, 'User changed this');
  assert.ok(win.document.getElementById('unrelated'));
  const document = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: win.document });
  const frame = win.document.createElement('iframe');
  frame.id = 'injected-menu';
  win.document.body.append(frame);
  try {
    assert.equal(dismissForeignFrame(), true);
    assert.equal(dismissForeignFrame(), false);
  } finally {
    if (document) Object.defineProperty(globalThis, 'document', document);
    else Reflect.deleteProperty(globalThis, 'document');
  }
  await win.happyDOM.close();
});
