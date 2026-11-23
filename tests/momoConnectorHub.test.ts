// MoMo's connector hub (electron/momo/connectors/hub.cjs, #2999 C0): status without tokens, connect through OAuth into the vault, disconnect, and tool calls decided and audited, with every race in both orders: a disconnect or new connect during a sign-in, a refresh or a call never saves tokens or returns a result after it; one refresh per connector at a time; a revoked account asks to sign in again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fakeSafe, scratch, clock } from './support/momo-fixtures.ts';

const require = createRequire(import.meta.url);
const { ConnectorHub, ConnectorError, Unauthorized, REFRESH_EARLY_MS } = require('../electron/momo/connectors/hub.cjs');
const { TokenVault } = require('../electron/momo/connectors/vault.cjs');
const { OAuthError } = require('../electron/gateway/oauth.cjs');

const T0 = 1_900_000_000_000;
const code = (c: string) => (e: any) => e?.code === c;

/** A promise the test settles. */
function deferred<T = any>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** The OAuth steps the hub calls, each held until the test answers it. */
function fakeFlow() {
  const f: any = { listens: [], exchanges: [], refreshes: [] };
  f.listenForCode = async ({ state }: any) => {
    const d = deferred<string>();
    d.promise.catch(() => undefined);
    const l = {
      state,
      redirectUri: 'http://127.0.0.1:9/callback',
      code: d.promise,
      closed: 0,
      close: () => void (l.closed++, d.reject(new OAuthError('cancelled', 'closed'))),
      answer: d.resolve,
    };
    f.listens.push(l);
    if (f.beforeListen) await f.beforeListen();
    return l;
  };
  f.exchangeCode = (o: any) => {
    const d = deferred();
    f.exchanges.push({ o, ...d });
    return d.promise;
  };
  f.refreshTokens = (o: any) => {
    const d = deferred();
    f.refreshes.push({ o, ...d });
    return d.promise;
  };
  return f;
}

const tick = () => new Promise((r) => setImmediate(r));

function setup(o: { allowed?: boolean; decide?: any; audit?: any } = {}) {
  const dir = scratch();
  const c = clock(T0);
  const vault = new TokenVault({ dir, safeStorage: fakeSafe(), now: c.now });
  const flow = fakeFlow();
  const opened: string[] = [];
  const audits: any[] = [];
  const decisions: any[] = [];
  const s: any = { allowed: o.allowed ?? true };
  const hub = new ConnectorHub({
    vault,
    allowed: () => s.allowed,
    decide:
      o.decide === null
        ? null
        : (o.decide ??
          (async (call: any) => {
            decisions.push(call);
            return { allow: true };
          })),
    audit: o.audit === null ? null : { append: (e: any) => void audits.push(e) },
    openExternal: (u: string) => void opened.push(u),
    now: c.now,
    oauth: flow,
  });
  const runs: any[] = [];
  hub.register({
    id: 'fake',
    label: 'Fake',
    scopes: ['read', 'write'],
    oauth: {
      authorizeUrl: 'https://auth.example/o',
      tokenUrl: 'https://auth.example/t',
      clientId: 'cid',
      extra: { access_type: 'offline' },
    },
    tools: {
      list: {
        kind: 'read',
        description: 'List items',
        summary: (a: any) => `list ${a.q ?? ''}`,
        run: async (args: any, ctx: any) => {
          runs.push({ args, token: ctx.accessToken });
          if (s.run) return s.run(args, ctx);
          return { items: [args.q] };
        },
      },
      send: { kind: 'change', description: 'Send one', summary: () => 'send', run: async () => 'sent' },
    },
  });
  return { hub, vault, flow, opened, audits, decisions, runs, c, s };
}

/** Connects 'fake' through the fake flow with these tokens. */
async function connect(
  w: any,
  tokens: any = { accessToken: 'A1', refreshToken: 'R1', expiresAt: T0 + 3600_000, scopes: [] },
  account?: string,
) {
  const p = w.hub.connect('fake', account ? { account } : undefined);
  await tick();
  const l = w.flow.listens.at(-1);
  l.answer('the-code');
  await tick();
  w.flow.exchanges.at(-1).resolve(tokens);
  return p;
}

