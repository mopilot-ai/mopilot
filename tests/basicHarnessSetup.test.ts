// A basic harness that asks for no sign-in but can't run a turn until it is set up (dsh without a DeepSeek key, #1201):
// admission reads its session's lack of a model, and a turn that fails for it flips it to Signed out with how to set it
// up, in main (admission.cjs, acp/signin.cjs, acp.cjs) and in the quirks that name it (quirks/dsh.cjs).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeSpawn, INIT } from './support/electron-acp-fake.ts';
import { setup as hostSetup, until, KEY, CWD } from './support/acp-host/fixture.ts';
import { noProviderError, turnError } from './fixtures/fake-acp-dsh.mjs';

const require = createRequire(import.meta.url);
const { Admission, probe, isAuthError } = require('../electron/harness/admission.cjs');
const { setupFailure, hasModel } = require('../electron/harness/acp/signin.cjs');
const { recentIgnored, clearIgnored } = require('../electron/ignored.cjs');
const quirks = require('../electron/harness/quirks/index.cjs');
const dsh = require('../electron/harness/quirks/dsh.cjs');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AGENT = path.join(ROOT, 'tests/fixtures/fake-acp-agent.mjs');
const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'basic-setup-')));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const BIN = path.join(dir, 'fake-bin');
fs.writeFileSync(BIN, 'x');

const REASON = 'Add a key: put KEY=<key> in ~/.x/.env';
const SETUP = { model: true, error: /has no provider\/model/, reason: REASON };
const Q = (extra: any = {}) => ({
  label: 'Fake',
  bins: ['fake'],
  args: ['acp'],
  privacyDefaults: [],
  admission: { handshakeTimeoutMs: 1000 },
  setup: SETUP,
  ...extra,
});
const tools = () => ({ prepare: async () => ({ mcpServers: [] }), admission: async () => true, end: () => {} });
const MODEL = { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'p/m', options: [] };
const DSH_WORDS = noProviderError('S1');

test("dsh quirks: its setup is valid, names the key and where it goes, and matches its own turn failures' words", () => {
  assert.deepEqual(quirks.validate(dsh), []);
  assert.equal(dsh.setup.model, true);
  // dsh 0.2.0-rc.2's words (VM, #1201): no key, a key the API rejects, no provider for its acp row
  for (const words of [
    turnError({ needsKey: true }, null, 'S1', {})!,
    'Internal error: turn failed: Authentication Fails, Your api key: ****-key is invalid (request_id: 1)',
    DSH_WORDS,
  ])
    assert.ok(dsh.setup.error.test(words), words);
  assert.ok(!dsh.setup.error.test('Internal error: disk full'));
  assert.match(dsh.setup.reason, /DEEPSEEK_API_KEY/);
  assert.match(dsh.setup.reason, /~\/\.dsh\/\.env/);
  // the other basic harnesses ask for a sign-in themselves (VM sweep in #1201): none names a setup
  for (const id of quirks.ids().filter((x: string) => x !== 'dsh' && x !== 'omp')) assert.equal(quirks.quirks(id).setup, undefined, id);
});

test('quirks: setup needs a reason, and its error must be a RegExp', () => {
  const ok = Q();
  assert.deepEqual(quirks.validate(ok), []);
  assert.deepEqual(quirks.validate({ ...ok, setup: { reason: 'r' } }), []);
  assert.deepEqual(quirks.validate({ ...ok, setup: {} }), ['setup']);
  assert.deepEqual(quirks.validate({ ...ok, setup: { reason: '' } }), ['setup']);
  assert.deepEqual(quirks.validate({ ...ok, setup: 'r' }), ['setup']);
  assert.deepEqual(quirks.validate({ ...ok, setup: { reason: 'r', error: 'has no provider' } }), ['setup']);
  assert.deepEqual(quirks.validate({ ...ok, setup: { reason: 'r', ready: true } }), ['setup']);
  assert.deepEqual(quirks.validate({ ...ok, setup: { reason: 'r', ready: () => true } }), []);
  // one that keeps its place between tests would read the same failure differently the next time
  assert.deepEqual(quirks.validate({ ...ok, setup: { reason: 'r', error: /no key/g } }), ['setup']);
  assert.deepEqual(quirks.validate({ ...ok, setup: { reason: 'r', error: /no key/y } }), ['setup']);
  assert.deepEqual(quirks.validate({ ...ok, setup: { reason: 'r', error: /no key/i } }), []);
});

