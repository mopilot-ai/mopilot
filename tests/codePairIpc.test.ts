// The IPC of this Mac's side of pairing by a code (electron/app/ipc/codePair.cjs): bound to the calling document, off with the flag, an honest "cannot ask yet" without a service, nothing but a well-formed offer id of the caller's own offer passed on, events only while the flag is on and wired once a service exists, and a page that goes away cancels its offers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { register, UNAVAILABLE } = require('../electron/app/ipc/codePair.cjs');

const OFFER = `r_${'a'.repeat(22)}`;

/** A fake page: what main sends it, and whether it is gone. */
const page = () => ({
  sent: [] as any[],
  gone: false,
  send(c: string, p: unknown) {
    this.sent.push([c, p]);
  },
  isDestroyed() {
    return this.gone;
  },
});

function world(o: { flag?: () => boolean; live?: any } = {}) {
  const handlers = new Map<string, (...a: any[]) => any>();
  let retire: (owner: string) => void = () => undefined;
  const live = o.live ?? {};
  const pages: Record<string, ReturnType<typeof page>> = { 'doc-a': page(), 'doc-b': page() };
  register({ handle: (c: string, fn: any) => handlers.set(c, fn) } as any, {
    live,
    flagOn: o.flag ?? (() => true),
    windows: {
      owner: (_e: unknown, token: unknown) => {
        if (token !== 'doc-a' && token !== 'doc-b') throw new Error('This voice input belongs to an earlier page.');
        return token as string;
      },
      onRetire: (fn: any) => (retire = fn),
    },
  });
  return {
    call: (c: string, token: string, p?: unknown) => handlers.get(`codePair:${c}`)!({ sender: pages[token] }, token, p),
    pages,
    retire: (o2: string) => retire(o2),
    live,
  };
}

function service() {
  const asked: any[] = [];
  let push: (e: unknown) => void = () => undefined;
  const s: any = {
    status: () => ({ approval: { available: true }, connections: true, offers: [] }),
    onEvent: (cb: any) => (push = cb),
    setup: async (...a: unknown[]) => (asked.push(['setup', a.length]), { enrolled: true, weak: false }),
    offer: async (...a: unknown[]) => (asked.push(['offer', a.length]), { offerId: OFFER, code: 'ABCD-EFGH', expiresAt: 1 }),
  };
  for (const n of ['allow', 'deny', 'cancel']) s[n] = async (p: unknown) => (asked.push([n, p]), { ok: n });
  return { s, asked, push: (e: unknown) => push(e) };
}

test('a call from an earlier page is refused before anything runs', async () => {
  const w = world();
  await assert.rejects(w.call('status', 'stale'), /This page changed\. Open Settings › Connections again/);
  await assert.rejects(w.call('offer', 'stale'), /This page changed/);
});

test('the flag off: actions are off and status says it cannot ask; no service: the same reason for every action', async () => {
  const off = world({ flag: () => false, live: { codePairHost: service().s } });
  assert.deepEqual(await off.call('status', 'doc-a'), UNAVAILABLE);
  for (const c of ['setup', 'offer', 'allow', 'deny', 'cancel'])
    assert.deepEqual(await off.call(c, 'doc-a', { offerId: OFFER }), { error: { code: 'off' } });
  const none = world();
  assert.deepEqual(await none.call('status', 'doc-a'), UNAVAILABLE);
  assert.deepEqual(await none.call('offer', 'doc-a'), { error: { code: 'no_approval_helper' } });
});

