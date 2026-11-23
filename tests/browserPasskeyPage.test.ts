// The page side of macOS's passkey sheet in the built-in browser: the wrapper's road to the bridge (passkeys.cjs with a
// binding), the codec that carries options there and builds the PublicKeyCredential back (passkeyCodec.cjs), the
// page's notice state and the pane's legacy choice (watchPasskeys, BrowserWindows), and the binding's arm on each
// debugger attach (documentScripts.cjs onRoot).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { tick as flush } from './support/async-scenarios.ts';
// the page event's passkey fields (types only)
import '../src/lib/native/contracts/browser.ts';

const require = createRequire(import.meta.url);
const { passkeyWatch, watchPasskeys, PASSKEY_SIGNAL } = require('../electron/capabilities/browser/passkeys.cjs');
const { passkeyCodec } = require('../electron/capabilities/browser/passkeyCodec.cjs');
const { runBeforePage } = require('../electron/capabilities/browser/documentScripts.cjs');
const { BrowserWindows } = require('../electron/capabilities/browser/windows.cjs');
const { browserWorld, fakeDebugger } = require('./helpers/browser.cjs');

const u8 = (s: string) => new Uint8Array(Buffer.from(s));
const text = (buf: ArrayBuffer) => Buffer.from(buf).toString();

test('codec: options become JSON with bytes as base64url; functions, signals and deep nesting go', () => {
  const { encode } = passkeyCodec(globalThis);
  const big = new Uint8Array(70_000).fill(65);
  const deep: any = {};
  let at = deep;
  for (let i = 0; i < 10; i++) at = at.next = {};
  const out = encode({
    challenge: u8('hi').buffer,
    user: { id: u8('user'), name: 'n', run: () => 1 },
    list: [new DataView(u8('dv').buffer, 0, 2)],
    signal: new AbortController().signal,
    big,
    deep,
    n: 5,
    none: null,
  });
  assert.deepEqual(out.challenge, { b64u: Buffer.from('hi').toString('base64url') });
  assert.deepEqual(out.user, { id: { b64u: Buffer.from('user').toString('base64url') }, name: 'n', run: undefined });
  assert.deepEqual(out.list, [{ b64u: Buffer.from('dv').toString('base64url') }]);
  assert.equal(Buffer.from(out.big.b64u, 'base64url').length, 70_000);
  assert.equal('signal' in out, false);
  assert.equal(out.n, 5);
  assert.equal(out.none, null);
  assert.equal(JSON.stringify(out.deep).match(/next/g)!.length, 5, 'nesting past six levels is cut');
  assert.deepEqual(encode(Array(300).fill(1)).length, 256);
});

/** Stand-ins for the page's WebAuthn classes, so instanceof can be checked. */
function webauthnGlobals() {
  class PublicKeyCredential {}
  class AuthenticatorAttestationResponse {}
  class AuthenticatorAssertionResponse {}
  return {
    ...globalThis,
    btoa,
    atob,
    String,
    Uint8Array,
    ArrayBuffer,
    Array,
    Object,
    PublicKeyCredential,
    AuthenticatorAttestationResponse,
    AuthenticatorAssertionResponse,
  };
}

const bu = (s: string) => Buffer.from(s).toString('base64url');