test("dsh's patch changes only its two privacy rows: a row there replaces that row's whole config", () => {
  const ids = [...dsh._test.PATCH.matchAll(/^- id: (\S+)/gm)].map((m: RegExpMatchArray) => m[1]);
  assert.deepEqual(ids, ['session-log-deepseek', 'session-telemetry-otel']);
});

test("dsh hasKey: the key where dsh looks (env, its credentials, its .env under DSH_HOME), never one that isn't set", () => {
  const home = fs.mkdtempSync(path.join(dir, 'home-'));
  const dshHome = path.join(home, '.dsh');
  const has = (env: any = {}) => dsh._test.hasKey({ env, home });
  assert.equal(has(), false, 'no ~/.dsh at all');
  assert.equal(has({ DEEPSEEK_API_KEY: 'k' }), true);
  assert.equal(has({ DEEPSEEK_API_KEY: '' }), false);
  fs.mkdirSync(dshHome);
  for (const [text, want] of [
    ['DEEPSEEK_API_KEY=k\n', true],
    ['# a comment\nexport DEEPSEEK_API_KEY = k', true],
    ['DEEPSEEK_API_KEY=\n', false],
    ['# DEEPSEEK_API_KEY=k\nOTHER_DEEPSEEK_API_KEY=k', false],
  ] as const) {
    fs.writeFileSync(path.join(dshHome, '.env'), text);
    assert.equal(has(), want, text);
  }
  fs.rmSync(path.join(dshHome, '.env'));
  fs.writeFileSync(path.join(dshHome, '.credentials.yaml'), 'version: 1\nrefs:\n  DEEPSEEK_API_KEY: sk-x\n');
  assert.equal(has(), true, 'the key its Models page saves');
  fs.writeFileSync(path.join(dshHome, '.credentials.yaml'), 'version: 1\nrecords:\n  llm-deepseek/default:\n    kind: api-key\n');
  assert.equal(has(), true, 'an api-key record under a deepseek scope');
  fs.writeFileSync(path.join(dshHome, '.credentials.yaml'), 'version: 1\nrecords:\n  github/token:\n    kind: grant\n');
  assert.equal(has(), false, "another service's record");
  fs.writeFileSync(path.join(dshHome, '.credentials.yaml'), 'version: 1\n');
  assert.equal(has(), false);
  // the .env of the folder MoPilot starts it in: the home folder
  fs.writeFileSync(path.join(home, '.env'), 'DEEPSEEK_API_KEY=k\n');
  assert.equal(has(), true);
  fs.rmSync(path.join(home, '.env'));
  // DSH_HOME moves it; a home that can't be read is no key, and noted
  const other = path.join(home, 'other');
  fs.mkdirSync(other);
  fs.writeFileSync(path.join(other, '.env'), 'DEEPSEEK_API_KEY=k');
  assert.equal(has({ DSH_HOME: other }), true);
  fs.mkdirSync(path.join(other, '.credentials.yaml'));
  fs.rmSync(path.join(other, '.env'));
  clearIgnored();
  assert.equal(has({ DSH_HOME: other }), false);
  assert.match(JSON.stringify(recentIgnored()), /read dsh's \.credentials\.yaml/);
  // with no arguments it reads this process's environment and home
  assert.equal(typeof dsh._test.hasKey(), 'boolean');
  assert.equal(dsh.setup.ready({ env: { DEEPSEEK_API_KEY: 'k' } }), true);
});

test("hasModel: a model option with a value, or ACP's current model; anything else is no model (B1, B3)", () => {
  for (const s of [null, undefined, {}, { configOptions: null }, { configOptions: {} }, { configOptions: [] }, { models: null }])
    assert.equal(hasModel(s), false, JSON.stringify(s));
  assert.equal(hasModel({ configOptions: [null, { ...MODEL, category: 'thought_level' }] }), false);
  assert.equal(hasModel({ configOptions: [{ ...MODEL, currentValue: '' }] }), false);
  assert.equal(hasModel({ configOptions: [{ ...MODEL, currentValue: 3 }] }), false);
  assert.equal(hasModel({ models: { currentModelId: '' } }), false);
  assert.equal(hasModel({ configOptions: [MODEL] }), true);
  assert.equal(hasModel({ configOptions: [MODEL], extra: 1 }), true);
  assert.equal(hasModel({ models: { availableModels: [], currentModelId: 'm' } }), true);
});

test('setupFailure: only words its quirks name become a sign-in failure that says how; others pass as they are', () => {
  const raw = Object.assign(new Error(DSH_WORDS), { code: -32603, said: DSH_WORDS });
  assert.equal(setupFailure(null, raw), raw);
  assert.equal(setupFailure(Q({ setup: undefined }), raw), raw);
  assert.equal(setupFailure(Q({ setup: { reason: REASON } }), raw), raw, 'no error words: nothing matches');
  assert.equal(setupFailure(Q({ setup: { reason: REASON, error: 'has no provider' } }), raw), raw);
  const other = Object.assign(new Error('disk full'), { code: -32603 });
  assert.equal(setupFailure(Q(), other), other);
  // the agent's own words count, not the detail it adds (said); a plain message is read when there is no said
  assert.equal(setupFailure(Q(), Object.assign(new Error(`x · ${DSH_WORDS}`), { said: 'x' })).code, undefined);
  // a thrown non-error carries no agent words (as isAuthError reads it)
  assert.equal(setupFailure(Q(), DSH_WORDS), DSH_WORDS);
  for (const e of [raw, new Error(DSH_WORDS)]) {
    const f = setupFailure(Q(), e);
    assert.deepEqual([f.message, f.code, f.said, f.setup], [`Fake: ${REASON}`, -32000, REASON, REASON]);
    assert.equal(isAuthError(f), true);
  }
});

function opts(q: any, handlers: any) {
  const s = fakeSpawn(handlers);
  return { quirks: () => q, resolveBin: () => BIN, env: () => ({}), tools: tools(), dataDir: dir, spawnFn: s.spawnFn };
}

test('probe: a session with no model reads Signed out with how to set it up; with a model it is admitted', async () => {
  const none = await probe('x', opts(Q(), { 'session/new': () => ({ sessionId: 'S1', configOptions: [] }) }));
  assert.deepEqual([none.state, none.reason], ['signin', REASON]);
  const withModel = await probe('x', opts(Q(), { 'session/new': () => ({ sessionId: 'S1', configOptions: [MODEL] }) }));
  assert.deepEqual([withModel.state, withModel.reason], ['admitted', null]);
  // a harness whose quirks don't say it needs a model is admitted as before (its models may come later, or not at all)
  const plain = await probe('x', opts(Q({ setup: { reason: REASON } }), { 'session/new': () => ({ sessionId: 'S1' }) }));
  assert.equal(plain.state, 'admitted');
  const noSetup = await probe('x', opts(Q({ setup: undefined }), { 'session/new': () => ({ sessionId: 'S1' }) }));
  assert.equal(noSetup.state, 'admitted');
});

test("probe: quirks that find it not set up (ready) read Signed out with how, given the harness's own environment", async () => {
  const seen: any[] = [];
  const ready = (ok: boolean) => async (ctx: any) => (seen.push(ctx.env), ok);
  const q = (ok: boolean) => Q({ env: { Q: '1' }, launch: () => ({ args: [], env: { L: '1' } }), setup: { ...SETUP, ready: ready(ok) } });
  const handlers = { 'session/new': () => ({ sessionId: 'S1', configOptions: [MODEL] }) };
  const no = await probe('x', opts(q(false), handlers));
  assert.deepEqual([no.state, no.reason], ['signin', REASON]);
  assert.deepEqual(seen[0], { Q: '1', L: '1' });
  assert.equal((await probe('x', opts(q(true), handlers))).state, 'admitted');
  // a check that fails is not set up (and noted), not an unsupported version
  clearIgnored();
  const thrown = Q({ setup: { ...SETUP, ready: () => Promise.reject(new Error('EACCES')) } });
  const r = await probe('x', opts(thrown, handlers));
  assert.deepEqual([r.state, r.reason], ['signin', REASON]);
  assert.match(JSON.stringify(recentIgnored()), /check that Fake is set up/);
});

test('probe: session/new failing in the words its quirks name reads Signed out with how, though it lists no sign-in', async () => {
  const fail = (msg: string) => () => {
    throw Object.assign(new Error(msg), { code: -32603 });
  };
  const r = await probe('x', opts(Q(), { initialize: () => INIT({}, { authMethods: [] }), 'session/new': fail(DSH_WORDS) }));
  assert.deepEqual([r.state, r.reason], ['signin', REASON]);
  // other failures stay what they were: unsupported, or a sign-in when it lists sign-in methods, in the agent's words
  const other = await probe('x', opts(Q(), { 'session/new': fail('boom') }));
  assert.deepEqual([other.state, other.reason], ['unsupported', 'Boom.']);
  const listed = await probe('x', opts(Q(), { initialize: () => INIT({}, { authMethods: [{ id: 'o' }] }), 'session/new': fail('boom') }));
  assert.deepEqual([listed.state, listed.reason], ['signin', 'boom']);
});

test('probe, against the fake agent run the way dsh is: no provider or no key reads Signed out; set up, admitted', async () => {
  const state = path.join(dir, 'dsh-state');
  const run = (profile: object, env: object = {}) => {
    const q = Q({
      args: [AGENT],
      env: { FAKE_ACP_STATE: state, FAKE_ACP_PROFILE: JSON.stringify(profile), ...env },
      setup: { ...SETUP, ready: dsh.setup.ready },
    });
    return probe('dsh', { ...opts(q, {}), resolveBin: () => process.execPath, spawnFn: undefined });
  };
  const key = { DEEPSEEK_API_KEY: 'k' };
  // its acp row with no provider: no model, key or not
  assert.deepEqual(await run({ noProvider: true }, key).then((r: any) => [r.state, r.reason]), ['signin', REASON]);
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, 'provider'), '');
  assert.equal((await run({ noProvider: true }, key)).state, 'admitted');
  // on its default model with no key anywhere dsh looks
  const dshHome = fs.mkdtempSync(path.join(dir, 'dsh-home-'));
  assert.deepEqual(await run({ needsKey: true }, { DSH_HOME: dshHome }).then((r: any) => [r.state, r.reason]), ['signin', REASON]);
  fs.writeFileSync(path.join(dshHome, '.env'), 'DEEPSEEK_API_KEY=k\n');
  assert.equal((await run({ needsKey: true }, { DSH_HOME: dshHome })).state, 'admitted');
});

