// One built-in browser page's road to macOS's passkey sheet (passkeyBridge.cjs): where a call came from (CDP, never the
// page), which frames may use the sheet, answers only to that origin's frames, and what closes the sheet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { tick as flush } from './support/async-scenarios.ts';

const require = createRequire(import.meta.url);
const { createPasskeyBridge, framePath } = require('../electron/capabilities/browser/passkeyBridge.cjs');
const { fakeDebugger } = require('./helpers/browser.cjs');
const { recentIgnored, clearIgnored } = require('../electron/ignored.cjs');

const ORIGIN = 'https://login.example.com';
const b64u = (s: string) => ({ b64u: Buffer.from(s).toString('base64url') });

/** A page with two frames of one origin and one of another, a debugger, and a fake app-wide module. */
function bridgeWorld({ tree, policy, caps = { platform: true, securityKey: true } }: any = {}) {
  const wc: any = new EventEmitter();
  const frame = (origin: string) => ({
    origin,
    scripts: [] as string[],
    fail: false,
    executeJavaScript(code: string) {
      this.scripts.push(code);
      return this.fail ? Promise.reject(new Error('gone')) : Promise.resolve(true);
    },
  });
  const top = frame(ORIGIN);
  const same = frame(ORIGIN);
  const other = frame('https://ads.test');
  wc.mainFrame = { framesInSubtree: [top, same, other] };
  wc.destroyed = false;
  wc.isDestroyed = () => wc.destroyed;
  const world: any = { tree, policy, onEnable: null };
  wc.debugger = fakeDebugger((method: string) => {
    if (method === 'Page.getFrameTree') {
      if (world.tree instanceof Error) throw world.tree;
      return {
        frameTree: world.tree ?? {
          frame: { id: 'F1', securityOrigin: ORIGIN },
          childFrames: [{ frame: { id: 'F2', securityOrigin: ORIGIN } }],
        },
      };
    }
    if (method === 'Page.getPermissionsPolicyState')
      return world.policy ?? { states: [{ feature: 'publickey-credentials-get', allowed: true }] };
    if (method === 'Runtime.enable') world.onEnable?.();
    return {};
  });
  const win = {
    destroyed: false,
    visible: true,
    minimized: false,
    isDestroyed: () => win.destroyed,
    isVisible: () => win.visible,
    isMinimized: () => win.minimized,
    getNativeWindowHandle: () => Buffer.from('nsview'),
  };
  const runs: any[] = [];
  const system: any = {
    caps: () => world.caps,
    legacy: () => world.legacy ?? false,
    anchor: () => world.win,
    run(request: any, handle: any, timeout: number) {
      if (world.busy) return { busy: true };
      let resolve: any;
      const answer = new Promise((r) => (resolve = r));
      const run = { request, handle, timeout, resolve, cancelled: 0, answer, cancel: () => run.cancelled++ };
      runs.push(run);
      return run;
    },
  };
  world.caps = caps;
  world.win = win;
  let changes = 0;
  const bridge = createPasskeyBridge(wc, { key: '__k', binding: '__b', system, onChange: () => changes++ });
  const context = (id: number, origin = ORIGIN, frameId = 'F2', isDefault = true) =>
    wc.debugger.emit('message', {}, 'Runtime.executionContextCreated', { context: { id, origin, auxData: { frameId, isDefault } } });
  const call = (ctx: number, msg: any, name = '__b') =>
    wc.debugger.emit('message', {}, 'Runtime.bindingCalled', {
      name,
      executionContextId: ctx,
      payload: typeof msg === 'string' ? msg : JSON.stringify(msg),
    });
  const settled = (f: any) => f.scripts.map((s: string) => JSON.parse(`[${/'settle', (.*)\)$/.exec(s)![1]}]`));
  return { wc, top, same, other, win, runs, system, world, bridge, context, call, settled, changes: () => changes };
}

const getOptions = { challenge: b64u('challenge-0123456789'), rpId: 'example.com' };

test('bridge: arms its binding only where the sheet is offered', () => {
  const w = bridgeWorld();
  const sent: any[] = [];
  w.bridge.arm((m: string, p?: any) => sent.push([m, p]));
  // no Runtime.enable until a page asks: bot checks look for it
  assert.deepEqual(sent, [['Runtime.addBinding', { name: '__b' }]]);
  assert.deepEqual(w.bridge.offers(), { systemPasskeys: true, legacyPasskeys: false });
  w.world.legacy = true;
  assert.deepEqual(w.bridge.offers(), { systemPasskeys: true, legacyPasskeys: true });
  w.world.caps = null;
  const none: any[] = [];
  w.bridge.arm((m: string) => none.push(m));
  assert.deepEqual(none, []);
  assert.deepEqual(w.bridge.offers(), { systemPasskeys: false, legacyPasskeys: false });
});