test('codec: a registration becomes a PublicKeyCredential with its response methods and toJSON', () => {
  const G: any = webauthnGlobals();
  const { toCredential } = passkeyCodec(G);
  const c = toCredential({
    id: bu('cred'),
    authenticatorAttachment: 'platform',
    response: {
      clientDataJSON: bu('cd'),
      attestationObject: bu('ao'),
      authenticatorData: bu('ad'),
      transports: ['internal'],
      publicKey: bu('spki'),
      publicKeyAlgorithm: -7,
    },
  });
  assert.ok(c instanceof G.PublicKeyCredential);
  assert.ok(c.response instanceof G.AuthenticatorAttestationResponse);
  assert.equal(c.id, bu('cred'));
  assert.equal(text(c.rawId), 'cred');
  assert.equal(c.type, 'public-key');
  assert.equal(c.authenticatorAttachment, 'platform');
  assert.equal(text(c.response.clientDataJSON), 'cd');
  assert.equal(text(c.response.attestationObject), 'ao');
  assert.equal(text(c.response.getAuthenticatorData()), 'ad');
  assert.equal(text(c.response.getPublicKey()), 'spki');
  assert.equal(c.response.getPublicKeyAlgorithm(), -7);
  const transports = c.response.getTransports();
  transports.push('x');
  assert.deepEqual(c.response.getTransports(), ['internal'], 'a copy each time');
  assert.deepEqual(c.getClientExtensionResults(), {});
  assert.deepEqual(Object.keys(c), ['id', 'rawId', 'type', 'authenticatorAttachment', 'response']);
  assert.deepEqual(c.toJSON(), {
    id: bu('cred'),
    rawId: bu('cred'),
    type: 'public-key',
    authenticatorAttachment: 'platform',
    response: {
      clientDataJSON: bu('cd'),
      attestationObject: bu('ao'),
      authenticatorData: bu('ad'),
      transports: ['internal'],
      publicKey: bu('spki'),
      publicKeyAlgorithm: -7,
    },
    clientExtensionResults: {},
  });
  // no key or transports given: null and none
  const bare = toCredential({
    id: bu('c'),
    authenticatorAttachment: 'cross-platform',
    response: { clientDataJSON: bu('cd'), attestationObject: bu('ao'), authenticatorData: bu('ad') },
  });
  assert.equal(bare.response.getPublicKey(), null);
  assert.deepEqual(bare.response.getTransports(), []);
});

test('codec: an assertion becomes a PublicKeyCredential, also in an engine without the WebAuthn classes', () => {
  const G: any = webauthnGlobals();
  const assertion = {
    id: bu('cred'),
    authenticatorAttachment: 'cross-platform',
    response: { clientDataJSON: bu('cd'), authenticatorData: bu('ad'), signature: bu('sig'), userHandle: bu('user') },
  };
  const c = passkeyCodec(G).toCredential(assertion);
  assert.ok(c.response instanceof G.AuthenticatorAssertionResponse);
  assert.equal(text(c.response.signature), 'sig');
  assert.equal(text(c.response.userHandle), 'user');
  assert.equal(text(c.response.authenticatorData), 'ad');
  assert.deepEqual(c.toJSON().response, {
    clientDataJSON: bu('cd'),
    authenticatorData: bu('ad'),
    signature: bu('sig'),
    userHandle: bu('user'),
  });
  const plain = passkeyCodec({ ...G, PublicKeyCredential: undefined, AuthenticatorAssertionResponse: undefined }).toCredential({
    ...assertion,
    response: { ...assertion.response, userHandle: undefined },
  });
  assert.equal(Object.getPrototypeOf(plain), Object.prototype);
  assert.equal(plain.response.userHandle, null);
  assert.equal(plain.toJSON().response.userHandle, null);
});

