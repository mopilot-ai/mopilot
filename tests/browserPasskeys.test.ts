import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { tick as flush } from './support/async-scenarios.ts';

const require = createRequire(import.meta.url);
const { watchPasskeys, passkeyWatch, PASSKEY_SIGNAL } = require('../electron/capabilities/browser/passkeys.cjs');
const { BrowserWindows } = require('../electron/capabilities/browser/windows.cjs');
const { browserWorld, fakeDebugger } = require('./helpers/browser.cjs');
const { runBeforePage, framesOf, isEarlyScript, AUTO_ATTACH } = require('../electron/capabilities/browser/documentScripts.cjs');
const { recentIgnored, clearIgnored } = require('../electron/ignored.cjs');

/** A page's navigator.credentials whose requests wait until the test settles them or their signal aborts. */
function credentials() {
  const calls: any[] = [];
  const request = (name: string) =>
    function (this: any, options: any) {
      let settle: any;
      const promise = new Promise((resolve, reject) => {
        settle = { resolve, reject };
        options?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
      calls.push({ name, options, self: this, ...settle });
      return promise;
    };
  return { calls, creds: { get: request('get'), create: request('create') } };
}

/** Runs passkeyWatch as a page would, with this page's navigator and console. */
function inPage(navigator: any, fn: () => Promise<void> | void, PublicKeyCredential?: any) {
  const desc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const debug = console.debug;
  const logs: string[] = [];
  Object.defineProperty(globalThis, 'navigator', { value: navigator, configurable: true, writable: true });
  (globalThis as any).PublicKeyCredential = PublicKeyCredential;
  console.debug = (m: string) => logs.push(m);
  const restore = () => {
    if (desc) Object.defineProperty(globalThis, 'navigator', desc);
    else delete (globalThis as any).navigator;
    delete (globalThis as any).PublicKeyCredential;
    console.debug = debug;
  };
  return Promise.resolve()
    .then(fn)
    .then(
      () => (restore(), logs),
      (e) => {
        restore();
        throw e;
      },
    );
}

test('in the page: modal passkey requests are counted and cancelled as NotAllowedError; others pass through', async () => {
  const { calls, creds } = credentials();
  const key = `__k${Math.random().toString(36).slice(2)}`;
  const logs = await inPage({ credentials: creds }, async () => {
    passkeyWatch(key, PASSKEY_SIGNAL);
    // installed once per document
    const wrappedGet = creds.get;
    passkeyWatch(key, PASSKEY_SIGNAL);
    assert.equal(creds.get, wrappedGet);
    assert.equal(creds.get.name, 'get');

    // passwords and conditional (autofill) passkeys go straight through, uncounted
    const password = creds.get({ password: true });
    const autofill = creds.get({ publicKey: {}, mediation: 'conditional' });
    assert.equal(calls[0].options.password, true);
    assert.equal(calls[1].options.mediation, 'conditional');
    assert.equal(calls[0].self, creds);
    const none = (creds.create as any)();
    assert.equal(calls[2].options, undefined);

    // a modal request: counted, resolves with the authenticator's answer
    const signIn = creds.get({ publicKey: { challenge: 1 } });
    assert.equal(calls[3].self, creds);
    assert.deepEqual(calls[3].options.publicKey, { challenge: 1 });
    calls[3].resolve('credential');
    assert.equal(await signIn, 'credential');

    // the page's own signal still aborts it
    const own = new AbortController();
    const create = creds.create({ publicKey: {}, signal: own.signal });
    own.abort();
    await assert.rejects(create, { name: 'AbortError' });

    // cancelled from main: NotAllowedError, as Chrome's Cancel; the authenticator request is aborted too
    assert.equal((globalThis as any)[key]('name'), '', 'nothing waits: no name');
    const stuck = creds.get({ publicKey: {} });
    const stuck2 = creds.create({ publicKey: {} });
    assert.match((globalThis as any)[key]('name'), /^d[0-9a-z]+$/, 'a document that waits names itself');
    const inner = calls.at(-1).options.signal;
    assert.equal((globalThis as any)[key](), 2);
    await assert.rejects(stuck, { name: 'NotAllowedError' });
    await assert.rejects(stuck2, { name: 'NotAllowedError' });
    assert.equal(inner.aborted, true);
    await flush();
    assert.equal((globalThis as any)[key](), 0);

    // a failed request is reported settled too
    const failing = creds.get({ publicKey: {} });
    calls.at(-1).reject(new DOMException('no', 'NotAllowedError'));
    await assert.rejects(failing, { name: 'NotAllowedError' });
    await flush();
    calls[0].resolve(null);
    calls[1].resolve(null);
    calls[2].resolve(null);
    await Promise.all([password, autofill, none]);
  });
  // every report names the document; a request settles a microtask later, so the next one can start before it is reported gone
  const doc = /^[^:]*?([0-9a-z]+):\d+$/.exec(logs[0].slice(PASSKEY_SIGNAL.length))![1];
  assert.ok(logs.every((l) => l.startsWith(`${PASSKEY_SIGNAL}${doc}:`)));
  assert.deepEqual(
    logs.map((l) => l.replace(`${doc}:`, '')),
    [
      `${PASSKEY_SIGNAL}1`,
      `${PASSKEY_SIGNAL}2`,
      `${PASSKEY_SIGNAL}1`,
      `${PASSKEY_SIGNAL}0`,
      `${PASSKEY_SIGNAL}1`,
      `${PASSKEY_SIGNAL}2`,
      `${PASSKEY_SIGNAL}1`,
      `${PASSKEY_SIGNAL}0`,
      `${PASSKEY_SIGNAL}1`,
      `${PASSKEY_SIGNAL}0`,
    ],
  );
});

test('in the page: no credentials API, or a missing method, installs nothing it cannot wrap', async () => {
  const key = `__k${Math.random().toString(36).slice(2)}`;
  await inPage({}, () => {
    passkeyWatch(key, PASSKEY_SIGNAL);
    assert.equal(Object.hasOwn(globalThis, key), false);
  });
  await inPage(undefined, () => {
    passkeyWatch(key, PASSKEY_SIGNAL);
    assert.equal(Object.hasOwn(globalThis, key), false);
  });
  const creds: any = { get: 'not a function' };
  await inPage({ credentials: creds }, () => {
    passkeyWatch(key, PASSKEY_SIGNAL);
    assert.equal(creds.get, 'not a function');
    assert.equal(Object.hasOwn(creds, 'create'), false);
    assert.equal((globalThis as any)[key](), 0);
  });
});

test('in the page: a document going away with requests pending says so; one with none stays quiet', async () => {
  const { creds } = credentials();
  const listeners: Record<string, () => void> = {};
  (globalThis as any).addEventListener = (type: string, fn: () => void) => (listeners[type] = fn);
  try {
    const logs = await inPage({ credentials: creds }, async () => {
      passkeyWatch(`__k${Math.random().toString(36).slice(2)}`, PASSKEY_SIGNAL);
      listeners.pagehide();
      void creds.get({ publicKey: {} });
      listeners.pagehide();
    });
    assert.equal(logs.length, 2);
    assert.match(logs[0], /:1$/);
    assert.equal(logs[1], logs[0].replace(/:1$/, ':0'));
  } finally {
    delete (globalThis as any).addEventListener;
  }
});

test('in the page: client capabilities stop claiming the phone (hybrid) transport Electron lacks', async () => {
  const reported = (uvpa: boolean) => ({
    getClientCapabilities() {
      return Promise.resolve({
        conditionalGet: true,
        hybridTransport: true,
        passkeyPlatformAuthenticator: true,
        userVerifyingPlatformAuthenticator: uvpa,
        self: this,
      });
    },
  });
  for (const uvpa of [false, true]) {
    const PKC = reported(uvpa);
    await inPage(
      { credentials: credentials().creds },
      async () => {
        passkeyWatch(`__k${Math.random().toString(36).slice(2)}`, PASSKEY_SIGNAL);
        assert.equal(PKC.getClientCapabilities.name, 'getClientCapabilities');
        const caps: any = await PKC.getClientCapabilities();
        assert.equal(caps.hybridTransport, false);
        assert.equal(caps.passkeyPlatformAuthenticator, uvpa);
        assert.equal(caps.conditionalGet, true);
        assert.equal(caps.self, PKC);
      },
      PKC,
    );
  }
  // an older engine without the method is left alone
  const old: any = {};
  await inPage({ credentials: credentials().creds }, () => passkeyWatch(`__k${Math.random().toString(36).slice(2)}`, PASSKEY_SIGNAL), old);
  assert.equal(Object.hasOwn(old, 'getClientCapabilities'), false);
});

/**
 * A webContents whose frames record the scripts run in them: `answer` is what a cancel returns (an Error: the frame
 * went away), `waiting` the document name the frame says still waits ('' for none).
 */
function page() {
  const wc: any = new EventEmitter();
  const frame = (processId: number, routingId: number) => ({
    processId,
    routingId,
    scripts: [] as string[],
    answer: 1 as any,
    waiting: '' as string,
    executeJavaScript(code: string) {
      this.scripts.push(code);
      if (this.answer instanceof Error) return Promise.reject(this.answer);
      return Promise.resolve(code.includes("?.('name')") ? this.waiting : this.answer);
    },
  });
  const main = frame(1, 1);
  const child = frame(1, 2);
  wc.mainFrame = { framesInSubtree: [main, child] };
  wc.debugger = fakeDebugger();
  wc.destroyed = false;
  wc.isDestroyed = () => wc.destroyed;
  return { wc, main, child };
}
const navigate = (wc: any, url: string, isMain: boolean, frame: any) =>
  wc.emit('did-frame-navigate', {}, url, 200, 'OK', isMain, frame.processId, frame.routingId);
const log = (wc: any, frame: any, message: string) => wc.emit('console-message', { message, frame });

test('main: the wrapper goes into each new web document; reports name their document; cancel asks every frame', async () => {
  const { wc, main, child } = page();
  let changes = 0;
  const watch = watchPasskeys(wc, () => changes++);
  // nothing waits: Cancel asks no frame
  assert.equal(await watch.cancel(), 0);
  navigate(wc, 'https://accounts.google.com/', true, main);
  navigate(wc, 'https://frame.test/', false, child);
  navigate(wc, 'about:blank', false, child);
  navigate(wc, 'https://gone.test/', false, { processId: 9, routingId: 9 });
  assert.equal(main.scripts.length, 1);
  assert.equal(child.scripts.length, 1);
  assert.match(main.scripts[0], /^\(function passkeyWatch/);
  assert.ok(main.scripts[0].includes(JSON.stringify(PASSKEY_SIGNAL)));
  // one key per page, in the wrapper, the cancel and the name calls
  const key = /"(__mopilotPasskey_[0-9a-f]+)"/.exec(main.scripts[0])![1];

  // other console output, malformed and old-style reports are ignored
  log(wc, main, 'hello');
  wc.emit('console-message', null);
  log(wc, main, `${PASSKEY_SIGNAL}1`);
  log(wc, main, `${PASSKEY_SIGNAL}doc:x`);
  assert.equal(watch.pending(), false);

  // Electron hands a subframe's report the main frame: the document's name, not the frame, keys it
  log(wc, main, `${PASSKEY_SIGNAL}top:1`);
  log(wc, main, `${PASSKEY_SIGNAL}sub:2`);
  assert.equal(watch.pending(), true);
  assert.equal(changes, 1);
  log(wc, main, `${PASSKEY_SIGNAL}top:0`);
  assert.equal(watch.pending(), true, 'the subframe still waits');
  assert.equal(changes, 1);

  // Cancel asks every frame of the page, whichever reported; the documents still waiting afterwards stay
  main.answer = 0;
  child.answer = 2;
  child.waiting = 'sub';
  assert.equal(await watch.cancel(), 2);
  assert.equal(main.scripts.at(-2), `globalThis[${JSON.stringify(key)}]?.() ?? 0`);
  assert.equal(child.scripts.at(-1), `globalThis[${JSON.stringify(key)}]?.('name') ?? 0`);
  assert.equal(watch.pending(), true, 'its last report is still on its way');
  log(wc, main, `${PASSKEY_SIGNAL}sub:0`);
  assert.equal(watch.pending(), false);
  assert.equal(changes, 2);

  // documents that went without saying so (a frame gone, a cancel that found nothing): nothing waits any more
  log(wc, main, `${PASSKEY_SIGNAL}sub:1`);
  child.answer = new Error('frame gone');
  main.answer = 'x';
  main.waiting = '';
  assert.equal(await watch.cancel(), 0);
  assert.equal(watch.pending(), false);
  assert.equal(changes, 4);

  // a subframe's new document: the old one's requests went with it, though it never said so; others stay
  child.answer = 0;
  child.waiting = '';
  log(wc, main, `${PASSKEY_SIGNAL}top:1`);
  log(wc, main, `${PASSKEY_SIGNAL}sub:1`);
  main.waiting = 'top';
  navigate(wc, 'https://frame.test/next', false, child);
  await flush();
  assert.equal(watch.pending(), true);
  main.waiting = '';
  navigate(wc, 'https://frame.test/again', false, child);
  await flush();
  assert.equal(watch.pending(), false);
  // a report arriving while the frames are asked is kept
  log(wc, main, `${PASSKEY_SIGNAL}top:1`);
  navigate(wc, 'https://frame.test/third', false, child);
  log(wc, main, `${PASSKEY_SIGNAL}late:1`);
  await flush();
  assert.equal(watch.pending(), true);
  // the main frame's new page drops all
  navigate(wc, 'https://accounts.google.com/next', true, main);
  assert.equal(watch.pending(), false);

  // a crashed renderer takes its requests with it
  log(wc, main, `${PASSKEY_SIGNAL}top:1`);
  wc.emit('render-process-gone');
  assert.equal(watch.pending(), false);

  // a subframe navigating with nothing waiting asks nothing
  const asked = main.scripts.length;
  navigate(wc, 'about:blank', false, child);
  await flush();
  assert.equal(main.scripts.length, asked);

  // a failed injection (the frame navigated again) is ignored
  main.answer = new Error('navigated');
  navigate(wc, 'https://accounts.google.com/again', true, main);
  await flush();
  // a page with no frame tree yet
  wc.mainFrame = null;
  navigate(wc, 'https://accounts.google.com/', true, main);
  log(wc, main, `${PASSKEY_SIGNAL}top:1`);
  assert.equal(await watch.cancel(), 0);
  assert.equal(watch.pending(), false);
});

test('browser pages: a passkey wait reaches the pane with the current notice, and the pane can end it', async () => {
  const w = browserWorld();
  const manager = new BrowserWindows(w);
  const frame = {
    processId: 1,
    routingId: 1,
    executeJavaScript: async () => 1,
  };
  w.root.mainFrame = { framesInSubtree: [frame] };
  manager.register(w.root);
  assert.deepEqual(manager.state(w.root.id, w.host)[0], {
    rootId: w.root.id,
    pageId: w.root.id,
    kind: 'ready',
    message: '',
    reason: null,
    origin: '',
    passkey: false,
    dialog: null,
    link: null,
  });
  const notices = () => w.host.calls.filter((c: any) => c[0] === 'browser:event').map((c: any) => c[1]);
  // no notice yet: the wait is shown as ready
  w.root.emit('console-message', { message: `${PASSKEY_SIGNAL}doc:1`, frame });
  assert.equal(notices().at(-1).kind, 'ready');
  assert.equal(notices().at(-1).passkey, true);
  assert.equal(await manager.cancelPasskey(w.root.id, w.host), 1);
  // it keeps the page's own notice when it ends
  w.root.emit('did-navigate');
  w.root.emit('console-message', { message: `${PASSKEY_SIGNAL}doc:0`, frame });
  assert.equal(notices().at(-1).kind, 'navigated');
  assert.equal(notices().at(-1).passkey, false);
  await assert.rejects(async () => manager.cancelPasskey(w.root.id, {}), /another window/);
});

test("main: Use another method doesn't wait on one frame before asking the others", async () => {
  const { wc, main, child } = page();
  const watch = watchPasskeys(wc, () => {});
  log(wc, main, `${PASSKEY_SIGNAL}dkid:1`);
  // the main frame is busy (or held by a dialog) and never answers
  main.executeJavaScript = () => new Promise(() => {});
  void watch.cancel();
  assert.match(String(child.scripts.at(-1)), /\?\.\(\) \?\? 0$/);
});

test('early: a page asking for a passkey as its <head> runs is counted, in every frame, before its own scripts', async () => {
  // the bug: the wrapper went in only after a frame committed, so an inline <head> request ran first and hung uncounted
  const { wc } = page();
  watchPasskeys(wc, () => {});
  const dbg = wc.debugger;
  assert.equal(dbg.attached, true);
  const script = dbg.commands.find((c: any[]) => c[0] === 'Page.addScriptToEvaluateOnNewDocument');
  assert.ok(script, 'the wrapper is a new-document script');
  assert.equal(script[1].runImmediately, true);
  // run as the page's first script, then the page's own <head> script asks for a passkey at once
  const { calls, creds } = credentials();
  const logs = await inPage({ credentials: creds }, () => {
    new Function(script[1].source)();
    void creds.get({ publicKey: { challenge: 1 } });
  });
  assert.equal(calls.length, 1);
  assert.equal(logs.length, 1);
  assert.match(logs[0], new RegExp(`^${PASSKEY_SIGNAL}d[0-9a-z]+:1$`));
});

test('early: the script goes on the page and each out-of-process frame, and comes back when a turn lets go of the debugger', async () => {
  clearIgnored();
  const wc: any = new EventEmitter();
  wc.destroyed = false;
  wc.isDestroyed = () => wc.destroyed;
  const failing = new Set<string>();
  let scriptId = 0;
  wc.debugger = fakeDebugger((method: string) => {
    if (failing.has(method)) throw new Error('target gone');
    return method === 'Page.addScriptToEvaluateOnNewDocument' ? { identifier: String(++scriptId) } : {};
  });
  const dbg = wc.debugger;
  const flushTimers = () => new Promise((r) => setImmediate(r));
  const setupOf = (sessionId?: string) =>
    [
      ['Page.enable', {}, sessionId],
      ['Page.addScriptToEvaluateOnNewDocument', { source: 'S', runImmediately: true }, sessionId],
      ['Target.setAutoAttach', AUTO_ATTACH, sessionId],
    ].map((c) => (sessionId === undefined ? c.slice(0, 2) : c));
  runBeforePage(wc, 'S');
  // once per page
  runBeforePage(wc, 'other');
  assert.deepEqual(dbg.commands, setupOf());
  assert.deepEqual(AUTO_ATTACH, { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  // its script is known as the page's own, so another client can't take it off
  await flush();
  assert.equal(isEarlyScript(wc, '', '1'), true);
  assert.equal(isEarlyScript(wc, '', '2'), false);
  assert.equal(isEarlyScript({}, '', '1'), false);

  // frames in other processes get it in their own session, nested ones too; other targets have no documents
  dbg.commands.length = 0;
  dbg.emit('message', {}, 'Target.attachedToTarget', { sessionId: 'W1', targetInfo: { type: 'worker' } });
  dbg.emit('message', {}, 'Target.attachedToTarget', null);
  dbg.emit('message', {}, 'Target.attachedToTarget', {
    sessionId: 'F1',
    targetInfo: { type: 'iframe', targetId: 'frame-1', url: 'https://a.test/' },
  });
  dbg.emit('message', {}, 'Target.attachedToTarget', { sessionId: 'F2', targetInfo: { type: 'iframe', targetId: 'frame-2' } }, 'F1');
  assert.deepEqual(dbg.commands, [...setupOf('F1'), ...setupOf('F2')]);
  await flush();
  assert.equal(isEarlyScript(wc, 'F2', '3'), true);
  // each session's own document is followed (not the page's, nor frames inside the session, nor sessions it doesn't know)
  dbg.emit('message', {}, 'Page.frameNavigated', { frame: { id: 'frame-2', url: 'https://b.test/' } }, 'F2');
  dbg.emit('message', {}, 'Page.frameNavigated', { frame: { id: 'x', parentId: 'frame-2', url: 'https://c.test/' } }, 'F2');
  dbg.emit('message', {}, 'Page.frameNavigated', { frame: { id: 'main', url: 'https://top.test/' } });
  dbg.emit('message', {}, 'Page.frameNavigated', null, 'F1');
  // a tab or the Browser plugin joining later learns of them here (CDP reports them only once)
  assert.deepEqual(framesOf(wc), [
    { sessionId: 'F1', parent: '', targetId: 'frame-1', url: 'https://a.test/' },
    { sessionId: 'F2', parent: 'F1', targetId: 'frame-2', url: 'https://b.test/' },
  ]);
  assert.deepEqual(framesOf({}), []);
  dbg.emit('message', {}, 'Target.detachedFromTarget', { sessionId: 'F2' });
  dbg.emit('message', {}, 'Target.detachedFromTarget', null);
  assert.deepEqual(
    framesOf(wc).map((f: any) => f.sessionId),
    ['F1'],
  );

  // a frame that goes before it is set up is noted, not thrown
  failing.add('Page.enable');
  dbg.emit('message', {}, 'Target.attachedToTarget', { sessionId: 'F3', targetInfo: { type: 'iframe', targetId: 'frame-3' } });
  await flush();
  assert.ok(recentIgnored().some((e: any) => e.message === 'target gone'));
  failing.clear();

  // an agent's turn ends (tab.cjs detaches): the page's sessions and scripts went with the debugger, so they go back on
  dbg.commands.length = 0;
  dbg.detach();
  assert.equal(dbg.attached, false);
  assert.deepEqual(framesOf(wc), []);
  assert.equal(isEarlyScript(wc, '', '1'), false);
  await flushTimers();
  assert.equal(dbg.attached, true);
  assert.deepEqual(dbg.commands, setupOf());
  assert.deepEqual(framesOf(wc), []);

  // another client attached again first (a tab in the same tick): shared, not attached twice, and the frames it was
  // told of meanwhile are kept
  dbg.commands.length = 0;
  dbg.emit('detach');
  dbg.emit('message', {}, 'Target.attachedToTarget', { sessionId: 'F4', targetInfo: { type: 'iframe', targetId: 'frame-4' } });
  dbg.commands.length = 0;
  await flushTimers();
  assert.deepEqual(dbg.commands, setupOf());
  assert.deepEqual(
    framesOf(wc).map((f: any) => f.sessionId),
    ['F4'],
  );

  // it can't be attached: noted, and the frames are still covered once they commit (did-frame-navigate)
  dbg.commands.length = 0;
  dbg.attached = false;
  dbg.attach = () => {
    throw new Error('attached elsewhere');
  };
  dbg.emit('detach');
  await flushTimers();
  assert.deepEqual(dbg.commands, []);
  assert.ok(recentIgnored().some((e: any) => e.message === 'attached elsewhere'));

  // a closed page is left alone
  wc.destroyed = true;
  dbg.emit('detach');
  await flushTimers();
  assert.deepEqual(dbg.commands, []);
});