test('bridge: a request from a same-origin frame goes to the sheet; its answer reaches that origin’s frames only', async () => {
  const w = bridgeWorld();
  w.context(7);
  w.call(7, { type: 'request', id: 'req00001', kind: 'get', options: getOptions });
  await flush();
  assert.equal(w.runs.length, 1);
  assert.equal(w.runs[0].request.rpId, 'example.com');
  assert.equal(w.runs[0].request.origin, ORIGIN, 'the origin is the frame’s, from CDP');
  assert.deepEqual(w.runs[0].handle, Buffer.from('nsview'));
  assert.equal(w.bridge.active(), true);
  assert.equal(w.changes(), 1);
  // a replay of the same id is ignored
  w.call(7, { type: 'request', id: 'req00001', kind: 'get', options: getOptions });
  await flush();
  assert.equal(w.runs.length, 1);
  w.runs[0].resolve({ ok: false, code: 1001 });
  await flush();
  assert.equal(w.bridge.active(), false);
  assert.equal(w.changes(), 2);
  // the sheet coming up is said first (the wrapper then waits for the user), then the answer
  assert.deepEqual(w.settled(w.top), [
    ['req00001', { ack: true }],
    ['req00001', { error: { name: 'NotAllowedError', message: 'The operation either timed out or was not allowed.' } }],
  ]);
  assert.equal(w.same.scripts.length, 2);
  assert.equal(w.other.scripts.length, 0, 'another site’s frame never sees an answer');
  assert.match(w.top.scripts[0], /^globalThis\["__k"\]\?\.\('settle', "req00001", /);
});

test('bridge: what it doesn’t serve goes back to Electron’s own path', async () => {
  const cases: [string, (w: any) => void, any?][] = [
    ['the sheet is not offered', (w) => (w.world.caps = null)],
    ['an isolated world', (w) => w.context(8, ORIGIN, 'F2', false)],
    [
      'a frame under another origin',
      (w) =>
        (w.world.tree = {
          frame: { id: 'F1', securityOrigin: 'https://shell.test' },
          childFrames: [{ frame: { id: 'F2', securityOrigin: ORIGIN } }],
        }),
    ],
    ['a frame not in the tree', (w) => (w.world.tree = { frame: { id: 'F1', securityOrigin: ORIGIN } })],
    ['no tree', (w) => (w.world.tree = {})],
    ['the tree can’t be read', (w) => (w.world.tree = new Error('detached'))],
    ['a policy that denies it', (w) => (w.world.policy = { states: [{ feature: 'publickey-credentials-get', allowed: false }] })],
    ['malformed options', (w) => {}, { challenge: 'x' }],
    ['another site’s RP ID', (w) => {}, { ...getOptions, rpId: 'evil.test' }],
  ];
  for (const [name, setup, options] of cases) {
    const w = bridgeWorld();
    w.context(7);
    setup(w);
    w.call(name === 'an isolated world' ? 8 : 7, { type: 'request', id: 'req00002', kind: 'get', options: options ?? getOptions });
    await flush();
    assert.equal(w.runs.length, 0, name);
    assert.deepEqual(w.settled(w.top), [['req00002', { fallback: true }]], name);
    assert.equal(w.other.scripts.length, 0, name);
  }
  // a policy that says nothing of the feature leaves its default ('self'), which a same-origin chain meets
  const w = bridgeWorld({ policy: { states: [] } });
  w.context(7);
  w.call(7, {
    type: 'request',
    id: 'req00003',
    kind: 'create',
    options: { challenge: b64u('c'), rp: {}, user: { id: b64u('u'), name: 'n' }, pubKeyCredParams: [] },
  });
  await flush();
  assert.equal(w.runs.length, 1);
  assert.equal(w.runs[0].request.kind, 'create');
  // the policy can't be read at all: not served
  const unread = bridgeWorld({ policy: null });
  unread.wc.debugger.sendCommand = async (m: string) => {
    if (m === 'Page.getPermissionsPolicyState') throw new Error('no');
    return { frameTree: { frame: { id: 'F2', securityOrigin: ORIGIN } } };
  };
  unread.context(7);
  unread.call(7, { type: 'request', id: 'req00004', kind: 'get', options: getOptions });
  await flush();
  assert.deepEqual(unread.settled(unread.top), [['req00004', { fallback: true }]]);
});

test('bridge: a page that isn’t showing, or a sheet already up, is refused at once', async () => {
  for (const [name, setup] of [
    ['parked', (w: any) => (w.world.win = null)],
    ['closed', (w: any) => (w.win.destroyed = true)],
    ['hidden', (w: any) => (w.win.visible = false)],
    ['minimized', (w: any) => (w.win.minimized = true)],
    ['busy', (w: any) => (w.world.busy = true)],
  ] as const) {
    const w = bridgeWorld();
    setup(w);
    w.context(7);
    w.call(7, { type: 'request', id: 'req00005', kind: 'get', options: getOptions });
    await flush();
    assert.equal(w.runs.length, 0, name);
    assert.equal(w.settled(w.top)[0][1].error.name, 'NotAllowedError', name);
  }
});

test('bridge: a call from a context it never heard of asks CDP again, else falls back in every frame', async () => {
  const w = bridgeWorld();
  w.world.onEnable = () => w.context(9);
  w.call(9, { type: 'request', id: 'req00006', kind: 'get', options: getOptions });
  await flush();
  assert.equal(w.runs.length, 1, 'Runtime.enable reported it');
  const lost = bridgeWorld();
  lost.call(4, { type: 'request', id: 'req00007', kind: 'get', options: getOptions });
  await flush();
  // a fallback tells no secret: every frame may have it, and only the wrapper holding the id takes it
  for (const f of [lost.top, lost.same, lost.other]) assert.deepEqual(lost.settled(f), [['req00007', { fallback: true }]]);
  // Runtime.enable failing is noted
  clearIgnored();
  const failing = bridgeWorld();
  failing.wc.debugger.sendCommand = async () => {
    throw new Error('detached');
  };
  failing.call(4, { type: 'abort', id: 'req00008' });
  await flush();
  assert.ok(recentIgnored().some((e: any) => /list the contexts/.test(e.context)));
});

test('bridge: malformed binding calls, other bindings and frame sessions are ignored', async () => {
  const w = bridgeWorld();
  w.context(7);
  for (const payload of [
    '{',
    'null',
    JSON.stringify({ id: 'x' }),
    JSON.stringify({ id: 'BAD ID!!' }),
    JSON.stringify({ type: 'other', id: 'req00009' }),
    'x'.repeat(256 * 1024 + 1),
  ])
    w.call(7, payload);
  w.wc.debugger.emit('message', {}, 'Runtime.bindingCalled', { name: '__b', executionContextId: 7, payload: 5 });
  w.call(7, { type: 'request', id: 'req00010', kind: 'get', options: getOptions }, 'otherBinding');
  w.wc.debugger.emit(
    'message',
    {},
    'Runtime.bindingCalled',
    { name: '__b', executionContextId: 7, payload: JSON.stringify({ type: 'request', id: 'req00011' }) },
    'frame-session',
  );
  w.wc.debugger.emit('message', {}, 'Runtime.executionContextCreated', {});
  w.wc.debugger.emit('message', {}, 'Runtime.executionContextCreated', { context: { id: 8 } });
  await flush();
  assert.equal(w.runs.length, 0);
  assert.equal(w.top.scripts.length, 0);
});

test('bridge: an abort from the same origin closes the sheet; one from elsewhere does not', async () => {
  const w = bridgeWorld();
  w.context(7);
  w.context(8, 'https://ads.test', 'F3');
  w.call(7, { type: 'request', id: 'req00012', kind: 'get', options: getOptions });
  await flush();
  w.call(8, { type: 'abort', id: 'req00012' });
  w.call(7, { type: 'abort', id: 'unknown1' });
  await flush();
  assert.equal(w.runs[0].cancelled, 0);
  w.call(7, { type: 'abort', id: 'req00012' });
  await flush();
  assert.equal(w.runs[0].cancelled, 1);
});

test('bridge: a document, renderer or page that goes closes its sheet; a debugger detach does not', async () => {
  const w = bridgeWorld();
  w.context(7);
  w.context(8);
  w.call(7, { type: 'request', id: 'req00013', kind: 'get', options: getOptions });
  w.call(8, { type: 'request', id: 'req00014', kind: 'get', options: getOptions });
  await flush();
  assert.equal(w.runs.length, 2);
  // a turn letting go of the debugger: requests go on (answers don't need CDP), contexts are reported again
  w.wc.debugger.emit('detach');
  assert.deepEqual(
    w.runs.map((r: any) => r.cancelled),
    [0, 0],
  );
  w.context(7);
  w.context(8);
  w.wc.debugger.emit('message', {}, 'Runtime.executionContextDestroyed', { executionContextId: 7 });
  assert.deepEqual(
    w.runs.map((r: any) => r.cancelled),
    [1, 0],
  );
  w.wc.debugger.emit('message', {}, 'Runtime.executionContextsCleared', {});
  assert.deepEqual(
    w.runs.map((r: any) => r.cancelled),
    [2, 1],
  );
  w.wc.emit('render-process-gone');
  w.wc.emit('destroyed');
  assert.deepEqual(
    w.runs.map((r: any) => r.cancelled),
    [4, 3],
  );
  // the page is gone: the answer goes nowhere
  w.wc.destroyed = true;
  const said = w.top.scripts.length;
  w.runs[0].resolve({ ok: false });
  await flush();
  assert.equal(w.top.scripts.length, said);
});

test('bridge: a context that goes while main reads the frames falls back', async () => {
  const w = bridgeWorld();
  const send = w.wc.debugger.sendCommand;
  w.wc.debugger.sendCommand = async (m: string, p: any) => {
    if (m === 'Page.getPermissionsPolicyState')
      w.wc.debugger.emit('message', {}, 'Runtime.executionContextDestroyed', { executionContextId: 7 });
    return send(m, p);
  };
  w.context(7);
  w.call(7, { type: 'request', id: 'req00015', kind: 'get', options: getOptions });
  await flush();
  assert.equal(w.runs.length, 0);
  assert.deepEqual(w.settled(w.top), [['req00015', { fallback: true }]]);
});

test('bridge: the pane’s cancel closes the sheet; its legacy choice sends the page to Electron’s own passkey', async () => {
  const w = bridgeWorld();
  w.context(7);
  assert.equal(w.bridge.cancel(), 0);
  // a request main is still looking into has no sheet to close
  w.call(7, { type: 'request', id: 'req00021', kind: 'get', options: { challenge: 'bad' } });
  assert.equal(w.bridge.cancel(), 0);
  await flush();
  w.call(7, { type: 'request', id: 'req00016', kind: 'get', options: getOptions });
  w.call(7, { type: 'request', id: 'req00017', kind: 'get', options: { challenge: 'bad' } });
  await flush();
  assert.equal(w.bridge.cancel(), 1, 'only a request at the sheet');
  assert.equal(w.runs[0].cancelled, 1);
  assert.equal(w.bridge.cancel({ legacy: true }), 1);
  assert.deepEqual(w.settled(w.top).at(-1), ['req00016', { fallback: true }]);
  assert.equal(w.bridge.active(), false);
  // macOS's answer to the closed sheet then changes nothing
  w.runs[0].resolve({ ok: false, code: 1001 });
  await flush();
  assert.deepEqual(
    w.settled(w.top).filter((s: any) => s[0] === 'req00016'),
    [
      ['req00016', { ack: true }],
      ['req00016', { fallback: true }],
    ],
  );
});

test('bridge: a frame that fails to take its answer, and a request that throws, are noted', async () => {
  clearIgnored();
  const w = bridgeWorld();
  w.top.fail = true;
  w.context(7);
  w.call(7, { type: 'request', id: 'req00018', kind: 'get', options: { challenge: 'bad' } });
  await flush();
  assert.ok(recentIgnored().some((e: any) => /answer a passkey request/.test(e.context)));
  w.system.anchor = () => {
    throw new Error('no window');
  };
  w.call(7, { type: 'request', id: 'req00019', kind: 'get', options: getOptions });
  await flush();
  assert.ok(recentIgnored().some((e: any) => /serve a passkey request/.test(e.context)));
  // a page with no frame tree yet answers no frame
  const bare = bridgeWorld();
  bare.wc.mainFrame = null;
  bare.call(3, { type: 'request', id: 'req00020', kind: 'get', options: getOptions });
  await flush();
});

test('frame path: root to frame, or null', () => {
  const tree = { frame: { id: 'a' }, childFrames: [{ frame: { id: 'b' }, childFrames: [{ frame: { id: 'c' } }] }, { frame: { id: 'd' } }] };
  assert.deepEqual(
    framePath(tree, 'c').map((f: any) => f.id),
    ['a', 'b', 'c'],
  );
  assert.deepEqual(
    framePath(tree, 'd').map((f: any) => f.id),
    ['a', 'd'],
  );
  assert.equal(framePath(tree, 'z'), null);
  assert.equal(framePath(null, 'a'), null);
});
