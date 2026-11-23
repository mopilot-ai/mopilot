// electron/harness/admission.cjs against an in-process fake ACP agent (no binaries are run): each way a
// probe ends, and the Admission cache, listeners and refresh rules.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fakeSpawn, INIT, NO_REPLY } from './support/electron-acp-fake.ts';
import { tornWrites } from './support/torn-write.ts';
import { deferred } from './support/async-scenarios.ts';

const require = createRequire(import.meta.url);
const { Admission, probe, binStamp, isAuthError } = require('../electron/harness/admission.cjs');
const { recentIgnored } = require('../electron/ignored.cjs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'admission-cov-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const BIN = path.join(dir, 'fake-bin');
fs.writeFileSync(BIN, 'x');

const Q = (extra: any = {}) => ({
  label: 'Fake',
  bins: ['fake'],
  args: ['acp'],
  privacyDefaults: [],
  admission: { handshakeTimeoutMs: 1000 },
  ...extra,
});
function tools(admitted = true) {
  const log: any[] = [];
  return {
    log,
    prepare: async (key: string, o: any) => (log.push(['prepare', key, o.harnessPid]), { mcpServers: [] }),
    admission: async () => admitted,
    end: (key: string) => log.push(['end', key]),
  };
}
function opts(q: any, handlers: any = {}, extra: any = {}) {
  const s = fakeSpawn(handlers);
  return {
    s,
    o: { quirks: () => q, resolveBin: () => BIN, env: () => ({ BASE: '1' }), tools: tools(), dataDir: dir, spawnFn: s.spawnFn, ...extra },
  };
}

test('binStamp: a missing binary has none', () => {
  assert.equal(binStamp(path.join(dir, 'nope')), null);
  assert.match(binStamp(BIN)!, /\|1\|\d+$/);
});

test('isAuthError: the ACP auth code or a login message; anything else is not', () => {
  assert.equal(isAuthError({ code: -32000 }), true);
  assert.equal(isAuthError(new Error('Not logged in')), true);
  assert.equal(isAuthError({}), false);
  assert.equal(isAuthError(null), false);
});

test('probe: missing binary, no quirks file, invalid quirks', async () => {
  const base = { tools: tools(), env: () => ({}), dataDir: dir };
  assert.equal((await probe('x', { ...base, quirks: () => Q(), resolveBin: () => null })).state, 'missing');
  assert.match((await probe('x', { ...base, quirks: () => null, resolveBin: () => BIN })).reason, /no quirks file/);
  assert.match((await probe('x', { ...base, quirks: () => ({ label: 'X' }), resolveBin: () => BIN })).reason, /bins/);
});

test('probe: launch and the privacy gate run first, with the launch args and env; failures say why', async () => {
  const seen: any[] = [];
  const launch = (ctx: any) => (seen.push(['launch', ctx.bin, ctx.dataDir, ctx.env]), { args: ['--acp'], env: { L: '1' } });
  const gate = (ctx: any) => (seen.push(['gate', ctx.args, ctx.env]), { ok: false, reason: 'telemetry on' });
  const { o } = opts(Q({ args: undefined, launch, env: { Q: '1' }, admission: { handshakeTimeoutMs: 1, privacyGate: gate } }));
  assert.deepEqual(await probe('x', o).then((r: any) => [r.state, r.reason]), ['unsupported', 'telemetry on']);
  assert.deepEqual(seen, [
    ['launch', BIN, dir, { BASE: '1', Q: '1' }],
    ['gate', ['--acp'], { BASE: '1', Q: '1', L: '1' }],
  ]);
  const { o: o2 } = opts(
    Q({ args: undefined, launch: () => ({ args: [] }), admission: { handshakeTimeoutMs: 1, privacyGate: () => ({ ok: true }) } }),
  );
  assert.equal((await probe('x', o2)).state, 'admitted');
  const { o: o3 } = opts(
    Q({
      args: undefined,
      launch: () => {
        throw new Error('no data dir');
      },
    }),
  );
  assert.equal((await probe('x', o3)).reason, 'No data dir.');
  const { o: o4 } = opts(
    Q({
      args: undefined,
      launch: () => {
        throw 'raw';
      },
    }),
  );
  assert.equal((await probe('x', o4)).reason, 'Raw.');
});

test('probe: admitted; a probe cancels permissions and refuses other requests; closes the session when it can', async () => {
  const answers: any[] = [];
  const { o, s } = opts(Q(), {
    initialize: () => INIT({ sessionCapabilities: { close: true } }),
    'session/new': async (_p: any, proc: any) => {
      answers.push(await proc.request('session/request_permission', {}));
      answers.push(await proc.request('fs/read_text_file', {}));
      return { sessionId: 'S1' };
    },
  });
  const r = await probe('x', o);
  assert.equal(r.state, 'admitted');
  assert.equal(r.version, '1.0');
  assert.deepEqual(s.calls[0].args, ['acp']);
  assert.deepEqual(answers[0].result, { outcome: { outcome: 'cancelled' } });
  assert.equal(answers[1].error.code, -32601);
  await new Promise((r) => setImmediate(r));
  assert.ok(s.procs[0].received.some((m: any) => m.method === 'session/close' && m.params.sessionId === 'S1'));
  assert.deepEqual(
    o.tools.log.map((l: any) => l[0]),
    ['prepare', 'end'],
  );
});

test('probe: an agent that refuses to close the probe session is still admitted', async () => {
  const { o, s } = opts(Q(), {
    initialize: () => INIT({ sessionCapabilities: { close: true } }),
    'session/new': () => ({ sessionId: 'S2' }),
    'session/close': () => {
      throw new Error('cannot close');
    },
  });
  assert.equal((await probe('x', o)).state, 'admitted');
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  assert.ok(s.procs[0].received.some((m: any) => m.method === 'session/close' && m.params.sessionId === 'S2'));
});

test('probe: no agent version; session/new needing a login is signin; other failures are unsupported', async () => {
  let r = await probe(
    'x',
    opts(Q(), {
      initialize: () => ({ protocolVersion: 1 }),
      'session/new': () => {
        throw Object.assign(new Error('Authentication required'), { code: -32000 });
      },
    }).o,
  );
  assert.deepEqual([r.state, r.reason, r.version], ['signin', 'Sign in to Fake first', null]);
  r = await probe(
    'x',
    opts(Q(), {
      initialize: () => INIT({}, { authMethods: [{ id: 'oauth' }] }),
      'session/new': () => {
        throw Object.assign(new Error('boom'), { code: 1 });
      },
    }).o,
  );
  // what the agent said is the reason when it says more than "sign in" (#1319 G27)
  assert.deepEqual([r.state, r.reason], ['signin', 'boom']);
  const retired =
    'This client is no longer supported for Gemini Code Assist for individuals. To continue using Gemini, please migrate to the Antigravity suite of products: https://antigravity.google';
  r = await probe(
    'x',
    opts(Q(), {
      initialize: () => INIT({}, { authMethods: [{ id: 'oauth-personal' }] }),
      'session/new': () => {
        throw Object.assign(new Error(retired), { code: -32000 });
      },
    }).o,
  );
  assert.deepEqual([r.state, r.reason], ['signin', retired]);
  r = await probe(
    'x',
    opts(Q(), {
      'session/new': () => {
        throw Object.assign(new Error('boom'), { code: 1 });
      },
    }).o,
  );
  assert.deepEqual([r.state, r.reason], ['unsupported', 'Boom.']);
});

test('probe: one that refuses stdio MCP servers is unsupported before any sign-in while the tools come only over stdio', async () => {
  const stdio = { mcpServers: [{ name: 'sage_x', command: '/bin/sage-mcp', args: [], env: [] }] };
  const signedOut = {
    initialize: () => INIT({}, { authMethods: [{ id: 'copilot-login' }] }),
    'session/new': () => {
      throw Object.assign(new Error('Authentication required'), { code: -32000 });
    },
  };
  const { o } = opts(Q({ mcpStdio: false }), signedOut);
  o.tools = { ...tools(), prepare: async () => stdio };
  const r = await probe('x', o);
  assert.deepEqual(
    [r.state, r.reason],
    ['unsupported', "MoPilot can't give Fake computer and browser control: it takes only http and sse MCP servers"],
  );
  // once the tools are offered over http it goes on to session/new (here: a sign-in)
  const http = opts(Q({ mcpStdio: false }), signedOut);
  http.o.tools = {
    ...tools(),
    prepare: async () => ({ mcpServers: [{ type: 'http', name: 'sage_x', url: 'http://127.0.0.1:1/', headers: [] }] }),
  };
  assert.equal((await probe('x', http.o)).state, 'signin');
  // with no tools offered at all it is not blamed on stdio: the probe goes on
  const none = opts(Q({ mcpStdio: false }), signedOut);
  none.o.tools = { ...tools(), prepare: async () => ({ mcpServers: [] }) };
  assert.equal((await probe('x', none.o)).state, 'signin');
  // a harness that takes stdio is not affected
  const ok = opts(Q(), {});
  ok.o.tools = { ...tools(), prepare: async () => stdio };
  assert.equal((await probe('x', ok.o)).state, 'admitted');
});

test('probe: one that refuses stdio MCP servers is asked for its tools over http when its initialize takes http', async () => {
  const asked: any[] = [];
  const record = async (_key: string, o: any) => (asked.push(o.http), { mcpServers: [] });
  const http = { initialize: () => INIT({ mcpCapabilities: { http: true } }) };
  const noStdio = opts(Q({ mcpStdio: false }), http);
  noStdio.o.tools = { ...tools(), prepare: record };
  assert.equal((await probe('x', noStdio.o)).state, 'admitted');
  // one without http in its initialize, and one that takes stdio, are offered sage-mcp as before
  const noHttp = opts(Q({ mcpStdio: false }), {});
  noHttp.o.tools = { ...tools(), prepare: record };
  await probe('x', noHttp.o);
  const stdio = opts(Q(), http);
  stdio.o.tools = { ...tools(), prepare: record };
  await probe('x', stdio.o);
  assert.deepEqual(asked, [true, false, false]);
});

test('probe: no computer control is unsupported; an agent that dies reports its last stderr line', async () => {
  const { o } = opts(Q());
  o.tools = tools(false);
  assert.match((await probe('x', o)).reason, /can't give Fake computer and browser control/);
  const dying = opts(Q(), {
    initialize: (_p: any, proc: any) => {
      proc.stderr.emit('data', 'starting\nfatal: no config\n');
      setImmediate(() => proc.exit(1));
      return NO_REPLY;
    },
  });
  const r = await probe('x', dying.o);
  assert.equal(r.state, 'unsupported');
  // the row reads a sentence; the exit and its last stderr line go to diagnostics (#1863)
  assert.equal(r.reason, 'Fake quit unexpectedly.');
  assert.match(recentIgnored().at(-1).message, / · fatal: no config$/);
  const silent = opts(Q(), { initialize: (_p: any, proc: any) => (setImmediate(() => proc.exit(1)), NO_REPLY) });
  const r2 = await probe('x', silent.o);
  assert.equal(r2.reason.includes(' · '), false);
});

test('Admission: a cache file holding null starts empty; listeners come and go; save failures are ignored', async () => {
  const file = path.join(dir, 'null.json');
  fs.writeFileSync(file, 'null');
  const s = fakeSpawn();
  const a = new Admission({
    ids: ['x'],
    file,
    quirks: () => Q({ loginCommand: ['fake', 'login'] }),
    resolveBin: () => BIN,
    env: () => ({}),
    tools: tools(),
    dataDir: dir,
    spawnFn: s.spawnFn,
  });
  assert.deepEqual(a.cache, {});
  const lists: any[] = [];
  const off = a.onChange((l: any) => lists.push(l.map((h: any) => h.state)));
  assert.deepEqual(a.list()[0].login, ['fake', 'login']);
  const p1 = a.check('x');
  assert.equal(a.check('x'), p1, 'a running probe is shared');
  await p1;
  assert.deepEqual(lists, [['checking'], ['admitted']]);
  assert.equal(off(), true);
  a.file = path.join(BIN, 'cannot', 'write.json');
  a.cache.x.authMethods = undefined;
  assert.deepEqual(a.entry('x').authMethods, []);
  await a.check('x');
  assert.equal(lists.length, 2, 'removed listener not called');
});

test('admission keeps sign-in retries and prompt refusals tied to the same installation', async () => {
  let now = 0;
  let signedOut = true;
  const { o, s } = opts(Q(), {
    'session/new': () => {
      if (signedOut) throw new Error('Not logged in');
      return { sessionId: 'ready' };
    },
  });
  const a = new Admission({ ...o, ids: ['x'], file: path.join(dir, 'signed-out.json'), now: () => now });
  await a.check('x');
  delete a.cache.x.misses;
  now = 60_000;
  assert.equal((await a.current('x', { again: true })).state, 'signin');
  assert.equal(a.cache.x.misses, 1, 'an older signed-out record can start its backoff counter');
  signedOut = false;
  const reconnecting = a.check('x');
  a.signedIn('x');
  assert.equal(a.cache.x.state, 'signin', 'an active probe decides the new status');
  await reconnecting;
  const checking = a.check('x');
  a.signedOut('x', 'session/new', 'Credentials expired');
  assert.equal(a.cache.x.state, 'admitted', 'a live session result cannot interrupt the active probe');
  await checking;
  a.signedOut('x', 'session/prompt', 'Credentials expired');
  assert.equal((await a.verify('x')).reason, 'Credentials expired', 'opening a session would hide this prompt failure');
  assert.equal(s.calls.length, 4);

  const missingCopy = new Admission({ ...o, ids: ['x'], file: path.join(dir, 'missing-copy.json'), resolveBin: () => '/unstatable-new' });
  missingCopy.cache.x = { state: 'admitted', bin: '/unstatable-old', stamp: null, catalog: null };
  assert.equal(missingCopy.entry('x').state, 'checking', 'a missing file stamp cannot match an unrelated executable');
});

test('highest-version discovery preserves prompt failures and cannot satisfy an unattended check from its cache', async () => {
  let discovery: Promise<void> | undefined;
  let signedOut = false;
  const { o, s } = opts(Q(), {
    'session/new': () => {
      if (signedOut) throw new Error('Not logged in');
      return { sessionId: 'ready' };
    },
  });
  const a = new Admission({ ...o, discoverBin: () => discovery, file: path.join(dir, 'discover-overlap.json'), ids: ['x'] });
  await a.refresh();

  const gate = deferred<void>();
  discovery = gate.promise;
  const scan = a.refresh();
  signedOut = true;
  const verified = a.verify('x');
  gate.resolve();
  await scan;
  assert.equal((await verified).state, 'signin');
  assert.equal(s.calls.length, 2, 'verification actually probes authentication after a cache-only discovery');

  a.signedIn('x');
  const gate2 = deferred<void>();
  discovery = gate2.promise;
  const rescanning = a.refresh();
  a.signedOut('x', 'session/prompt', 'Credentials expired during discovery');
  gate2.resolve();
  assert.equal((await rescanning)[0].reason, 'Credentials expired during discovery');
  assert.equal((await a.verify('x')).state, 'signin');
  assert.equal(s.calls.length, 2, 'a sign-in failure from a real prompt remains until a retry that can replace it');
});

test('probe: two probes of one harness in the same millisecond register their tools under their own keys', async (t) => {
  t.mock.method(Date, 'now', () => 1);
  const a = opts(Q());
  const b = opts(Q());
  const [ra, rb] = await Promise.all([probe('x', a.o), probe('x', b.o)]);
  assert.deepEqual([ra.state, rb.state], ['admitted', 'admitted']);
  const keyOf = (o: any) => o.tools.log.find((e: any[]) => e[0] === 'prepare')[1];
  assert.match(keyOf(a.o), /^acp:x:probe-[0-9a-f-]{36}$/);
  assert.notEqual(keyOf(a.o), keyOf(b.o));
});

test('Admission: a cache write cut off halfway keeps the last good cache for the next launch', async () => {
  const home = fs.mkdtempSync(path.join(dir, 'torn-'));
  const file = path.join(home, 'admission.json');
  const s = fakeSpawn();
  const a = new Admission({
    ids: ['x'],
    file,
    quirks: () => Q(),
    resolveBin: () => BIN,
    env: () => ({}),
    tools: tools(),
    dataDir: dir,
    spawnFn: s.spawnFn,
  });
  await a.check('x');
  const saved = fs.readFileSync(file, 'utf8');
  assert.equal(JSON.parse(saved).x.state, 'admitted');
  a.cache.y = { state: 'missing' };
  const restore = tornWrites(home);
  try {
    a.save();
  } finally {
    restore();
  }
  assert.equal(fs.readFileSync(file, 'utf8'), saved);
  assert.deepEqual(fs.readdirSync(home), ['admission.json']);
});

test('Admission.current: a harness whose binary changed since its check is checked now, not read as unsupported', async () => {
  const s = fakeSpawn();
  const a = new Admission({
    ids: ['x'],
    file: path.join(dir, 'cur.json'),
    quirks: () => Q(),
    resolveBin: () => BIN,
    env: () => ({}),
    tools: tools(),
    dataDir: dir,
    spawnFn: s.spawnFn,
  });
  // checked before the CLI updated itself: the stamp no longer matches
  a.cache.x = { state: 'admitted', reason: null, version: '1', stamp: 'before the update' };
  assert.equal(a.list()[0].state, 'checking');
  const h = await a.current('x');
  assert.equal(h.state, 'admitted');
  assert.equal(s.calls.length, 1);
  // checked and current: no second probe; an unknown harness is none
  assert.equal((await a.current('x')).state, 'admitted');
  assert.equal(s.calls.length, 1);
  assert.equal(await a.current('nope'), null);
});

test('Admission.refresh: only the asked harness; a probe without a binary is cached without a stamp', async () => {
  const s = fakeSpawn();
  let bin: string | null = BIN;
  const a = new Admission({
    ids: ['x', 'y'],
    file: path.join(dir, 'r.json'),
    quirks: () => Q(),
    resolveBin: () => bin,
    env: () => ({}),
    tools: tools(),
    dataDir: dir,
    spawnFn: s.spawnFn,
  });
  const list = await a.refresh({ only: 'y' });
  assert.deepEqual(
    list.map((h: any) => [h.id, h.state]),
    [
      ['x', 'checking'],
      ['y', 'admitted'],
    ],
  );
  assert.equal(s.calls.length, 1);
  // the binary goes away between the list and the probe
  const p = a.check('x');
  bin = null;
  await p;
  bin = BIN;
  const fresh = new Admission({
    ids: ['x'],
    file: path.join(dir, 'r2.json'),
    quirks: () => Q(),
    resolveBin: () => null,
    env: () => ({}),
    tools: tools(),
    dataDir: dir,
    spawnFn: s.spawnFn,
  });
  await fresh.check('x');
  assert.deepEqual([fresh.cache.x.state, fresh.cache.x.stamp], ['missing', null]);
});

test('probe: a non-Error failure is reported as is', async () => {
  const { o } = opts(Q());
  o.tools = {
    ...tools(),
    prepare: async () => {
      throw 'tools down';
    },
  };
  assert.equal((await probe('x', o)).reason, 'Tools down.');
});

test('Admission: a killed harness is off; admitted(); unknown quirks use the id; force re-probes', async () => {
  const s = fakeSpawn();
  let killed: string | null = null;
  const a = new Admission({
    ids: ['x', 'z'],
    file: path.join(dir, 'k.json'),
    quirks: (id: string) => (id === 'x' ? Q() : null),
    resolveBin: (id: string) => (id === 'x' ? BIN : null),
    killed: () => killed,
    env: () => ({}),
    tools: tools(),
    dataDir: dir,
    spawnFn: s.spawnFn,
  });
  await a.refresh();
  assert.equal(a.admitted('x'), true);
  assert.equal(a.admitted('z'), false);
  assert.equal(a.list()[1].label, 'z');
  killed = 'Turned off remotely';
  assert.deepEqual([a.list()[0].state, a.list()[0].reason], ['off', 'Turned off remotely']);
  assert.equal(a.admitted('x'), false);
  killed = null;
  await a.refresh();
  assert.equal(s.calls.length, 1, 'fresh results are not probed again');
  await a.refresh({ force: true });
  assert.equal(s.calls.length, 2);
  const noKill = new Admission({
    ids: ['x'],
    file: path.join(dir, 'k.json'),
    quirks: () => Q(),
    resolveBin: () => BIN,
    env: () => ({}),
    tools: tools(),
    dataDir: dir,
    spawnFn: s.spawnFn,
  });
  assert.equal(noKill.admitted('x'), true, 'read from the cache file');
});
