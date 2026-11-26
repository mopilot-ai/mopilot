// This Mac's side of pairing by code in the app (electron/host/codePairHost.cjs, `live.codePairHost`, #5576): one CLI connection to this Mac's Host, the offer on the account's token, every step of a run told, Allow only for the question open now (in its time, once at a time) and answered with the helper's proof (nothing when the person cancels), set-up only without a key, refusals as codes, and a dropped connection telling the open offers as ended.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
// @ts-ignore: plain ESM without declarations
import { createDecoder, encodeBinary, encodeControl } from '../shared/host/frames.mjs';

const require = createRequire(import.meta.url);
const { createCodePairHost, codePairHostFor, lazyApprover, httpBase } = require('../electron/host/codePairHost.cjs');

const SILENT: any = () => undefined;
const tick = () => new Promise((r) => setTimeout(r, 15));

/** A stand-in Host on a real socket: answers each method as `answers` says, records what it was asked, and can push lines. */
async function fakeHost(t: any, answers: Record<string, (p: any) => any>, { features = ['codePair'], silentHellos = 0 } = {}) {
  let hellosLeftSilent = silentHellos;
  const dir = fs.mkdtempSync(path.join('/tmp', 'cph-'));
  const sock = path.join(dir, 'h.sock');
  fs.writeFileSync(`${sock}.token`, 'tok');
  const asked: any[] = [];
  const sockets: net.Socket[] = [];
  const server = net.createServer((s) => {
    sockets.push(s);
    const d = createDecoder();
    s.on('data', (c) => {
      for (const f of d.push(c)) {
        const m = (f as any).message;
        asked.push({ method: m.method, params: m.params, token: m.token });
        if (m.method === 'host.hello') {
          if (hellosLeftSilent-- > 0) continue;
          s.write(encodeControl({ id: m.id, result: { agreed: { features } } }));
          continue;
        }
        const a = answers[m.method];
        if (a === SILENT) continue;
        try {
          s.write(encodeControl({ id: m.id, result: a ? a(m.params) : {} }));
        } catch (e: any) {
          s.write(encodeControl({ id: m.id, error: e.message, code: e.code }));
        }
      }
    });
  });
  await new Promise<void>((r) => server.listen(sock, r));
  t.after(() => {
    for (const s of sockets) s.destroy();
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return {
    sock,
    asked,
    push: (m: object) => sockets.at(-1)!.write(encodeControl(m)),
    raw: (text: string | Uint8Array) => sockets.at(-1)!.write(text),
    drop: () => sockets.at(-1)!.destroy(),
  };
}

const refuse = (code: string) => {
  throw Object.assign(new Error(code), { code });
};

function service(h: { sock: string }, over: Record<string, any> = {}) {
  const proofs: any[] = [];
  const approver = {
    enrol: async (hostId: string) => (proofs.push(['enrol', hostId]), { key: 'K', weak: false, signature: 'S' }),
    commit: async () => (proofs.push(['commit']), { committed: true }),
    abort: async () => (proofs.push(['abort']), { aborted: true }),
    reset: async () => (proofs.push(['reset']), { reset: true }),
    approve: async (fields: any) => (proofs.push(['approve', fields]), { sig: 'SIG' }),
    ...over.approver,
  };
  const s = createCodePairHost({
    socketPath: () => h.sock,
    relayUrl: () => 'wss://relay.example/v1/ws',
    relayToken: async () => 'acct',
    connections: () => true,
    timeoutMs: 500,
    ...over,
    approver,
  });
  const events: any[] = [];
  s.onEvent((e: any) => events.push(e));
  return { s, proofs, events };
}

test('the relay base is the HTTP origin of its WebSocket URL', () => {
  assert.equal(httpBase('wss://relay.example/v1/ws'), 'https://relay.example');
  assert.equal(httpBase('ws://127.0.0.1:8080/x'), 'http://127.0.0.1:8080');
});

/** A Host whose offer `r_x` asks the person (phase confirm, two minutes). */
const asking = (over: Record<string, (p: any) => any> = {}) => ({
  'host.codePair.status': () => ({ approval: { available: false, reason: 'no_approval_helper' }, hostId: 'h1', paused: false, offers: [] }),
  'host.codePair.enrol': (p: any) => ({ enrolled: true, weak: p.weak }),
  'host.codePair.offer': () => ({ offerId: 'r_x', code: 'ABCD-EFGH', expiresAt: 9 }),
  'host.codePair.approvalText': () => ({ text: 'T', notAfter: 1, fields: { hostId: 'h1', offerId: 'r_x', name: 'Other Mac' } }),
  'host.codePair.answer': (p: any) => ({ accepted: p.accept, fingerprint: 'fp' }),
  'host.codePair.cancel': () => ({ cancelled: true }),
  'host.codePair.resetApproval': () => ({ reset: true, controllers: 2 }),
  ...over,
});
const confirm = (h: any, offerId = 'r_x', expiresInMs = 120_000) =>
  h.push({ event: 'codePair', offerId, phase: 'confirm', name: 'Other Mac', safety: '1234', expiresInMs });

test('a whole run: status, set-up, a code on the account token, its steps told, Allow with the helper proof over the Host fields', async (t) => {
  const h = await fakeHost(t, asking());
  const { s, proofs, events } = service(h);
  assert.deepEqual(await s.status(), {
    approval: { available: false, reason: 'no_approval_helper' },
    connections: true,
    offers: [],
    hostId: 'h1',
  });
  assert.deepEqual(await s.setup(), { enrolled: true, weak: false });
  assert.deepEqual(proofs.slice(0, 2), [['enrol', 'h1'], ['commit']], 'the new key is kept only after the Host took it');
  proofs.splice(0, 2);
  assert.deepEqual(await s.offer(), { offerId: 'r_x', code: 'ABCD-EFGH', expiresAt: 9 });
  const offered = h.asked.find((a) => a.method === 'host.codePair.offer');
  assert.deepEqual([offered.params, offered.token], [{ relayUrl: 'https://relay.example', token: 'acct' }, 'tok']);
  confirm(h);
  await tick();
  assert.deepEqual(events, [{ offerId: 'r_x', phase: 'confirm', name: 'Other Mac', safety: '1234', expiresInMs: 120_000 }]);
  assert.deepEqual(await s.allow({ offerId: 'r_x' }), { accepted: true, fingerprint: 'fp' });
  assert.deepEqual(
    proofs[0],
    ['approve', { hostId: 'h1', offerId: 'r_x', name: 'Other Mac' }],
    'the helper is given the Host fields, never a text',
  );
  assert.deepEqual(h.asked.find((a) => a.method === 'host.codePair.answer').params, {
    offerId: 'r_x',
    accept: true,
    approval: { sig: 'SIG' },
  });
  h.push({ event: 'codePair', offerId: 'r_x', phase: 'done', fingerprint: 'fp' });
  await tick();
  assert.deepEqual(await s.allow({ offerId: 'r_x' }), { error: { code: 'no_such_offer' } }, 'an offer that ended is no question');
  assert.deepEqual(await s.deny({ offerId: 'r_x' }), { accepted: false, fingerprint: 'fp' });
  assert.deepEqual(await s.cancel({ offerId: 'r_x' }), { cancelled: true });
  assert.equal(h.asked.filter((a) => a.method === 'host.hello').length, 1, 'one connection for all of it');
  h.drop();
  await tick();
  assert.equal(events.at(-1)?.phase, 'done', 'the run ended, so a drop tells nothing more');
  s.dispose();
});

test('a Host that refuses the new key, or cannot be reached, leaves the old key: the helper drops the staged one', async (t) => {
  const h = await fakeHost(t, asking({ 'host.codePair.enrol': () => refuse('controllers_exist') }));
  const { s, proofs } = service(h);
  assert.deepEqual(await s.setup(), { error: { code: 'controllers_exist' } });
  assert.deepEqual(proofs, [['enrol', 'h1'], ['abort']]);
  // an abort that fails is reported, the refusal still answered
  const reported: unknown[] = [];
  const g = service(h, { report: (e: unknown) => reported.push(e), approver: { abort: async () => refuse('keychain') } });
  assert.deepEqual(await g.s.setup(), { error: { code: 'controllers_exist' } });
  assert.equal(reported.length, 1);
  s.dispose();
  g.s.dispose();
});

test('set-up runs only on a Host with no key: with one, nothing is asked of the helper', async (t) => {
  const h = await fakeHost(
    t,
    asking({ 'host.codePair.status': () => ({ approval: { available: true, weak: false }, hostId: 'h1', offers: [] }) }),
  );
  const { s, proofs } = service(h);
  assert.deepEqual(await s.setup(), { error: { code: 'already_enrolled' } });
  assert.deepEqual(proofs, []);
  s.dispose();
});

test('no prompt for a dead question: an unknown offer, one not asking yet, one whose two minutes ran out; and one Allow at a time', async (t) => {
  let clock = 1000;
  let release: (v: any) => void = () => undefined;
  const h = await fakeHost(t, asking());
  const { s, proofs } = service(h, {
    now: () => clock,
    approver: { approve: () => new Promise((r) => (release = r)) },
  });
  assert.deepEqual(await s.allow({ offerId: 'r_nope' }), { error: { code: 'no_such_offer' } });
  await s.offer();
  assert.deepEqual(await s.allow({ offerId: 'r_x' }), { error: { code: 'not_asked' } }, 'waiting, not asking');
  confirm(h, 'r_x', 120_000);
  await tick();
  clock += 120_000;
  assert.deepEqual(await s.allow({ offerId: 'r_x' }), { error: { code: 'expired' } });
  confirm(h, 'r_x', 120_000);
  await tick();
  const first = s.allow({ offerId: 'r_x' });
  await tick();
  assert.deepEqual(await s.allow({ offerId: 'r_x' }), { error: { code: 'busy' } }, 'a second Allow while the first prompts');
  release({ sig: 'SIG' });
  assert.deepEqual(await first, { accepted: true, fingerprint: 'fp' });
  assert.equal(proofs.length, 0, 'the stand-in approver here records nothing');
  assert.equal(
    h.asked.filter((a) => a.method === 'host.codePair.approvalText').length,
    1,
    'the dead questions never reached the Host or the helper',
  );
  s.dispose();
});

test('a cancelled prompt answers nothing and keeps the question; refusals are codes, never raw messages', async (t) => {
  const h = await fakeHost(
    t,
    asking({
      'host.codePair.offer': () => ({ offerId: 'r_x', code: 'C', expiresAt: 1 }),
      'host.codePair.cancel': () => refuse('no_such_offer'),
      'host.codePair.answer': () => refuse('not_asked'),
      'host.codePair.status': () => refuse('weird'),
    }),
  );
  const { s } = service(h, { approver: { approve: async () => refuse('not_approved'), enrol: async () => refuse('secure_enclave') } });
  await s.offer();
  confirm(h);
  await tick();
  assert.deepEqual(await s.allow({ offerId: 'r_x' }), { error: { code: 'not_approved' } });
  assert.equal(h.asked.filter((a) => a.method === 'host.codePair.answer').length, 0);
  assert.deepEqual(
    await s.allow({ offerId: 'r_x' }),
    { error: { code: 'not_approved' } },
    'the question stays: asked again, prompted again',
  );
  assert.deepEqual(await s.cancel({ offerId: 'r_x' }), { error: { code: 'no_such_offer' } });
  assert.deepEqual(await s.deny({ offerId: 'r_x' }), { error: { code: 'not_asked' } });
  assert.deepEqual(await s.setup(), { error: { code: 'weird' } });
  assert.deepEqual(await s.status(), { approval: { available: false, reason: 'weird' }, connections: true, offers: [] });
  const off = await fakeHost(t, asking({ 'host.codePair.offer': () => refuse('connections_off') }));
  assert.deepEqual(await service(off).s.offer(), { error: { code: 'connections_off' } });
  s.dispose();
});

test('no relay, signed out, no Host, no token file, a Host that does not pair by code, a Host that does not answer, nothing listening', async (t) => {
  const h = await fakeHost(t, {});
  assert.deepEqual(await service(h, { relayUrl: () => null }).s.offer(), { error: { code: 'relay' } });
  assert.deepEqual(await service(h, { relayToken: async () => null }).s.offer(), { error: { code: 'unauthorized' } });
  assert.deepEqual(await service(h, { socketPath: () => '' }).s.offer(), { error: { code: 'host_unreachable' } });
  assert.deepEqual(await service(h, { readToken: () => refuse('ENOENT') }).s.offer(), { error: { code: 'host_unreachable' } });
  const old = await fakeHost(t, {}, { features: [] });
  assert.deepEqual(await service(old).s.status(), { approval: { available: false, reason: 'unsupported' }, connections: true, offers: [] });
  const silent = await fakeHost(t, { 'host.codePair.cancel': SILENT });
  assert.deepEqual(await service(silent, { timeoutMs: 80 }).s.cancel({ offerId: 'r' }), { error: { code: 'host_unreachable' } });
  assert.deepEqual(await service({ sock: path.join(os.tmpdir(), 'nope-cph.sock') }, { readToken: () => 'x' }).s.cancel({ offerId: 'r' }), {
    error: { code: 'host_unreachable' },
  });
});

test('a connection that drops tells every open offer as ended; the next call reads the token again (a restarted Host has a new one)', async (t) => {
  const h = await fakeHost(t, asking());
  const tokens: string[] = [];
  let token = 'tok';
  const { s, events } = service(h, { readToken: () => (tokens.push(token), token) });
  await s.offer();
  h.drop();
  await tick();
  assert.deepEqual(events, [{ offerId: 'r_x', phase: 'cancelled', code: 'host_unreachable' }]);
  token = 'tok2';
  assert.deepEqual(await s.cancel({ offerId: 'r_x' }), { cancelled: true });
  assert.deepEqual(tokens, ['tok', 'tok2']);
  assert.equal(h.asked.at(-1).token, 'tok2');
  s.dispose();
});

test('a line the app cannot read ends the connection, is reported, and the open offers are told as ended', async (t) => {
  const reported: unknown[] = [];
  const h = await fakeHost(t, asking());
  const { s, events } = service(h, { report: (e: unknown) => reported.push(e) });
  await s.offer();
  h.push({ event: 'codePair', offerId: 'r_x', phase: 'waiting' });
  h.push({ unrelated: true });
  await tick();
  h.raw('this is not a frame\n');
  await tick();
  assert.equal(reported.length, 1);
  assert.deepEqual(events, [
    { offerId: 'r_x', phase: 'waiting' },
    { offerId: 'r_x', phase: 'cancelled', code: 'host_unreachable' },
  ]);
  s.dispose();
});

test('a binary frame is not a message; an error without a code is `failed`; a confirm without a time is already over; a bad line with no reporter is still an end', async (t) => {
  const h = await fakeHost(
    t,
    asking({
      'host.codePair.cancel': () => {
        throw new Error('no code');
      },
    }),
  );
  const s = createCodePairHost({
    socketPath: () => h.sock,
    relayUrl: () => 'wss://relay.example',
    relayToken: async () => 'acct',
    connections: () => false,
    approver: {
      enrol: async () => {
        throw new Error('plain');
      },
      approve: async () => {
        throw new Error('plain');
      },
    },
  });
  const events: any[] = [];
  const off = s.onEvent((e: any) => events.push(e));
  await s.offer();
  h.raw(encodeBinary({ kind: 'x' }, new Uint8Array([1, 2])));
  h.push({ event: 'codePair', offerId: 'r_x', phase: 'confirm' });
  await tick();
  assert.deepEqual(await s.allow({ offerId: 'r_x' }), { error: { code: 'expired' } });
  h.push({ event: 'codePair', offerId: 'r_x', phase: 'confirm', expiresInMs: 60_000 });
  h.push({ event: 'codePair', offerId: 'r_other', phase: 'confirm', expiresInMs: 60_000 });
  await tick();
  assert.deepEqual(await s.allow({ offerId: 'r_x' }), { error: { code: 'failed' } });
  assert.deepEqual(await s.cancel({ offerId: 'r_x' }), { error: { code: 'failed' } });
  assert.deepEqual((await s.status()).connections, false);
  h.raw('not a frame\n');
  await tick();
  assert.deepEqual(events.at(-1), { offerId: 'r_x', phase: 'cancelled', code: 'host_unreachable' });
  off();
  s.dispose();
});

test('as the app makes it: the Host this Mac lists as its own, the account token, the switch, and the helper looked for only when used', async (t) => {
  const h = await fakeHost(t, asking());
  const prior = process.env.MOPILOT_RELAY_URL;
  process.env.MOPILOT_RELAY_URL = 'wss://relay.example/v1/ws';
  t.after(() => (prior === undefined ? delete process.env.MOPILOT_RELAY_URL : (process.env.MOPILOT_RELAY_URL = prior)));
  const live: any = {
    remoteConsent: { enabled: () => true },
    mopilot: { relayToken: async () => 'acct' },
    localHostSocket: () => h.sock,
  };
  const s = codePairHostFor({ app: { isPackaged: false }, live });
  assert.equal((await s.status()).connections, true);
  assert.equal((await s.offer()).offerId, 'r_x');
  assert.equal(h.asked.find((a) => a.method === 'host.codePair.offer').params.token, 'acct');
  confirm(h);
  await tick();
  // in a checkout without a built helper it is missing (off a Mac, not there at all)
  for (const code of [(await s.setup()).error.code, (await s.allow({ offerId: 'r_x' })).error.code])
    assert.ok(['no_helper', 'unsupported_platform'].includes(code), code);
  h.raw('not a frame\n');
  await tick();
  s.dispose();
  // before the machine list and the sign-in exist: no Host, no token, the switch off
  const bare = codePairHostFor({ app: {} });
  assert.deepEqual(await bare.offer(), { error: { code: 'unauthorized' } });
  assert.deepEqual(await bare.status(), { approval: { available: false, reason: 'host_unreachable' }, connections: false, offers: [] });
  const early = codePairHostFor({ app: {}, live: { mopilot: { relayToken: async () => 'acct' } } });
  assert.deepEqual(await early.offer(), { error: { code: 'host_unreachable' } });
});

test('the helper runner is made at each use; each step reaches the helper', async () => {
  const a = lazyApprover(false);
  for (const step of [() => a.enrol('h'), () => a.commit(), () => a.abort(), () => a.reset(), () => a.approve({})])
    await assert.rejects(step(), (e: any) => ['no_helper', 'unsupported_platform'].includes(e.code));
});

test('calls that come together share one connection: an offer made on it can be answered on it', async (t) => {
  const h = await fakeHost(t, asking());
  const { s } = service(h);
  const [status, offer] = await Promise.all([s.status(), s.offer()]);
  assert.equal(status.hostId, 'h1');
  assert.equal(offer.offerId, 'r_x');
  assert.equal(h.asked.filter((a) => a.method === 'host.hello').length, 1, 'one hello, one connection');
  s.dispose();
});

test('a hello the Host does not answer leaves no dead connection: the next call opens a new one', async (t) => {
  const h = await fakeHost(t, asking(), { silentHellos: 1 });
  const { s } = service(h, { timeoutMs: 80 });
  assert.deepEqual(await s.offer(), { error: { code: 'host_unreachable' } });
  assert.equal((await s.offer()).offerId, 'r_x');
  assert.equal(h.asked.filter((a) => a.method === 'host.hello').length, 2);
  s.dispose();
});

test('one set-up at a time: a second click while the first prompts is busy and the helper runs once', async (t) => {
  const h = await fakeHost(t, asking());
  let release: (v: any) => void = () => undefined;
  const enrolled: string[] = [];
  const { s } = service(h, {
    approver: {
      // the first enrolment waits for the person; later ones answer at once
      enrol: (hostId: string) =>
        enrolled.push(hostId) === 1 ? new Promise((r) => (release = r)) : Promise.resolve({ key: 'K', weak: false, signature: 'S' }),
    },
  });
  const first = s.setup();
  await tick();
  assert.deepEqual(await s.setup(), { error: { code: 'busy' } });
  release({ key: 'K', weak: false, signature: 'S' });
  assert.deepEqual(await first, { enrolled: true, weak: false });
  assert.deepEqual(enrolled, ['h1'], 'the second click ran no helper');
  assert.deepEqual(await s.setup(), { enrolled: true, weak: false }, 'free again once it ended');
  s.dispose();
});

test('a key the Host accepted is kept even if the first commit fails; two failures name the repair', async (t) => {
  const h = await fakeHost(t, asking());
  let fails = 1;
  const reported: unknown[] = [];
  const once = service(h, {
    report: (e: unknown) => reported.push(e),
    approver: { commit: async () => (fails-- > 0 ? refuse('keychain') : { committed: true }) },
  });
  assert.deepEqual(await once.s.setup(), { enrolled: true, weak: false });
  assert.equal(reported.length, 1);
  const twice = service(h, { report: () => undefined, approver: { commit: async () => refuse('keychain') } });
  assert.deepEqual(await twice.s.setup(), { error: { code: 'approval_out_of_sync' } });
  once.s.dispose();
  twice.s.dispose();
});

test('a set-up that throws (a helper that cannot even start) still ends: the next Set up runs instead of answering busy', async (t) => {
  const h = await fakeHost(t, asking());
  let broken = true;
  const { s } = service(h, {
    approver: {
      enrol: async () => {
        if (broken) throw new TypeError('spawn failed');
        return { key: 'K', weak: false, signature: 'S' };
      },
    },
  });
  assert.deepEqual(await s.setup(), { error: { code: 'failed' } });
  broken = false;
  assert.deepEqual(await s.setup(), { enrolled: true, weak: false }, 'not busy');
  s.dispose();
});

test('reset approval: this Mac’s Host first, then the helper; refused while a code is open or a set-up runs', async (t) => {
  const h = await fakeHost(t, asking());
  const { s, proofs } = service(h);
  assert.deepEqual(await s.resetApproval(), { reset: true, controllers: 2 });
  assert.deepEqual(proofs, [['reset']], 'the helper after the Host');
  assert.ok(h.asked.some((a) => a.method === 'host.codePair.resetApproval'));
  await s.offer();
  assert.deepEqual(await s.resetApproval(), { error: { code: 'busy' } }, 'a code is open');
  s.dispose();
  // while a set-up prompts
  let release: (v: any) => void = () => undefined;
  const g = service(h, { approver: { enrol: () => new Promise((r) => (release = r)) } });
  const setup = g.s.setup();
  await tick();
  assert.deepEqual(await g.s.resetApproval(), { error: { code: 'busy' } });
  release({ key: 'K', weak: false, signature: 'S' });
  await setup;
  g.s.dispose();
});

test('reset approval, partly done: the Host refusing leaves the helper alone; a helper that fails says reset again; no helper is nothing to remove', async (t) => {
  const refusing = await fakeHost(t, asking({ 'host.codePair.resetApproval': () => refuse('reset_incomplete') }));
  const a = service(refusing);
  assert.deepEqual(await a.s.resetApproval(), { error: { code: 'reset_incomplete' } });
  assert.deepEqual(a.proofs, [], 'the helper is not touched');
  a.s.dispose();
  const h = await fakeHost(t, asking());
  const reported: unknown[] = [];
  const b = service(h, { report: (e: unknown) => reported.push(e), approver: { reset: async () => refuse('keychain') } });
  assert.deepEqual(await b.s.resetApproval(), { error: { code: 'reset_incomplete' } });
  assert.equal(reported.length, 1);
  b.s.dispose();
  const c = service(h, { approver: { reset: async () => refuse('no_helper') } });
  assert.deepEqual(await c.s.resetApproval(), { reset: true, controllers: 2 });
  c.s.dispose();
});