test('register: ids are checked once; status lists tools and never a token', async () => {
  const w = setup();
  assert.throws(() => w.hub.register({ id: 'Bad id', tools: {} }), /Not a connector id/);
  assert.throws(() => w.hub.register({ id: 'fake', tools: {} }), /already registered/);
  assert.throws(() => w.hub.register(undefined), /Not a connector id/);
  assert.throws(() => w.hub.status('nope'), code('unknown'));
  assert.deepEqual(w.hub.list(), [
    {
      id: 'fake',
      label: 'Fake',
      connected: false,
      account: null,
      scopes: [],
      level: 'ask',
      needsReconnect: false,
      connecting: false,
      tools: [
        { name: 'list', kind: 'read', description: 'List items' },
        { name: 'send', kind: 'change', description: 'Send one' },
      ],
    },
  ]);
});

test('connect: PKCE consent in the browser, the code exchanged, tokens saved (scopes defaulted), Settings never sees a token', async () => {
  const w = setup();
  let changed = 0;
  w.hub.on('changed', () => changed++);
  const p = w.hub.connect('fake', { account: 'me@example.com' });
  await tick();
  assert.equal(w.hub.status('fake').connecting, true);
  const u = new URL(w.opened[0]);
  const l = w.flow.listens[0];
  assert.equal(u.searchParams.get('state'), l.state);
  assert.equal(u.searchParams.get('redirect_uri'), l.redirectUri);
  assert.equal(u.searchParams.get('scope'), 'read write');
  assert.equal(u.searchParams.get('access_type'), 'offline');
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  l.answer('the-code');
  await tick();
  const ex = w.flow.exchanges[0].o;
  assert.equal(ex.code, 'the-code');
  assert.equal(ex.clientId, 'cid');
  assert.equal(ex.redirectUri, l.redirectUri);
  assert.match(ex.verifier, /^[A-Za-z0-9_-]{43}$/);
  w.flow.exchanges[0].resolve({ accessToken: 'A1', refreshToken: 'R1', scopes: [] });
  const st = await p;
  assert.deepEqual(
    { connected: st.connected, account: st.account, scopes: st.scopes, connecting: st.connecting },
    { connected: true, account: 'me@example.com', scopes: ['read', 'write'], connecting: false },
  );
  assert.ok(!JSON.stringify(w.hub.list()).includes('A1'), 'no token in status');
  assert.equal(l.closed, 1);
  assert.ok(changed >= 2);
  // without an account label, the provider's scopes are kept
  await connect(w, { accessToken: 'A2', scopes: ['read'] });
  assert.deepEqual([w.hub.status('fake').account, w.hub.status('fake').scopes], [null, ['read']]);
});

test('connect is refused while MoMo is off; a failing exchange or browser leaves nothing saved and no sign-in waiting', async () => {
  const off = setup({ allowed: false });
  await assert.rejects(off.hub.connect('fake'), code('refused'));
  await assert.rejects(off.hub.connect('nope'), code('unknown'));

  const w = setup();
  const p = w.hub.connect('fake');
  await tick();
  w.flow.listens[0].answer('c');
  await tick();
  w.flow.exchanges[0].reject(new OAuthError('no', 'token'));
  await assert.rejects(p, code('token'));
  assert.equal(w.hub.status('fake').connected, false);
  assert.equal(w.hub.status('fake').connecting, false);

  w.hub.openExternal = () => {
    throw new Error('no browser');
  };
  await assert.rejects(w.hub.connect('fake'), /no browser/);
  assert.equal(w.hub.status('fake').connecting, false);
});