test('the fake dsh: a turn fails in its words with no provider or no key, and runs once it has both', () => {
  const home = fs.mkdtempSync(path.join(dir, 'fake-home-'));
  assert.equal(turnError({}, null, 'S'), null);
  assert.equal(turnError({ noProvider: true }, null, 'S'), noProviderError('S'));
  assert.match(turnError({ needsKey: true }, null, 'S', { HOME: home })!, /no API key for provider route/);
  assert.match(turnError({ needsKey: true }, null, 'S', {})!, /no API key/);
  assert.equal(turnError({ needsKey: true }, null, 'S', { DEEPSEEK_API_KEY: 'k' }), null);
  fs.mkdirSync(path.join(home, '.dsh'));
  fs.writeFileSync(path.join(home, '.dsh', '.env'), 'DEEPSEEK_API_KEY=k');
  assert.equal(turnError({ needsKey: true }, null, 'S', { HOME: home }), null);
});

/** An Admission over a fake agent whose session has a model until `provider` is unset; the clock is the test's. */
function admission(q: any = Q()) {
  const st = { provider: true, now: 1_000_000 };
  const s = fakeSpawn({ 'session/new': () => ({ sessionId: 'S', configOptions: st.provider ? [MODEL] : [] }) });
  const a = new Admission({
    ...opts(q, {}),
    spawnFn: s.spawnFn,
    ids: ['x'],
    file: path.join(fs.mkdtempSync(path.join(dir, 'adm-')), 'cache.json'),
    now: () => st.now,
  });
  return { a, st, state: () => a.list()[0].state, reason: () => a.list()[0].reason };
}

