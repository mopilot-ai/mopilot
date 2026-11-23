// passkeys browser control matrix cases using shared fake surfaces.
import { test, assert, EventEmitter, createRequire, watchPasskeys, PASSKEY_SIGNAL } from './fixture.ts';

export function registerPasskeys() {
  /* ====================================================================== */
  /* In-app browser: a passkey request made as the page loads (CM-B11)       */
  /* ====================================================================== */

  test("CM-B11: a passkey request a page makes as its <head> runs, in any frame, is counted before the page's own scripts: the pane shows the passkey notice, and Use another method ends it with NotAllowedError, whichever harness the chat runs on", async () => {
    const req = createRequire(import.meta.url);
    const vm = req('node:vm');
    const { BrowserWindows } = req('../../../electron/capabilities/browser/windows.cjs');
    const { browserWorld } = req('../../helpers/browser.cjs');
    const { PASSKEY_SIGNAL } = req('../../../electron/capabilities/browser/passkeys.cjs');
    // the notice and its actions are main's, keyed by the page: no harness is involved, so every chat gets the same
    const w = browserWorld();
    const manager = new BrowserWindows(w);
    // no authenticator answers here: a request waits until its signal aborts it
    const wait = (o: any) =>
      new Promise((_resolve, reject) => o.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
    /** A frame's own JavaScript world; its console reaches main as `reportsAs` (Electron: its process's root frame). */
    const realm = (processId: number, routingId: number, reportsAs?: any) => {
      const logs: string[] = [];
      const frame: any = { processId, routingId, frameTreeNodeId: processId * 10 + routingId, logs };
      const context = vm.createContext({
        navigator: { credentials: { get: wait, create: wait } },
        console: {
          debug: (m: string) => {
            logs.push(m);
            w.root.emit('console-message', { message: m, frame: reportsAs ?? frame });
          },
        },
        AbortController,
        AbortSignal,
        DOMException,
      });
      frame.run = (code: string) => vm.runInContext(code, context);
      frame.executeJavaScript = async (code: string) => vm.runInContext(code, context);
      return frame;
    };
    const top = realm(1, 1);
    // <iframe src="/early">: same origin, same process as the page
    const same = realm(1, 2, top);
    // a frame of another site, in its own process
    const cross = realm(2, 1);
    w.root.mainFrame = { framesInSubtree: [top, same, cross] };
    manager.register(w.root);
    const dbg = w.root.debugger;
    const sources = () =>
      w.root.calls.filter((c: any[]) => c[0] === 'Page.addScriptToEvaluateOnNewDocument').map((c: any[]) => c[1].source);
    assert.equal(sources().length, 1, 'the wrapper is on the page before any document loads');
    // the out-of-process frame attaches as it starts loading: the wrapper goes into its session too
    dbg.emit('message', {}, 'Target.attachedToTarget', { sessionId: 'F1', targetInfo: { type: 'iframe', targetId: 'f1' } });
    await new Promise((r) => setImmediate(r));
    assert.equal(sources().length, 2);
    const notices = () => w.host.calls.filter((c: any) => c[0] === 'browser:event').map((c: any) => c[1]);
    // each document runs the wrapper first, then its own <head> script asks for a passkey at once
    top.run(sources()[0]);
    same.run(sources()[0]);
    cross.run(sources()[1]);
    const early = same.run('navigator.credentials.get({ publicKey: { challenge: 1 } })');
    const far = cross.run('navigator.credentials.get({ publicKey: { challenge: 1 } })');
    assert.equal(notices().at(-1).passkey, true);
    // the page's own request settling doesn't hide the frames' (their reports reach main as the same frame)
    const own = top.run('navigator.credentials.create({ publicKey: {}, signal: (globalThis.ac = new AbortController()).signal })');
    top.run('ac.abort()');
    await assert.rejects(own, { name: 'AbortError' });
    await new Promise((r) => setImmediate(r));
    assert.equal(notices().at(-1).passkey, true);
    // Use another method: the site gets Chrome's Cancel in every frame and offers its other ways in
    assert.equal(await manager.cancelPasskey(w.root.id, w.host), 2);
    await assert.rejects(early, { name: 'NotAllowedError' });
    await assert.rejects(far, { name: 'NotAllowedError' });
    await new Promise((r) => setImmediate(r));
    assert.equal(notices().at(-1).passkey, false);
    assert.match(same.logs.at(-1), new RegExp(`^${PASSKEY_SIGNAL}\\w+:0$`));
  });
}

export function registerSubframePasskeys() {
  test('CM-B27: a passkey request in a subframe is ended by "Use another method", whichever frame Electron says it came from', async () => {
    // Electron 44 gives a same-process subframe's console message the main frame (seen in the benchmark VM)
    const wc: any = new EventEmitter();
    wc.debugger = createRequire(import.meta.url)('../../helpers/browser.cjs').fakeDebugger();
    wc.isDestroyed = () => false;
    const calls: string[] = [];
    const frame = (name: string, answer: number) => ({
      processId: 1,
      routingId: name === 'main' ? 1 : 2,
      executeJavaScript: async (code: string) => {
        const what = code.startsWith('(function') ? 'watch' : code.includes("?.('name')") ? 'name' : 'cancel';
        calls.push(`${name}:${what}`);
        // after the cancel, nothing waits any more
        return what === 'name' ? '' : answer;
      },
    });
    const main = frame('main', 0);
    const sub = frame('sub', 1);
    wc.mainFrame = { framesInSubtree: [main, sub] };
    let changes = 0;
    const watch = watchPasskeys(wc, () => changes++);
    wc.emit('did-frame-navigate', {}, 'https://accounts.google.com/', 200, 'OK', true, 1, 1);
    wc.emit('did-frame-navigate', {}, 'https://accounts.google.com/frame', 200, 'OK', false, 1, 2);
    // the subframe's report, attributed to the main frame
    wc.emit('console-message', { message: `${PASSKEY_SIGNAL}subdoc:1`, frame: main });
    assert.equal(watch.pending(), true);
    assert.equal(await watch.cancel(), 1, 'the subframe ended its request');
    assert.deepEqual(calls, ['main:watch', 'sub:watch', 'main:cancel', 'sub:cancel', 'main:name', 'sub:name']);
    assert.equal(watch.pending(), false);
    assert.equal(changes, 2);
    // its own report of the end changes nothing more
    wc.emit('console-message', { message: `${PASSKEY_SIGNAL}subdoc:0`, frame: main });
    assert.equal(changes, 2);
  });
}
