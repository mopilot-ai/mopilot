// Add by command on the relay (relay/src/boot.mjs, #2709), over real HTTP: a host lane registers a boot id (at most 5 per account);
// the script is served once and the bundle at most 3 times, each proxied live from the lane; an app that is away, a command that
// expired or was used, an app that does not answer, a refusal and a response past its cap each end in a one-line shell message
// (the script) or a status (the bundle); a lane that goes ends what it was asked; only the lane that registered a boot ends it.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../relay/src/config.mjs';
import { createVerifier } from '../relay/src/auth.mjs';
import { createRelay } from '../relay/src/server.mjs';
import { createBoots, sayScript, SAY, PENDING, BUNDLE_TIMES, MAX_SCRIPT } from '../relay/src/boot.mjs';
import { laneOf } from '../relay/src/hosts.mjs';
import { makeDb, makeKeys, makeHub, settle, FakeSocket } from './support/relayKit.ts';
import { waitFor } from './support/waitFor.ts';

const keys = await makeKeys();
const { db, reset } = await makeDb();
const BOOT = `b_${'A'.repeat(22)}`;
const HOST = 'h_host0000000000001';
const lane = (did = 'mac1', userId = 'u1') => laneOf({ userId, deviceId: did, kind: 'desktop', expMs: Date.UTC(2031, 0, 1) });

async function rig() {
  await reset();
  const r = makeHub(db);
  const connect = async (identity: any) => {
    const socket = new FakeSocket();
    const h = r.hub.connect(socket as any, identity);
    await settle(r.hub);
    const say = async (m: object) => {
      h.message(JSON.stringify(m));
      await settle(r.hub);
    };
    return { socket, h, say };
  };
  return { ...r, connect };
}

test('a lane registers a boot; bad ids, a taken id, the per-account cap and other kinds are refused; only its lane ends it', async () => {
  const r = await rig();
  const app = await r.connect(lane());
  await app.say({ t: 'host.boot', boot: BOOT, host: HOST, rid: 'b' });
  assert.deepEqual(app.socket.last(), { t: 'ok', op: 'host.boot', boot: BOOT, rid: 'b' });
  await app.say({ t: 'host.boot', boot: BOOT, host: HOST });
  assert.equal(app.socket.last().code, 'boot_exists');
  await app.say({ t: 'host.boot', boot: 'b_short', host: HOST });
  assert.equal(app.socket.last().code, 'bad_message');
  await app.say({ t: 'host.boot', boot: `b_${'B'.repeat(22)}`, host: 'h_bad' });
  assert.equal(app.socket.last().code, 'bad_message');
  for (let i = 1; i < PENDING; i++) await app.say({ t: 'host.boot', boot: `b_${String(i).repeat(22)}`, host: HOST });
  await app.say({ t: 'host.boot', boot: `b_${'Z'.repeat(22)}`, host: HOST });
  assert.equal(app.socket.last().code, 'boot_limit');
  assert.equal(r.hub.boots.size, PENDING);
  // another lane cannot end this one's boot; its own lane can
  const other = await r.connect(lane('mac2', 'u2'));
  await other.say({ t: 'host.unboot', boot: BOOT, rid: 'u' });
  assert.equal(r.hub.boots.size, PENDING);
  await app.say({ t: 'host.unboot', boot: BOOT });
  await app.say({ t: 'host.unboot', boot: 7 });
  assert.equal(r.hub.boots.size, PENDING - 1);
  // a desktop on the phone lane cannot register one; a boot.data from it is ignored
  const desk = await r.connect({ userId: 'u1', deviceId: 'd9', kind: 'desktop', expMs: Date.UTC(2031, 0, 1) });
  await desk.say({ t: 'host.boot', boot: `b_${'Q'.repeat(22)}`, host: HOST });
  assert.equal(desk.socket.last().code, 'forbidden');
  await desk.say({ t: 'boot.data', req: 'x', data: '' });
  // boots expire with the clock
  r.clock.advance(16 * 60_000);
  assert.equal(r.hub.boots.size, 0);
});