test('setup and offer take nothing from the page; allow, deny and cancel only a well-formed id of the caller’s own offer', async () => {
  const { s, asked } = service();
  const w = world({ live: { codePairHost: s } });
  await w.call('setup', 'doc-a', { evil: true });
  await w.call('offer', 'doc-a', { relayUrl: 'http://evil' });
  assert.deepEqual(asked, [
    ['setup', 0],
    ['offer', 0],
  ]);
  for (const bad of [undefined, {}, { offerId: 'nope' }, { offerId: OFFER.slice(0, -1) }])
    assert.deepEqual(await w.call('allow', 'doc-a', bad), { error: { code: 'no_such_offer' } });
  assert.deepEqual(await w.call('allow', 'doc-b', { offerId: OFFER }), { error: { code: 'no_such_offer' } }, 'another page’s offer');
  assert.deepEqual(await w.call('deny', 'doc-a', { offerId: OFFER, extra: 1 }), { ok: 'deny' });
  assert.deepEqual(asked.at(-1), ['deny', { offerId: OFFER }]);
});

test('events: wired once a service appears, sent only to the page that made the offer and only while the flag is on; an ended offer is forgotten', async () => {
  let flag = true;
  const live: any = {};
  const w = world({ flag: () => flag, live });
  assert.deepEqual(await w.call('status', 'doc-a'), UNAVAILABLE);
  const svc = service();
  live.codePairHost = svc.s;
  await w.call('offer', 'doc-a');
  svc.push({ offerId: OFFER, phase: 'confirm', name: 'Studio', safety: '1' });
  assert.deepEqual(w.pages['doc-a'].sent, [['codePair:event', { offerId: OFFER, phase: 'confirm', name: 'Studio', safety: '1' }]]);
  assert.deepEqual(w.pages['doc-b'].sent, [], 'another page never hears the name or the number');
  flag = false;
  svc.push({ offerId: OFFER, phase: 'connecting' });
  assert.equal(w.pages['doc-a'].sent.length, 1, 'nothing while the flag is off');
  flag = true;
  svc.push({ offerId: 'r_unknown_offer_xxxxxxxx', phase: 'waiting' });
  w.pages['doc-a'].gone = true;
  svc.push({ offerId: OFFER, phase: 'waiting' });
  assert.equal(w.pages['doc-a'].sent.length, 1, 'an unknown offer or a page that is gone hears nothing');
  svc.push({ offerId: OFFER, phase: 'done' });
  assert.deepEqual(await w.call('cancel', 'doc-a', { offerId: OFFER }), { error: { code: 'no_such_offer' } }, 'an ended offer is gone');
});

test('a page that goes away cancels its offers, and an offer that comes back after its page left is cancelled at once', async () => {
  const svc = service();
  const w = world({ live: { codePairHost: svc.s } });
  await w.call('offer', 'doc-a');
  w.retire('doc-a');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(svc.asked.at(-1), ['cancel', { offerId: OFFER }]);
  let finish: (v: unknown) => void = () => undefined;
  svc.s.offer = () => new Promise((r) => (finish = r));
  const pending = w.call('offer', 'doc-b');
  await new Promise((r) => setImmediate(r));
  w.retire('doc-b');
  finish({ offerId: OFFER, code: 'X', expiresAt: 1 });
  assert.deepEqual(await pending, { error: { code: 'cancelled' } });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(svc.asked.at(-1), ['cancel', { offerId: OFFER }]);
});

test('one real lease registry: Mobile Remote’s retire and pairing by code’s both run when a page goes away (never one slot)', async () => {
  const { createSpeechWindows } = require('../electron/platform/speechWindows.cjs');
  const windows = createSpeechWindows();
  const heard: string[] = [];
  const offRemote = windows.onRetire((owner: string) => heard.push(`remote:${owner}`));
  const svc = service();
  const handlers = new Map<string, (...a: any[]) => any>();
  register({ handle: (c: string, fn: any) => handlers.set(c, fn) } as any, { live: { codePairHost: svc.s }, flagOn: () => true, windows });
  const listeners: Record<string, (...a: any[]) => void> = {};
  const sender: any = {
    isDestroyed: () => false,
    on: (n: string, f: any) => (listeners[n] = f),
    once: (n: string, f: any) => (listeners[n] = f),
    send: () => undefined,
  };
  sender.mainFrame = { detached: false };
  const event = { sender, senderFrame: sender.mainFrame };
  const token = windows.open(event);
  await handlers.get('codePair:offer')!(event, token);
  listeners['render-process-gone']();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(heard, [`remote:${token}`]);
  assert.deepEqual(svc.asked.at(-1), ['cancel', { offerId: OFFER }], 'and pairing by code cancelled its offer');
  // a listener that throws does not keep the others from hearing
  const offThrow = windows.onRetire(() => {
    throw new Error('broken listener');
  });
  const second = windows.open(event);
  listeners['render-process-gone']();
  assert.deepEqual(heard, [`remote:${token}`, `remote:${second}`]);
  offThrow();
  offRemote();
  const again = windows.open(event);
  listeners['render-process-gone']();
  assert.equal(heard.length, 2, 'a removed listener is not called');
  void again;
});