test('Admission: a turn that fails for the setup reads Signed out with how, until Re-check finds it set up (A3)', async () => {
  const { a, st, state, reason } = admission();
  await a.refresh();
  assert.equal(state(), 'admitted');
  st.provider = false;
  a.signedOut('x', 'session/prompt', REASON);
  assert.deepEqual([state(), reason(), a.cache.x.promptAuth], ['signin', REASON, true]);
  // a key the API rejected looks set up to a check: focus checks leave it, as they leave a sign-in only a prompt saw
  st.now += 60 * 60_000;
  await a.recheckSignedOut();
  assert.deepEqual([state(), reason()], ['signin', REASON]);
  // Re-check while it still isn't set up says so, and how; once it is, it is Ready
  await a.refresh({ force: true });
  assert.deepEqual([state(), reason()], ['signin', REASON]);
  st.provider = true;
  await a.refresh({ force: true });
  assert.deepEqual([state(), reason()], ['admitted', null]);
  // a plain sign-in keeps its words, and session/new is never prompt-only
  a.signedOut('x', 'session/prompt');
  assert.deepEqual([state(), reason()], ['signin', 'Sign in to Fake first']);
  await a.refresh({ force: true });
  a.signedOut('x', 'session/new', REASON);
  assert.deepEqual([reason(), a.cache.x.promptAuth], [REASON, false]);
});