test('race: a disconnect during the sign-in wins in either order; a second connect replaces the first', async () => {
  // disconnect while the browser is open: the wait is cancelled
  const a = setup();
  const p1 = assert.rejects(a.hub.connect('fake'), code('closed'));
  await tick();
  await a.hub.disconnect('fake');
  await p1;
  assert.equal(a.hub.status('fake').connected, false);

  // disconnect while the token endpoint answers: the tokens it brings are not saved
  const b = setup();
  const p2 = b.hub.connect('fake');
  await tick();
  b.flow.listens[0].answer('c');
  await tick();
  await b.hub.disconnect('fake');
  b.flow.exchanges[0].resolve({ accessToken: 'LATE', scopes: [] });
  await assert.rejects(p2, code('stale'));
  assert.equal(b.vault.get('fake'), null);

  // disconnect while the loopback server starts: its wait is closed at once
  const c = setup();
  c.flow.beforeListen = () => c.hub.disconnect('fake');
  await assert.rejects(c.hub.connect('fake'), code('stale'));
  assert.equal(c.flow.listens[0].closed, 1);

  // a second connect replaces the first, whose tokens are never saved
  const d = setup();
  const first = assert.rejects(d.hub.connect('fake'), code('closed'));
  await tick();
  const second = d.hub.connect('fake');
  await first;
  await tick();
  d.flow.listens[1].answer('c2');
  await tick();
  d.flow.exchanges[0].resolve({ accessToken: 'SECOND', scopes: [] });
  await second;
  assert.equal(d.vault.get('fake').accessToken, 'SECOND');
});

test('call: decided (read as read, write as change) and audited; refused calls, unknown tools and missing wiring fail closed', async () => {
  const w = setup();
  await assert.rejects(w.hub.call({ connector: 'fake', tool: 'list', chatId: 'mc' }), code('not_connected'));
  await connect(w);
  assert.deepEqual(await w.hub.call({ connector: 'fake', tool: 'list', chatId: 'mc', args: { q: 'x' } }), { items: ['x'] });
  assert.equal(await w.hub.call({ connector: 'fake', tool: 'send', chatId: 'mc' }), 'sent');
  assert.deepEqual(
    w.decisions.map((d: any) => [d.kind, d.tool, d.summary]),
    [
      ['read', 'list', 'list x'],
      ['change', 'send', 'send'],
    ],
  );
  assert.deepEqual(w.runs[0], { args: { q: 'x' }, token: 'A1' });
  assert.deepEqual(
    w.audits.map((a: any) => [a.tool, a.decision, a.result]),
    [
      ['list', 'allowed', 'done'],
      ['send', 'allowed', 'done'],
    ],
  );
  await assert.rejects(w.hub.call({ connector: 'fake', tool: 'nope', chatId: 'mc' }), code('unknown'));
  w.s.allowed = false;
  await assert.rejects(w.hub.call({ connector: 'fake', tool: 'list', chatId: 'mc' }), code('refused'));

  const no = setup({ decide: async () => ({ allow: false, reason: 'read-only' }) });
  await connect(no);
  await assert.rejects(
    no.hub.call({ connector: 'fake', tool: 'send', chatId: 'mc' }),
    (e: any) => e.code === 'refused' && /read-only/.test(e.message),
  );
  assert.deepEqual(no.audits[0].decision, 'read-only');
  const bare = setup({ decide: async () => ({ allow: false }) });
  await connect(bare);
  await assert.rejects(bare.hub.call({ connector: 'fake', tool: 'send', chatId: 'mc' }), (e: any) => e.message === 'Not allowed');
  assert.equal(bare.audits[0].decision, 'refused');

  for (const missing of [{ decide: null }, { audit: null }]) {
    const m = setup(missing);
    await connect(m);
    await assert.rejects(m.hub.call({ connector: 'fake', tool: 'list', chatId: 'mc' }), code('refused'));
  }
});

test('call: a provider failure is audited and reported without its text; no args means {}', async () => {
  const w = setup();
  await connect(w);
  w.s.run = async () => {
    throw new Error('provider said token=SECRET');
  };
  await assert.rejects(
    w.hub.call({ connector: 'fake', tool: 'list', chatId: 'mc' }),
    (e: any) => e.code === 'failed' && !/SECRET/.test(e.message),
  );
  assert.equal(w.audits.at(-1).result, 'failed');
  assert.ok(!/SECRET/.test(JSON.stringify(w.audits)));
  assert.deepEqual(w.runs.at(-1).args, {});
  w.s.run = async () => {
    throw 'a string';
  };
  await assert.rejects(w.hub.call({ connector: 'fake', tool: 'list', chatId: 'mc' }), code('failed'));
  assert.equal(w.audits.at(-1).reason, 'Fake failed');
});