test('the defaults: the real flag and the shared lease registry, whose stale token is said in this feature’s words', async () => {
  const handlers = new Map<string, (...a: any[]) => any>();
  const ons = new Map<string, (...a: any[]) => any>();
  register({ handle: (c: string, fn: any) => handlers.set(c, fn), on: (c: string, fn: any) => ons.set(c, fn) } as any, { live: {} });
  const sender: any = { isDestroyed: () => false, on: () => undefined, once: () => undefined };
  sender.mainFrame = {};
  await assert.rejects(handlers.get('codePair:status')!({ sender, senderFrame: sender.mainFrame }, 'no-such-token'), /This page changed/);
  // with a page that is known, the real flag decides; it is off unless the build turns it on
  const known = new Map<string, (...a: any[]) => any>();
  register({ handle: (c: string, fn: any) => known.set(c, fn), on: () => undefined } as any, {
    live: { codePairHost: { status: () => 'served' } },
    windows: { owner: () => 'doc' },
  });
  const said = await known.get('codePair:status')!({ sender }, 't');
  const { isEnabled } = require('../electron/platform/flags.cjs');
  assert.deepEqual(said, isEnabled('host.codePair') ? 'served' : UNAVAILABLE);
});

test('a service’s status is passed on; an offer it refuses is answered as it is; a page’s offers are cancelled and another page’s are not', async () => {
  const svc = service();
  const w = world({ live: { codePairHost: svc.s } });
  assert.deepEqual(await w.call('status', 'doc-a'), { approval: { available: true }, connections: true, offers: [] });
  svc.s.offer = async () => ({ error: { code: 'connections_off' } });
  assert.deepEqual(await w.call('offer', 'doc-a'), { error: { code: 'connections_off' } });
  let n = 0;
  svc.s.offer = async () => ({ offerId: `r_${String(n++).padStart(22, 'b')}`, code: 'X', expiresAt: 1 });
  await w.call('offer', 'doc-a');
  await w.call('offer', 'doc-b');
  w.retire('doc-a');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(
    svc.asked.filter((a: any) => a[0] === 'cancel').map((a: any) => a[1].offerId),
    [`r_${'0'.padStart(22, 'b')}`],
  );
});

test('resetting approval passes nothing from the page, says unsupported for a service without it, and is off with the flag', async () => {
  const svc = service();
  const said: unknown[] = [];
  svc.s.resetApproval = async (...a: unknown[]) => (said.push(a.length), { reset: true, controllers: 2 });
  const w = world({ live: { codePairHost: svc.s } });
  assert.deepEqual(await w.call('resetApproval', 'doc-a', { controllers: 'all' }), { reset: true, controllers: 2 });
  assert.deepEqual(said, [0]);
  delete svc.s.resetApproval;
  assert.deepEqual(await w.call('resetApproval', 'doc-a'), { error: { code: 'unsupported' } });
  const off = world({ flag: () => false, live: { codePairHost: svc.s } });
  assert.deepEqual(await off.call('resetApproval', 'doc-a'), { error: { code: 'off' } });
});
