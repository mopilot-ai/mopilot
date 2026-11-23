// An ACP agent that asks for no sign-in counts as signed in on a Host (host/src/noSignIn.mjs, harnessState.mjs): a machine with only such an agent is Online instead of waiting for a recorded sign-in (F-C).
import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore: plain ESM without declarations
import { createNoSignIn } from '../host/src/noSignIn.mjs';
import { listHarnesses } from '../host/src/harnessState.mjs';
import { fakeSpawn, INIT, NO_REPLY } from './support/electron-acp-fake.ts';

const quirk = (over: Record<string, unknown> = {}) => ({
  label: 'Fake',
  args: ['--acp'],
  env: { A: '1' },
  admission: {},
  ...over,
});
const make = (handlers: Record<string, any>, over: Record<string, unknown> = {}, q: any = quirk()) => {
  const fake = fakeSpawn(handlers);
  const probe = createNoSignIn({
    env: { PATH: '/x' },
    spawnFn: fake.spawnFn,
    quirksOf: (id: string) => (id === 'fake' ? q : null),
    ...over,
  });
  return { ...fake, probe };
};

test('an agent whose initialize lists no login methods asks for no sign-in; one that lists methods does not', async () => {
  let reply: any;
  const open = make({
    initialize: async (_p: any, proc: any) => {
      reply = await proc.request('fs/read_text_file', { path: '/etc/hosts' });
      return INIT({}, { authMethods: [] });
    },
  });
  assert.equal(await open.probe.check('fake', '/bin/fake'), true);
  assert.deepEqual(open.calls[0].args, ['--acp']);
  assert.equal(open.calls[0].options.env.A, '1');
  assert.match(JSON.stringify(reply), /not during a probe/, 'the agent is given no files');
  const gated = make({ initialize: () => INIT({}, { authMethods: [{ id: 'oauth', name: 'Sign in' }] }) });
  assert.equal(await gated.probe.check('fake', '/bin/fake'), false);
});

test('an unknown harness, one that names a setup, a silent one and a refused start are never called signed in', async () => {
  assert.equal(await make({}).probe.check('other', '/bin/o'), false);
  assert.equal(await make({}, {}, quirk({ setup: { reason: 'Needs a key' } })).probe.check('fake', '/bin/fake'), false);
  const silent = make({ initialize: () => NO_REPLY }, { probeMs: 20 });
  assert.equal(await silent.probe.check('fake', '/bin/fake'), false);
  const refused = make({}, {}, quirk({ admission: { privacyGate: async () => ({ ok: false, reason: 'telemetry' }) } }));
  assert.equal(await refused.probe.check('fake', '/bin/fake'), false);
  assert.equal(refused.calls.length, 0, 'the agent is not started when its privacy gate refuses');
  const broken = make({}, {}, quirk({ launch: async () => Promise.reject(new Error('no files')) }));
  assert.equal(await broken.probe.check('fake', '/bin/fake'), false);
});

test('a launch function and a passing privacy gate decide the arguments; the answer is kept until it expires', async () => {
  let t = 0;
  const q = quirk({
    args: undefined,
    launch: async () => ({ args: ['serve'], env: { B: '2' } }),
    admission: { privacyGate: async () => ({ ok: true }) },
  });
  const m = make({ initialize: () => INIT() }, { now: () => t }, q);
  assert.equal(await m.probe.check('fake', '/bin/fake'), true);
  assert.deepEqual(m.calls[0].args, ['serve']);
  assert.equal(m.calls[0].options.env.B, '2');
  await m.probe.check('fake', '/bin/fake');
  assert.equal(m.calls.length, 1, 'asked once within the keep time');
  await m.probe.check('fake', '/bin/other');
  assert.equal(m.calls.length, 2, 'another binary is another answer');
  t = 11 * 60_000;
  await m.probe.check('fake', '/bin/fake');
  assert.equal(m.calls.length, 3, 'asked again after it expires');
});

test("the default quirks lookup is the app's own: a catalog agent with a setup is not guessed ready", async () => {
  const real = createNoSignIn({ env: {}, probeMs: 20 });
  assert.equal(await real.check('not-a-harness', '/bin/none'), false);
});

test('listHarnesses marks a detected agent that asks for no sign-in as signed in, and asks nothing for a missing or already signed-in one', async () => {
  const asked: string[] = [];
  const noSignIn = { check: async (id: string) => (asked.push(id), id === 'open') };
  const out = await listHarnesses({
    env: {},
    which: (() => null) as any,
    acp: [
      { id: 'open', bin: '/b/open', signedIn: false },
      { id: 'gated', bin: '/b/gated', signedIn: false },
      { id: 'done', bin: '/b/done', signedIn: true },
      { id: 'gone', bin: null, signedIn: false },
    ],
    noSignIn,
  });
  assert.deepEqual(
    out.slice(2).map((h) => [h.id, h.detected, h.signedIn]),
    [
      ['open', true, true],
      ['gated', true, false],
      ['done', true, true],
      ['gone', false, false],
    ],
  );
  assert.deepEqual(asked.sort(), ['gated', 'open']);
});