/** Runs passkeyWatch with a bridge binding in this process, as a page would. */
async function withBridge(fn: (t: { key: string; sent: any[]; calls: any[]; creds: any }) => Promise<void>, ackWait?: number) {
  const key = `__k${Math.random().toString(36).slice(2)}`;
  const binding = `__b${Math.random().toString(36).slice(2)}`;
  const sent: any[] = [];
  const calls: any[] = [];
  const request = (name: string) =>
    function (options: any) {
      return new Promise((resolve, reject) => {
        calls.push({ name, options, resolve });
        if (options?.signal?.aborted) reject(new DOMException('aborted', 'AbortError'));
        options?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    };
  const creds = { get: request('get'), create: request('create') };
  const desc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const debug = console.debug;
  Object.defineProperty(globalThis, 'navigator', { value: { credentials: creds }, configurable: true, writable: true });
  console.debug = () => {};
  (globalThis as any)[binding] = (json: string) => sent.push(JSON.parse(json));
  (globalThis as any).PublicKeyCredential = {
    getClientCapabilities: async () => ({ hybridTransport: true, userVerifyingPlatformAuthenticator: false }),
  };
  try {
    passkeyWatch(key, PASSKEY_SIGNAL, binding, passkeyCodec, ackWait);
    await fn({ key, sent, calls, creds });
  } finally {
    if (desc) Object.defineProperty(globalThis, 'navigator', desc);
    else delete (globalThis as any).navigator;
    delete (globalThis as any)[binding];
    delete (globalThis as any).PublicKeyCredential;
    console.debug = debug;
  }
}

test('in the page: a modal request goes to the bridge; its answer settles it once', async () => {
  await withBridge(async ({ key, sent, calls, creds }) => {
    const G: any = globalThis;
    // the sheet offers the phone (hybrid) transport and passkeys
    const caps = await G.PublicKeyCredential.getClientCapabilities();
    assert.deepEqual([caps.hybridTransport, caps.passkeyPlatformAuthenticator], [true, true]);

    const signIn = creds.get({ publicKey: { challenge: u8('c'), rpId: 'example.com' } });
    assert.equal(calls.length, 0, 'Electron’s path is not asked');
    assert.equal(sent[0].type, 'request');
    assert.equal(sent[0].kind, 'get');
    assert.match(sent[0].id, /^[0-9a-z]{8,24}$/);
    assert.deepEqual(sent[0].options, { challenge: { b64u: bu('c') }, rpId: 'example.com' });
    assert.equal(G[key]('settle', 'unknown', {}), false);
    const credential = {
      id: bu('cred'),
      authenticatorAttachment: 'platform',
      response: { clientDataJSON: bu('cd'), authenticatorData: bu('ad'), signature: bu('s'), userHandle: null },
    };
    assert.equal(G[key]('settle', sent[0].id, { credential }), true);
    assert.equal(G[key]('settle', sent[0].id, { credential }), false, 'once');
    assert.equal((await signIn).id, bu('cred'));
    // the page's signal aborting after the answer says nothing more to the bridge
    const own = new AbortController();
    const answered = creds.get({ publicKey: { challenge: u8('c') }, signal: own.signal });
    G[key]('settle', sent.at(-1).id, { credential });
    await answered;
    const said = sent.length;
    own.abort();
    assert.equal(sent.length, said);

    // an error from the sheet rejects with its DOMException
    const failing = creds.create({ publicKey: { challenge: u8('c') } });
    G[key]('settle', sent.at(-1).id, { error: { name: 'InvalidStateError', message: 'already registered' } });
    await assert.rejects(failing, { name: 'InvalidStateError', message: 'already registered' });

    // fallback: Electron's own path, with the page's options and the wrapper's signal
    const fallback = creds.get({ publicKey: { challenge: u8('c') } });
    G[key]('settle', sent.at(-1).id, { fallback: true });
    await flush();
    assert.equal(calls.length, 1);
    assert.ok(calls[0].options.signal instanceof AbortSignal);
    calls[0].resolve('from electron');
    assert.equal(await fallback, 'from electron');
  });
});

test('in the page: an abort from the page or from the pane tells the bridge and rejects', async () => {
  await withBridge(async ({ key, sent, creds }) => {
    const G: any = globalThis;
    const own = new AbortController();
    const mine = creds.get({ publicKey: { challenge: u8('c') }, signal: own.signal });
    own.abort();
    await assert.rejects(mine, { name: 'AbortError' });
    assert.deepEqual(sent.at(-1), { id: sent[0].id, type: 'abort' });
    // an answer after the abort finds no request
    assert.equal(G[key]('settle', sent[0].id, { fallback: true }), false);

    // the pane's Use another method: Chrome's Cancel, and the sheet is closed
    const stuck = creds.get({ publicKey: { challenge: u8('c') } });
    assert.equal(G[key](), 1);
    await assert.rejects(stuck, { name: 'NotAllowedError' });
    assert.equal(sent.at(-1).type, 'abort');
    const n = sent.length;
    // the abort reached the request after its answer: nothing more is said
    const settled = creds.get({ publicKey: { challenge: u8('c') } });
    G[key]('settle', sent.at(-1).id, { error: { name: 'NotAllowedError', message: 'no' } });
    await assert.rejects(settled);
    assert.equal(G[key](), 0);
    assert.equal(sent.length, n + 1);

    // a signal already aborted never reaches the bridge
    const gone = new AbortController();
    gone.abort();
    await assert.rejects(creds.get({ publicKey: {}, signal: gone.signal }), { name: 'AbortError' });
    assert.equal(sent.length, n + 1);
  });
});

test('in the page: a request the bridge never answers takes Electron’s path; an ack makes it wait for the user', async () => {
  await withBridge(async ({ key, sent, calls, creds }) => {
    const G: any = globalThis;
    // unheard (a turn let go of the debugger as it was sent): Electron's own path, not a hang
    const unheard = creds.get({ publicKey: { challenge: u8('c') } });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(calls.length, 1);
    calls[0].resolve('electron');
    assert.equal(await unheard, 'electron');
    assert.equal(G[key]('settle', sent[0].id, { fallback: true }), false, 'its id is gone');
    // the sheet came up: the wrapper waits as long as the user takes
    const heard = creds.get({ publicKey: { challenge: u8('c') } });
    assert.equal(G[key]('settle', sent[1].id, { ack: true }), true);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(calls.length, 1);
    // what isn't an answer is ignored
    assert.equal(G[key]('settle', sent[1].id, null), false);
    assert.equal(G[key]('settle', sent[1].id, 'x'), false);
    G[key]('settle', sent[1].id, { error: { name: 'NotAllowedError', message: 'cancelled' } });
    await assert.rejects(heard, { name: 'NotAllowedError' });
    // ids are 24 random base-36 characters
    assert.ok(sent.every((m: any) => /^[0-9a-z]{24}$/.test(m.id)));
  }, 10);
});

test('in the page: an abort with no reason rejects with AbortError', async () => {
  await withBridge(async ({ creds }) => {
    const signal = new EventTarget() as any;
    signal.aborted = false;
    signal.reason = undefined;
    const stop = new AbortController();
    const any = AbortSignal.any;
    AbortSignal.any = () => signal;
    try {
      const p = creds.get({ publicKey: { challenge: u8('c') }, signal: stop.signal });
      signal.dispatchEvent(new Event('abort'));
      await assert.rejects(p, { name: 'AbortError' });
    } finally {
      AbortSignal.any = any;
    }
  });
});

/** A page with a debugger whose frames record scripts. */
function page() {
  const wc: any = new EventEmitter();
  const frame = {
    processId: 1,
    routingId: 1,
    origin: 'https://example.com',
    scripts: [] as string[],
    executeJavaScript: async (s: string) => (frame.scripts.push(s), 0),
  };
  wc.mainFrame = { framesInSubtree: [frame] };
  wc.debugger = fakeDebugger();
  wc.isDestroyed = () => false;
  return { wc, frame };
}

test('main: the page’s source carries the bridge’s binding and codec; notice and the legacy cancel reach the bridge', async () => {
  const { wc, frame } = page();
  const watch = watchPasskeys(wc, () => {});
  wc.emit('did-frame-navigate', {}, 'https://example.com/', 200, 'OK', true, 1, 1);
  assert.match(frame.scripts[0], /"__mopilotPasskeyBridge_[0-9a-f]+", function passkeyCodec\(G\)/);
  assert.deepEqual(watch.notice(), { passkey: false, passkeySystem: false, systemPasskeys: false, legacyPasskeys: false });
  // nothing at the sheet: the legacy choice ends nothing, and the plain cancel asks no frame
  assert.equal(await watch.cancel({ legacy: true }), 0);
  assert.equal(await watch.cancel(), 0);
  assert.equal(frame.scripts.length, 1);
});

test('documents: onRoot runs on the page’s own session at every arm', () => {
  const wc: any = new EventEmitter();
  wc.debugger = fakeDebugger();
  wc.isDestroyed = () => false;
  const arms: any[] = [];
  runBeforePage(wc, 'S', (send: any) => {
    arms.push(send);
    void send('Runtime.addBinding', { name: 'b' });
    void send('Runtime.enable');
  });
  assert.equal(arms.length, 1);
  assert.deepEqual(wc.debugger.commands.slice(-2), [
    ['Runtime.addBinding', { name: 'b' }],
    ['Runtime.enable', {}],
  ]);
  wc.debugger.detach();
  return new Promise<void>((resolve) =>
    setImmediate(() => {
      assert.equal(arms.length, 2, 'armed again after a turn lets go');
      resolve();
    }),
  );
});

test('browser pages: the pane’s legacy choice reaches the page; a notice carries the passkey offers', async () => {
  const w = browserWorld();
  const manager = new BrowserWindows(w);
  w.root.mainFrame = { framesInSubtree: [] };
  manager.register(w.root);
  w.root.emit('did-navigate');
  const notice = w.host.calls.filter((c: any) => c[0] === 'browser:event').at(-1)[1];
  assert.deepEqual([notice.passkey, notice.passkeySystem, notice.systemPasskeys, notice.legacyPasskeys], [false, false, false, false]);
  assert.equal(await manager.cancelPasskey(w.root.id, w.host, true), 0);
  assert.equal(await manager.cancelPasskey(w.root.id, w.host, 'yes'), 0, 'only true asks for the legacy path');
});

test('main: the legacy choice keeps the page at "finish in the passkey window" until its request ends', async () => {
  const { configureSystemPasskeys } = require('../electron/capabilities/browser/systemPasskeys.cjs');
  const starts: any[] = [];
  const win = { isDestroyed: () => false, isVisible: () => true, isMinimized: () => false, getNativeWindowHandle: () => Buffer.from('v') };
  configureSystemPasskeys({
    load: () => ({
      available: () => ({ entitlement: true, platform: true, securityKey: true }),
      start: (json: string, _w: any, cb: any) => starts.push({ json, cb }),
      cancel: () => starts.at(-1).cb(JSON.stringify({ ok: false, code: 1001 })),
    }),
    enabled: () => true,
    legacy: () => true,
    anchor: () => win,
  });
  const { wc, frame } = page();
  wc.debugger = fakeDebugger((method: string) =>
    method === 'Page.getFrameTree'
      ? { frameTree: { frame: { id: 'F', securityOrigin: 'https://example.com' } } }
      : method === 'Page.getPermissionsPolicyState'
        ? { states: [] }
        : {},
  );
  let changes = 0;
  const watch = watchPasskeys(wc, () => changes++);
  assert.deepEqual(watch.notice(), { passkey: false, passkeySystem: false, systemPasskeys: true, legacyPasskeys: true });
  // the binding is armed on the page's own session, without Runtime.enable
  assert.ok(wc.debugger.commands.some((c: any[]) => c[0] === 'Runtime.addBinding'));
  assert.equal(
    wc.debugger.commands.some((c: any[]) => c[0] === 'Runtime.enable'),
    false,
  );
  const binding = wc.debugger.commands.find((c: any[]) => c[0] === 'Runtime.addBinding')[1].name;
  wc.debugger.emit('message', {}, 'Runtime.executionContextCreated', {
    context: { id: 1, origin: 'https://example.com', auxData: { frameId: 'F', isDefault: true } },
  });
  wc.debugger.emit('message', {}, 'Runtime.bindingCalled', {
    name: binding,
    executionContextId: 1,
    payload: JSON.stringify({ type: 'request', id: 'abcdefghij', kind: 'get', options: { challenge: { b64u: 'Y2hhbGxlbmdl' } } }),
  });
  await flush();
  wc.emit('console-message', { message: `${PASSKEY_SIGNAL}doc:1`, frame });
  assert.equal(starts.length, 1);
  assert.equal(watch.notice().passkeySystem, true);
  const before = changes;
  assert.equal(await watch.cancel({ legacy: true }), 1);
  assert.equal(changes, before + 1, 'one refresh, already with the legacy state');
  // the sheet closed, but the page now waits on Electron's Touch ID prompt: still "finish in the passkey window"
  assert.deepEqual(watch.notice(), { passkey: true, passkeySystem: true, systemPasskeys: true, legacyPasskeys: true });
  wc.emit('console-message', { message: `${PASSKEY_SIGNAL}doc:0`, frame });
  assert.deepEqual(watch.notice(), { passkey: false, passkeySystem: false, systemPasskeys: true, legacyPasskeys: true });
  // the plain cancel closes the sheet too
  wc.debugger.emit('message', {}, 'Runtime.bindingCalled', {
    name: binding,
    executionContextId: 1,
    payload: JSON.stringify({ type: 'request', id: 'abcdefghik', kind: 'get', options: { challenge: { b64u: 'Y2hhbGxlbmdl' } } }),
  });
  await flush();
  assert.equal(starts.length, 2);
  assert.equal(await watch.cancel(), 0);
  await flush();
  assert.equal(watch.notice().passkeySystem, false);
});