test('over HTTP: the script and the bundle are proxied from the lane, once and three times; every other answer is a message', async () => {
  await reset();
  const config = loadConfig({ AUTH_PUBLIC_KEY: keys.publicPem, DATABASE_URL: 'postgres://unused' });
  const relay = createRelay({
    config,
    db: db as any,
    verifier: createVerifier({ ...config.auth, publicKeyPem: keys.publicPem }),
    send: null,
  });
  const port = await relay.listen(0, '127.0.0.1');
  after(() => relay.close());
  const base = `http://127.0.0.1:${port}`;
  const WebSocket = (await import('ws')).default;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/ws?as=hostlink`, {
    headers: { authorization: `Bearer ${await keys.sign('u1', 'mac1')}` },
  });
  const inbox: any[] = [];
  ws.on('message', (d) => inbox.push(JSON.parse(String(d))));
  await new Promise((r) => ws.once('open', r));
  const next = async (pred: (m: any) => boolean) => {
    for (let i = 0; i < 300; i++) {
      const at = inbox.findIndex(pred);
      if (at >= 0) return inbox.splice(at, 1)[0];
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('no message');
  };
  await next((m) => m.t === 'hello');
  // the app answers each request: the script in two parts, the bundle whole
  const bundle = Buffer.alloc(300 * 1024, 7);
  let refuse = false;
  const builds: (string | undefined)[] = [];
  ws.on('message', (d) => {
    const m = JSON.parse(String(d));
    if (m.ev !== 'boot.request') return;
    builds.push(m.build);
    if (refuse) return ws.send(JSON.stringify({ t: 'boot.data', req: m.req, failed: true }));
    if (m.what === 'script') {
      ws.send(JSON.stringify({ t: 'boot.data', req: m.req, data: Buffer.from('#!/bin/sh\n').toString('base64') }));
      ws.send(JSON.stringify({ t: 'boot.data', req: m.req, data: Buffer.from(`echo ${m.ip}\n`).toString('base64'), end: true }));
    } else {
      // in parts under the relay's message cap, as the app sends them
      ws.send(JSON.stringify({ t: 'boot.data', req: m.req, data: bundle.subarray(0, 150 * 1024).toString('base64') }));
      ws.send(JSON.stringify({ t: 'boot.data', req: m.req, data: bundle.subarray(150 * 1024).toString('base64'), end: true }));
    }
  });
  ws.send(JSON.stringify({ t: 'host.boot', boot: BOOT, host: HOST, rid: 'b' }));
  await next((m) => m.op === 'host.boot');
  const script = await fetch(`${base}/v1/boot/${BOOT}`);
  assert.equal(script.status, 200);
  assert.equal(script.headers.get('cache-control'), 'no-store');
  assert.match(await script.text(), /^#!\/bin\/sh\necho 127\.0\.0\.1\n$/);
  // a second fetch of the script: it was used
  assert.equal(await (await fetch(`${base}/v1/boot/${BOOT}`)).text(), sayScript(SAY.gone));
  for (let i = 0; i < BUNDLE_TIMES; i++) {
    const b = await fetch(`${base}/v1/boot/${BOOT}/bundle/linux-x64-gnu`);
    assert.equal(b.headers.get('content-type'), 'application/gzip');
    assert.equal(Buffer.from(await b.arrayBuffer()).length, bundle.length);
  }
  assert.equal((await fetch(`${base}/v1/boot/${BOOT}/bundle/linux-x64-gnu`)).status, 404, 'the bundle at most three times');
  // the machine's build reaches the app, which judges it; the script asks for none, and a strange name is not a boot's
  assert.deepEqual(builds, [undefined, ...Array(BUNDLE_TIMES).fill('linux-x64-gnu')]);
  for (const bad of ['bundle/', 'bundle/Linux_X64', `bundle/${'a'.repeat(33)}`]) {
    assert.notEqual((await fetch(`${base}/v1/boot/${BOOT}/${bad}`)).headers.get('content-type'), 'application/gzip', bad);
  }
  // a boot nobody registered; a POST; a path that is not a boot's
  assert.equal(await (await fetch(`${base}/v1/boot/b_${'N'.repeat(22)}`)).text(), sayScript(SAY.gone));
  assert.equal((await fetch(`${base}/v1/boot/${BOOT}`, { method: 'POST' })).status, 404);
  assert.equal((await fetch(`${base}/v1/boot/nope`)).status, 404);
  // an app from before builds asks without one, and is answered
  // the app refuses: the script says so, the bundle is a 502
  const second = `b_${'C'.repeat(22)}`;
  ws.send(JSON.stringify({ t: 'host.boot', boot: second, host: HOST, rid: 'c' }));
  await next((m) => m.op === 'host.boot');
  refuse = true;
  assert.equal((await fetch(`${base}/v1/boot/${second}/bundle/linux-x64-gnu`)).status, 502);
  assert.equal(await (await fetch(`${base}/v1/boot/${second}`)).text(), sayScript(SAY.failed));
  // the lane goes: the boot it registered answers that the app is away, at once
  const third = `b_${'D'.repeat(22)}`;
  ws.send(JSON.stringify({ t: 'host.boot', boot: third, host: HOST, rid: 'd' }));
  await next((m) => m.op === 'host.boot');
  ws.close();
  await waitFor(() => !relay.hub.conns.has('mac1~h'), 'the hostlink connection leaving its hub');
  const started = Date.now();
  assert.equal(await (await fetch(`${base}/v1/boot/${third}`)).text(), sayScript(SAY.offline));
  assert.ok(Date.now() - started < 1000, 'answered quickly');
  assert.equal((await fetch(`${base}/v1/boot/${third}/bundle/linux-x64-gnu`)).status, 503);
});

test('the boots on their own: a silent app, a response past its cap, a lane that goes mid-way, a client that leaves, a stray message', async () => {
  const now = { t: 0 };
  const boots = createBoots({ now: () => now.t });
  const laneConn: any = { identity: { userId: 'u1', deviceId: 'mac1~h', kind: 'hostlink' } };
  const stranger: any = { identity: { userId: 'u2', deviceId: 'mac9~h', kind: 'hostlink' } };
  assert.equal(boots.register(laneConn, { boot: BOOT, host: HOST }), 'ok');
  const sent: any[] = [];
  const hub: any = { config: {}, conns: new Map([['mac1~h', laneConn]]), send: async (_c: any, m: any) => sent.push(m) };
  const res = () => {
    const r: any = { head: null, body: [] as Buffer[], ended: false, on: (ev: string, fn: any) => (r.onClose = fn) };
    r.writeHead = (status: number, h?: any) => ((r.head = { status, h }), r);
    r.write = (b: Buffer) => r.body.push(Buffer.from(b));
    r.end = (b?: string) => (b && r.body.push(Buffer.from(b)), (r.ended = true));
    return r;
  };
  const req = { method: 'GET', socket: { remoteAddress: '9.9.9.9' } };
  // the app takes too long to start answering: the script says so
  const { mock } = await import('node:test');
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const slow = res();
    assert.equal(boots.serve(hub, req as any, slow, `/v1/boot/${BOOT}`), true);
    mock.timers.tick(20_000);
    assert.equal(Buffer.concat(slow.body).toString(), sayScript(SAY.silent));
  } finally {
    mock.timers.reset();
  }
  // a response past its cap ends; bytes for a request of another lane, or none at all, change nothing
  const big = res();
  boots.serve(hub, req as any, big, `/v1/boot/${BOOT}/bundle/linux-x64-gnu`);
  const ask = sent.at(-1);
  assert.equal(ask.ip, '9.9.9.9');
  boots.data(stranger, { req: ask.req, data: 'AAAA' });
  boots.data(laneConn, { req: 'nope', data: 'AAAA' });
  boots.data(laneConn, { req: ask.req, data: '' });
  assert.equal(big.head.status, 200, 'an empty part starts the response');
  boots.data(laneConn, { req: ask.req, data: Buffer.alloc(MAX_SCRIPT + 1).toString('base64') });
  boots.data(laneConn, { req: ask.req, data: Buffer.alloc(64 * 1024 * 1024).toString('base64') });
  assert.equal(big.ended, true, 'past the bundle cap the response ends');
  // a script past its cap, before anything was sent, is a refusal message
  const fresh = `b_${'E'.repeat(22)}`;
  boots.register(laneConn, { boot: fresh, host: HOST });
  const over = res();
  boots.serve(hub, req as any, over, `/v1/boot/${fresh}`);
  boots.data(laneConn, { req: sent.at(-1).req, data: Buffer.alloc(MAX_SCRIPT + 1).toString('base64') });
  assert.equal(Buffer.concat(over.body).toString(), sayScript(SAY.failed));
  // the lane goes while a bundle is on its way: it ends there
  const mid = res();
  boots.serve(hub, req as any, mid, `/v1/boot/${BOOT}/bundle/linux-x64-gnu`);
  boots.data(laneConn, { req: sent.at(-1).req, data: 'AAAA' });
  boots.laneGone('mac1~h');
  assert.equal(mid.ended, true);
  // the downloader leaves: its request is forgotten
  const gone = res();
  boots.serve(hub, req as any, gone, `/v1/boot/${BOOT}/bundle/linux-x64-gnu`);
  gone.onClose();
  boots.data(laneConn, { req: sent.at(-1).req, data: 'AAAA' });
  assert.equal(gone.head, null);
  assert.equal(sayScript("it's"), "#!/bin/sh\necho 'MoPilot: it'\\''s' >&2\nexit 1\n");
});

test('behind a trusted proxy the address is the one it appended; a downloader that does not read is dropped, not buffered for', async () => {
  const { clientAddress } = await import('../relay/src/address.mjs');
  const req = (xff?: string) =>
    ({ headers: xff === undefined ? {} : { 'x-forwarded-for': xff }, socket: { remoteAddress: '10.0.0.2' } }) as any;
  assert.equal(clientAddress(req('1.2.3.4, 5.6.7.8'), true), '5.6.7.8');
  assert.equal(clientAddress(req('1.2.3.4, 5.6.7.8'), false), '10.0.0.2', 'a header is not believed without a proxy');
  assert.equal(clientAddress(req(), true), '10.0.0.2');
  assert.equal(clientAddress(req(' , '), true), '10.0.0.2');
  const boots = createBoots({ now: () => 0 });
  const laneConn: any = { identity: { userId: 'u1', deviceId: 'mac1~h', kind: 'hostlink' } };
  boots.register(laneConn, { boot: BOOT, host: HOST });
  const sent: any[] = [];
  const hub: any = { config: { trustProxy: true }, conns: new Map([['mac1~h', laneConn]]), send: async (_c: any, m: any) => sent.push(m) };
  const res: any = {
    writableLength: 0,
    destroyed: false,
    on: () => undefined,
    writeHead: () => res,
    write: () => (res.writableLength += 9 * 1024 * 1024),
    end: () => undefined,
    destroy: () => (res.destroyed = true),
  };
  boots.serve(
    hub,
    { method: 'GET', headers: { 'x-forwarded-for': '203.0.113.9' }, socket: { remoteAddress: '172.18.0.3' } } as any,
    res,
    `/v1/boot/${BOOT}/bundle/linux-x64-gnu`,
  );
  assert.equal(sent.at(-1).ip, '203.0.113.9');
  boots.data(laneConn, { req: sent.at(-1).req, data: 'AAAA' });
  assert.equal(res.destroyed, true);
  boots.data(laneConn, { req: sent.at(-1).req, data: 'AAAA' });
});

test('a lane flooding boot data is held to its frame rate and cut off past the wait; a request id that is not one is ignored', async () => {
  const r = await (async () => {
    await reset();
    const h = makeHub(db, { limits: { frameRate: 1, frameBurst: 1, maxWaitMs: 0 } });
    return h;
  })();
  const socket = new FakeSocket();
  const handlers = r.hub.connect(socket as any, lane());
  await settle(r.hub);
  handlers.message(JSON.stringify({ t: 'boot.data', req: 5, data: '' }));
  handlers.message(JSON.stringify({ t: 'boot.data', req: 'x', data: '' }));
  await settle(r.hub);
  assert.deepEqual(socket.closedWith, { code: 1008, reason: 'rate limited' });
});