const GATED = {
  authMethods: [
    { id: 'opencode-login', name: 'Login with opencode' },
    { id: 'key', name: 'API key' },
  ],
};

test('an agent that lists a login but starts a session with none and reports models runs without a sign-in (#4815)', async () => {
  const free = make({
    initialize: () => INIT({}, GATED),
    'session/new': () => ({
      sessionId: 's1',
      configOptions: [
        { id: 'model', category: 'model', type: 'select', currentValue: 'free-1', options: [{ value: 'free-1', name: 'Free 1' }] },
      ],
    }),
  });
  assert.deepEqual(await free.probe.inspect('fake', '/bin/fake'), { ready: true, methods: ['Login with opencode', 'API key'] });
  assert.equal(await free.probe.check('fake', '/bin/fake'), true);
});

test('an agent that lists a login and refuses a session without it, or reports no models, still needs one, and says which (#4815)', async () => {
  const refuses = make({
    initialize: () => INIT({}, GATED),
    'session/new': () => {
      throw Object.assign(new Error('authentication required'), { code: -32000 });
    },
  });
  assert.deepEqual(await refuses.probe.inspect('fake', '/bin/fake'), { ready: false, methods: ['Login with opencode', 'API key'] });
  const empty = make({ initialize: () => INIT({}, GATED), 'session/new': () => ({ sessionId: 's1' }) });
  assert.deepEqual(await empty.probe.inspect('fake', '/bin/fake'), { ready: false, methods: ['Login with opencode', 'API key'] });
  // a method with no name is told by its id, one with neither is left out
  const bare = make({ initialize: () => INIT({}, { authMethods: [{ id: 'oauth' }, {}] }), 'session/new': () => ({ sessionId: 's1' }) });
  assert.deepEqual((await bare.probe.inspect('fake', '/bin/fake')).methods, ['oauth']);
});

test('listHarnesses reports the logins an agent that is not ready lists, and none for one that is ready or missing (#4815)', async () => {
  const noSignIn = {
    check: async () => false,
    inspect: async (id: string) =>
      id === 'free' ? { ready: true, methods: ['Login'] } : { ready: false, methods: ['Google login', 'API key', 'c', 'd', 'e'] },
  };
  const out = await listHarnesses({
    env: {},
    which: (() => null) as any,
    acp: [
      { id: 'free', bin: '/b/free', signedIn: false },
      { id: 'gated', bin: '/b/gated', signedIn: false },
      { id: 'done', bin: '/b/done', signedIn: true },
      { id: 'gone', bin: null, signedIn: false },
    ],
    noSignIn,
  });
  assert.deepEqual(
    out.slice(2).map((h) => [h.id, h.signedIn, (h as any).signIn]),
    [
      ['free', true, undefined],
      ['gated', false, ['Google login', 'API key', 'c', 'd']],
      ['done', true, undefined],
      ['gone', false, undefined],
    ],
  );
});

test('a probe that did not answer is asked again after 30 seconds, an answer is kept ten minutes (opencode on a slow first start)', async () => {
  let t = 0;
  let starts = 0;
  const m = make(
    {
      initialize: () => (starts++ === 0 ? NO_REPLY : INIT()),
    },
    { now: () => t, probeMs: 20 },
  );
  assert.equal(await m.probe.check('fake', '/bin/fake'), false, 'the first start did not answer in time');
  t = 29_000;
  assert.equal(await m.probe.check('fake', '/bin/fake'), false);
  assert.equal(m.calls.length, 1, 'not asked again within 30 seconds');
  t = 31_000;
  assert.equal(await m.probe.check('fake', '/bin/fake'), true, 'asked again after 30 seconds: the agent runs without a sign-in');
  assert.equal(m.calls.length, 2);
  t = 31_000 + 9 * 60_000;
  assert.equal(await m.probe.check('fake', '/bin/fake'), true);
  assert.equal(m.calls.length, 2, 'an answer is kept for ten minutes');
});

test('a probe that did not answer reads as checking, not as a sign-in the person has to do, and an answer never does', async () => {
  const silent = make({ initialize: () => NO_REPLY }, { probeMs: 20 });
  assert.deepEqual(await silent.probe.inspect('fake', '/bin/fake'), { ready: false, methods: [], checking: true });
  const gated = make({ initialize: () => INIT({}, GATED), 'session/new': () => ({ sessionId: 's1' }) });
  assert.deepEqual(await gated.probe.inspect('fake', '/bin/fake'), { ready: false, methods: ['Login with opencode', 'API key'] });
  const out = await listHarnesses({
    env: {},
    which: (() => null) as any,
    acp: [
      { id: 'slow', bin: '/b/slow', signedIn: false },
      { id: 'gated', bin: '/b/gated', signedIn: false },
    ],
    noSignIn: {
      check: async () => false,
      inspect: async (id: string) =>
        id === 'slow' ? { ready: false, methods: [], checking: true as const } : { ready: false, methods: ['Login'] },
    },
  });
  assert.deepEqual(
    out.slice(2).map((h) => [h.id, (h as any).checking, (h as any).signIn]),
    [
      ['slow', true, undefined],
      ['gated', undefined, ['Login']],
    ],
  );
});