test('a chat turn that fails for the setup: the chat says how, and the harness reads Signed out (B4)', async () => {
  const t = hostSetup({
    quirks: (id: string) => (id === 'fake' ? Q() : null),
    handlers: {
      'session/prompt': () => {
        throw Object.assign(new Error(DSH_WORDS), { code: -32603 });
      },
    },
  });
  const out: any[] = [];
  t.host.signedOutFn = (...a: any[]) => out.push(a);
  await t.host.send(KEY, { cwd: CWD, blocks: [{ type: 'text', text: 'hi' }] });
  await until(() => t.kinds().includes('turnEnd'));
  assert.equal(t.events.at(-1).error, `Fake: ${REASON}`);
  assert.deepEqual(out, [['fake', 'session/prompt', REASON]]);
  // any other failure is the harness's own words, and signs nothing out
  const other = hostSetup({
    quirks: (id: string) => (id === 'fake' ? Q() : null),
    handlers: {
      'session/prompt': () => {
        throw Object.assign(new Error('disk full'), { code: -32603 });
      },
    },
  });
  other.host.signedOutFn = (...a: any[]) => out.push(a);
  await other.host.send(KEY, { cwd: CWD, blocks: [] });
  await until(() => other.kinds().includes('turnEnd'));
  assert.equal(other.events.at(-1).error, 'disk full');
  assert.equal(out.length, 1);
});

test("a chat's session/new that fails for the setup rejects saying how, as a sign-in failure (login_required for peers)", async () => {
  const t = hostSetup({
    quirks: (id: string) => (id === 'fake' ? Q() : null),
    handlers: {
      'session/new': () => {
        throw Object.assign(new Error(DSH_WORDS), { code: -32603 });
      },
    },
  });
  const out: any[] = [];
  t.host.signedOutFn = (...a: any[]) => out.push(a);
  const e = await t.host.ensure(KEY, { cwd: CWD }).catch((x: any) => x);
  assert.equal(e.message, `Fake: ${REASON}`);
  assert.equal(isAuthError(e), true);
  assert.deepEqual(out, [['fake', 'session/new', REASON]]);
  // a sign-in failure is passed on as it was, with no setup reason
  const auth = hostSetup({
    handlers: {
      'session/new': () => {
        throw Object.assign(new Error('Authentication required'), { code: -32000 });
      },
    },
  });
  auth.host.signedOutFn = (...a: any[]) => out.push(a);
  assert.equal((await auth.host.ensure(KEY, { cwd: CWD }).catch((x: any) => x)).message, 'Authentication required');
  assert.deepEqual(out[1], ['fake', 'session/new', null]);
});