test('race: a disconnect while the call is decided or runs drops its result, in either order', async () => {
  // disconnect while decide waits for the user's answer
  const gate = deferred();
  const a = setup({ decide: () => gate.promise });
  await connect(a);
  const p = a.hub.call({ connector: 'fake', tool: 'send', chatId: 'mc' });
  await tick();
  await a.hub.disconnect('fake');
  gate.resolve({ allow: true });
  await assert.rejects(p, code('stale'));

  // disconnect while the provider answers: the result is dropped and audited as failed
  const b = setup();
  await connect(b);
  const answer = deferred();
  b.s.run = () => answer.promise;
  const q = b.hub.call({ connector: 'fake', tool: 'list', chatId: 'mc' });
  await tick();
  await b.hub.disconnect('fake');
  answer.resolve({ items: ['private'] });
  await assert.rejects(q, code('stale'));
  // the provider already did it: the log says done, the stale result is still not returned
  assert.equal(b.audits.at(-1).result, 'done');
});

test('call: MoMo turned off while the card waits refuses the run, audited', async () => {
  const gate = deferred();
  const w = setup({ decide: () => gate.promise });
  await connect(w);
  const p = w.hub.call({ connector: 'fake', tool: 'send', chatId: 'mc' });
  await tick();
  w.s.allowed = false;
  gate.resolve({ allow: true });
  await assert.rejects(p, code('refused'));
  assert.equal(w.runs.length, 0);
  assert.equal(w.audits.at(-1).decision, 'MoMo is off');
});

test('refresh: an expiring token is refreshed once for overlapping calls; the old refresh token is used and the account kept', async () => {
  const w = setup();
  await connect(w, { accessToken: 'OLD', refreshToken: 'R1', expiresAt: T0 + REFRESH_EARLY_MS - 1, scopes: ['read'] }, 'me@x');
  const p1 = w.hub.call({ connector: 'fake', tool: 'list', chatId: 'mc' });
  const p2 = w.hub.call({ connector: 'fake', tool: 'list', chatId: 'mc' });
  await tick();
  assert.equal(w.flow.refreshes.length, 1);
  assert.equal(w.flow.refreshes[0].o.refreshToken, 'R1');
  w.flow.refreshes[0].resolve({ accessToken: 'NEW', refreshToken: 'R1', expiresAt: T0 + 3600_000, scopes: [] });
  await Promise.all([p1, p2]);
  assert.deepEqual(
    w.runs.map((r: any) => r.token),
    ['NEW', 'NEW'],
  );
  const t = w.vault.get('fake');
  assert.deepEqual([t.accessToken, t.scopes, t.account], ['NEW', ['read'], 'me@x']);
  // a later call uses the saved token; a token with no expiry never refreshes
  await w.hub.call({ connector: 'fake', tool: 'list', chatId: 'mc' });
  assert.equal(w.flow.refreshes.length, 1);
  // the provider's scopes win when it sends them
  w.c.t += 3600_000;
  const p3 = w.hub.call({ connector: 'fake', tool: 'list', chatId: 'mc' });
  await tick();
  w.flow.refreshes[1].resolve({ accessToken: 'NEWER', refreshToken: 'R1', scopes: ['narrow'] });
  await p3;
  assert.deepEqual(w.vault.get('fake').scopes, ['narrow']);
});

test('race: a disconnect during a refresh keeps the account disconnected, in either order', async () => {
  const w = setup();
  await connect(w, { accessToken: 'OLD', refreshToken: 'R1', expiresAt: T0, scopes: [] });
  const p = w.hub.call({ connector: 'fake', tool: 'list', chatId: 'mc' });
  await tick();
  await w.hub.disconnect('fake');
  w.flow.refreshes[0].resolve({ accessToken: 'LATE', refreshToken: 'R2', scopes: [] });
  await assert.rejects(p, code('stale'));
  assert.equal(w.vault.get('fake'), null, 'the refreshed tokens were not saved after the disconnect');

  // the other order: the refresh saved first, then the disconnect removes it
  const v = setup();
  await connect(v, { accessToken: 'OLD', refreshToken: 'R1', expiresAt: T0, scopes: [] });
  const q = v.hub.call({ connector: 'fake', tool: 'list', chatId: 'mc' });
  await tick();
  v.flow.refreshes[0].resolve({ accessToken: 'NEW', refreshToken: 'R1', scopes: [] });
  await q;
  await v.hub.disconnect('fake');
  assert.equal(v.vault.get('fake'), null);
});

test('revoked: a refused refresh, an expired token without a refresh token, or unauthorized twice ask to sign in again', async () => {
  const w = setup();
  await connect(w, { accessToken: 'OLD', refreshToken: 'R1', expiresAt: T0, scopes: [] });
  const p = w.hub.call({ connector: 'fake', tool: 'list', chatId: 'mc' });
  await tick();
  w.flow.refreshes[0].reject(new OAuthError('invalid_grant', 'token'));
  await assert.rejects(p, code('reconnect'));
  assert.deepEqual([w.hub.status('fake').connected, w.hub.status('fake').needsReconnect], [false, true]);
  // a new connect clears it
  await connect(w);
  assert.equal(w.hub.status('fake').needsReconnect, false);

  const n = setup();
  await connect(n, { accessToken: 'OLD', expiresAt: T0, scopes: [] });
  await assert.rejects(n.hub.call({ connector: 'fake', tool: 'list', chatId: 'mc' }), code('reconnect'));

  // unauthorized: one refresh and a retry, which succeeds
  const u = setup();
  await connect(u);
  let first = true;
  u.s.run = async (_a: any, ctx: any) => {
    if (first) {
      first = false;
      throw new Unauthorized();
    }
    return ctx.accessToken;
  };
  const r = u.hub.call({ connector: 'fake', tool: 'list', chatId: 'mc' });
  await tick();
  u.flow.refreshes[0].resolve({ accessToken: 'A2', refreshToken: 'R1', scopes: [] });
  assert.equal(await r, 'A2');
  // unauthorized again after the refresh: the account is lost
  u.s.run = async () => {
    throw new Unauthorized();
  };
  const r2 = u.hub.call({ connector: 'fake', tool: 'list', chatId: 'mc' });
  await tick();
  u.flow.refreshes[1].resolve({ accessToken: 'A3', refreshToken: 'R1', scopes: [] });
  await assert.rejects(r2, code('reconnect'));
  assert.equal(u.hub.status('fake').needsReconnect, true);
  assert.equal(u.audits.at(-1).reason, 'unauthorized');

  // unauthorized, and the provider refuses the refresh too: lost, audited with the hub's reason
  const v = setup();
  await connect(v);
  v.s.run = async () => {
    throw new Unauthorized();
  };
  const r3 = v.hub.call({ connector: 'fake', tool: 'list', chatId: 'mc' });
  await tick();
  v.flow.refreshes[0].reject(new OAuthError('refused', 'token'));
  await assert.rejects(r3, code('reconnect'));
  assert.equal(v.audits.at(-1).reason, 'Fake needs to be signed in again');

  // a refresh that fails for another reason is passed on as is
  const o = setup();
  await connect(o, { accessToken: 'OLD', refreshToken: 'R1', expiresAt: T0, scopes: [] });
  const q = o.hub.call({ connector: 'fake', tool: 'list', chatId: 'mc' });
  await tick();
  o.flow.refreshes[0].reject(new Error('disk full'));
  await assert.rejects(q, /disk full/);
});

test('race: an account lost after a disconnect stays disconnected, not asked again; reset ends every sign-in', async () => {
  const w = setup();
  await connect(w, { accessToken: 'OLD', refreshToken: 'R1', expiresAt: T0, scopes: [] });
  const p = w.hub.call({ connector: 'fake', tool: 'list', chatId: 'mc' });
  await tick();
  await w.hub.disconnect('fake');
  w.flow.refreshes[0].reject(new OAuthError('invalid_grant', 'token'));
  await assert.rejects(p, code('stale'));
  assert.equal(w.hub.status('fake').needsReconnect, false);

  const s = setup();
  const c = assert.rejects(s.hub.connect('fake'), code('closed'));
  await tick();
  s.hub.reset();
  await c;
  assert.equal(s.hub.status('fake').connecting, false);
  await assert.rejects(s.hub.disconnect('nope'), code('unknown'));
  assert.ok(new ConnectorError('x', 'failed') instanceof Error);
});
