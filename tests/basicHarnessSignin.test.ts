// Basic (ACP) harnesses' sign-in state: a chat that fails asking for a sign-in marks the harness signed out, one that
// reads signed out is checked again (window focus, a new chat, a peer delivery, an unattended run) with a back-off, and
// a sign-in a prompt asked for is kept until a prompt goes through or Re-check.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fakeSpawn } from './support/electron-acp-fake.ts';
import { setup as hostSetup, until, KEY, CWD } from './support/acp-host/fixture.ts';

const require = createRequire(import.meta.url);
const { Admission, RECHECK_MS } = require('../electron/harness/admission.cjs');
const { isAuthError, signInReason } = require('../electron/harness/acp/signin.cjs');
const { openAdmission, NO_SAGE_MCP } = require('../electron/app/acpAdmission.cjs');
const { recentIgnored, clearIgnored } = require('../electron/ignored.cjs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'basic-signin-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
const BIN = path.join(dir, 'fake-bin');
fs.writeFileSync(BIN, 'x');
const Q = { label: 'Fake', bins: ['fake'], args: ['acp'], privacyDefaults: [], admission: { handshakeTimeoutMs: 1000 } };
const tools = () => ({ prepare: async () => ({ mcpServers: [] }), admission: async () => true, end: () => {} });

/** An Admission over a fake agent whose session/new succeeds until `signedOut` is set; the clock is the test's. */
function admission(o: { ids?: string[]; file?: string } = {}) {
  const st = { signedOut: false, now: 1_000_000 };
  const s = fakeSpawn({
    'session/new': () => {
      if (st.signedOut) throw Object.assign(new Error('Authentication required'), { code: -32000 });
      return { sessionId: 's' };
    },
  });
  const a = new Admission({
    ids: o.ids ?? ['x'],
    file: o.file ?? path.join(dir, `${Math.random()}.json`),
    quirks: () => Q,
    resolveBin: () => BIN,
    env: () => ({}),
    tools: tools(),
    dataDir: dir,
    spawnFn: s.spawnFn,
    now: () => st.now,
  });
  const changes: string[][] = [];
  a.onChange((list: any[]) => changes.push(list.map((h) => h.state)));
  return { a, s, st, changes, state: (id = 'x') => a.list().find((h: any) => h.id === id).state };
}

test('B-1: a chat that asks for a sign-in marks an admitted harness signed out, saves it and tells windows', async () => {
  const { a, state, changes } = admission();
  await a.refresh();
  assert.equal(state(), 'admitted');
  changes.length = 0;
  a.signedOut('x');
  assert.equal(state(), 'signin');
  assert.equal(a.list()[0].reason, 'Sign in to Fake first');
  assert.deepEqual(changes, [['signin']]);
  assert.equal(JSON.parse(fs.readFileSync(a.file, 'utf8')).x.state, 'signin', 'saved: a restart still reads it');
  // only an admitted harness: one already signed out, unchecked, or being checked is left alone
  a.signedOut('x');
  a.signedOut('nope');
  assert.equal(changes.length, 1);
  const p = a.check('x');
  const before = changes.length;
  a.cache.x.state = 'admitted';
  a.signedOut('x');
  assert.equal(changes.length, before, 'a check under way decides for itself');
  await p;
});

test('B-1: a signed-out harness is checked again on focus, at most once per RECHECK_MS, and is Ready once signed in', async () => {
  const { a, s, st, state } = admission({ ids: ['x', 'y'] });
  st.signedOut = true;
  await a.refresh();
  assert.deepEqual([state('x'), state('y')], ['signin', 'signin']);
  const probes = s.calls.length;
  // just checked: a focus right away probes nothing
  await a.recheckSignedOut();
  assert.equal(s.calls.length, probes);
  // the user signed in from their own terminal, then came back
  st.signedOut = false;
  st.now += RECHECK_MS;
  const list = await a.recheckSignedOut();
  assert.deepEqual(
    list.map((h: any) => h.state),
    ['admitted', 'admitted'],
  );
  assert.equal(s.calls.length, probes + 2);
  // an admitted harness is not probed on focus
  st.now += RECHECK_MS;
  await a.recheckSignedOut();
  assert.equal(s.calls.length, probes + 2);
});

test('B-1/B-6: current({again}) re-checks a stale signed-out entry; verify() always checks; unknown ids are none', async () => {
  const { a, s, st, state } = admission();
  st.signedOut = true;
  await a.refresh();
  const probes = s.calls.length;
  // fresh: read from the cache, with or without `again`
  assert.equal((await a.current('x', { again: true })).state, 'signin');
  assert.equal(s.calls.length, probes);
  st.signedOut = false;
  st.now += RECHECK_MS;
  assert.equal((await a.current('x')).state, 'signin', 'without again the cache answers');
  assert.equal((await a.current('x', { again: true })).state, 'admitted');
  assert.equal(s.calls.length, probes + 1);
  // the sign-in lapsed while the cache says Ready: only verify() finds out
  st.signedOut = true;
  assert.equal((await a.current('x', { again: true })).state, 'admitted');
  assert.equal((await a.verify('x')).state, 'signin');
  assert.equal(state(), 'signin');
  assert.equal(await a.verify('nope'), null);
});

test('B-1: a sign-in a prompt asked for survives checks (they only open a session) until a prompt or Re-check clears it', async () => {
  const { a, s, st, state, changes } = admission();
  await a.refresh();
  a.signedOut('x', 'session/prompt');
  assert.equal(state(), 'signin');
  const probes = s.calls.length;
  st.now += 100 * RECHECK_MS;
  // focus, a new chat, a peer delivery and an unattended run all leave it alone: a check would read Ready
  await a.recheckSignedOut();
  assert.equal((await a.current('x', { again: true })).state, 'signin');
  assert.equal((await a.verify('x')).state, 'signin');
  assert.equal(s.calls.length, probes);
  // a prompt that goes through clears it; one already admitted or being checked is left alone
  changes.length = 0;
  a.signedIn('x');
  assert.equal(state(), 'admitted');
  assert.deepEqual(changes, [['admitted']]);
  a.signedIn('x');
  a.signedIn('nope');
  assert.equal(changes.length, 1);
  // Re-check (a forced check) clears it too
  a.signedOut('x', 'session/prompt');
  await a.refresh({ force: true });
  assert.equal(state(), 'admitted');
  a.signedOut('x', 'session/prompt');
  const p = a.check('x');
  a.signedIn('x');
  await p;
  assert.equal(a.cache.x.promptAuth, undefined, 'the check decided');
});

test('B-1: a harness that stays signed out is checked half as often each time, up to a cap', async () => {
  const { a, s, st } = admission();
  st.signedOut = true;
  await a.refresh();
  const due = () => a.stale(a.list()[0]);
  const waits: number[] = [];
  for (let i = 0; i < 8; i++) {
    let waited = 0;
    while (!due()) {
      st.now += RECHECK_MS;
      waited += RECHECK_MS;
    }
    waits.push(waited / RECHECK_MS);
    await a.recheckSignedOut();
  }
  assert.deepEqual(waits, [1, 2, 4, 8, 16, 32, 64, 64]);
  assert.equal(a.cache.x.misses, 8);
  // signed in at last: back to the first interval
  st.signedOut = false;
  st.now += 64 * RECHECK_MS;
  await a.recheckSignedOut();
  assert.equal(a.cache.x.misses, 0);
  assert.ok(s.calls.length >= 10);
  assert.equal(a.stale(undefined), false);
});

test('B-1: entries saved by an older version (no check time or misses) are due at once; a harness without quirks is named by its id', async () => {
  const { a, st } = admission();
  await a.refresh();
  const { checkedAt: _c, misses: _m, ...old } = a.cache.x;
  a.cache.x = { ...old, state: 'signin' };
  assert.equal(a.stale(a.list()[0]), true);
  st.signedOut = true;
  await a.recheckSignedOut();
  assert.equal(a.cache.x.misses, 1, 'a signed-out entry without misses counts from none');
  st.signedOut = false;
  await a.refresh({ force: true });
  a.o.quirks = () => null;
  a.signedOut('x');
  assert.equal(a.cache.x.reason, 'Sign in to x first');
});

test('B-1: the app checks signed-out harnesses again when a window gets focus; a failed check is recorded', async () => {
  const app = Object.assign(new EventEmitter(), { getPath: () => dir });
  const sent: any[] = [];
  const adm = openAdmission({
    common: { quirks: () => Q, ids: ['x'], resolveBin: () => BIN, env: () => ({}), tools: NO_SAGE_MCP, dataDir: dir },
    app,
    killed: () => null,
    broadcastAll: (...a: any[]) => sent.push(a),
  });
  assert.equal(adm.file, path.join(dir, 'acp-admission.json'));
  adm.emit();
  assert.equal(sent[0][0], 'acp:harnesses');
  clearIgnored();
  adm.recheckSignedOut = mock.fn(async () => Promise.reject(new Error('probe broke')));
  app.emit('browser-window-focus');
  await until(() => recentIgnored().length);
  assert.equal(adm.recheckSignedOut.mock.callCount(), 1);
  assert.deepEqual(
    recentIgnored().map((e: any) => [e.context, e.message]),
    [['check the signed-out harnesses again', 'probe broke']],
  );
  // without sage-mcp the tool channel refuses, so nothing is admitted
  await assert.rejects(NO_SAGE_MCP.prepare(), /sage-mcp/);
  assert.equal(await NO_SAGE_MCP.admission(), false);
  assert.equal(NO_SAGE_MCP.end(), undefined);
});

/** An AcpHost (tests/support/acp-host/fixture.ts) that records what it reports: signed out (with the stage) or in. */
function host(handlers: any) {
  const t = hostSetup({ handlers });
  const marked: string[] = [];
  t.host.signedOutFn = (h: string, stage: string) => void marked.push(`${h} ${stage}`);
  t.host.signedInFn = (h: string) => void marked.push(`${h} in`);
  return { ...t, marked };
}

test('B-1: session/new or session/prompt failing with an auth error marks the harness; other failures do not', async () => {
  const auth = Object.assign(new Error('Not logged in'), { code: -32000 });
  const other = Object.assign(new Error('model overloaded'), { code: -32603 });
  const opening = host({
    'session/new': () => {
      throw auth;
    },
  });
  await assert.rejects(opening.host.ensure(KEY, { cwd: CWD }), /Not logged in/);
  assert.deepEqual(opening.marked, ['fake session/new']);
  const failing = host({
    'session/new': () => {
      throw other;
    },
  });
  await assert.rejects(failing.host.ensure(KEY, { cwd: CWD }), /model overloaded/);
  assert.deepEqual(failing.marked, []);
  let fail: any = auth;
  const prompting = host({
    'session/prompt': () => {
      if (fail) throw fail;
      return { stopReason: 'end_turn' };
    },
  });
  const ends = () => prompting.events.filter((e: any) => e.kind === 'turnEnd').length;
  await prompting.host.send(KEY, { cwd: CWD, blocks: [{ type: 'text', text: 'hi' }] }, { uuid: 'u1' });
  await until(() => ends() === 1);
  assert.deepEqual(prompting.marked, ['fake session/prompt']);
  fail = other;
  await prompting.host.send(KEY, { blocks: [{ type: 'text', text: 'again' }] }, { uuid: 'u2' });
  await until(() => ends() === 2);
  assert.deepEqual(prompting.marked, ['fake session/prompt']);
  assert.equal(prompting.events.at(-1).error, 'model overloaded');
  // a prompt that goes through says the harness is signed in
  fail = null;
  await prompting.host.send(KEY, { blocks: [{ type: 'text', text: 'ok' }] }, { uuid: 'u3' });
  await until(() => ends() === 3);
  assert.deepEqual(prompting.marked, ['fake session/prompt', 'fake in']);
  // the default hooks do nothing
  const plain = hostSetup({});
  assert.equal(plain.host.signedOutFn('fake'), null);
  assert.equal(plain.host.signedInFn('fake'), null);
  assert.equal(isAuthError({ code: -32603, message: 'Login required' }), true);
});

test('signInReason: the setup its quirks name, else the agent’s words when they say more than "sign in" (#1319 G27)', () => {
  assert.equal(signInReason({ setup: 'Add a key', said: 'x' }), 'Add a key');
  assert.equal(signInReason({ said: '  This client is no longer\nsupported. ' }), 'This client is no longer supported.');
  assert.equal(signInReason(new Error('Retired login')), 'Retired login');
  assert.equal(signInReason({ said: 'x'.repeat(400) })?.length, 300);
  // a plain "sign in" says nothing the default doesn't, and nothing said is no reason
  for (const f of [{ said: 'Authentication required' }, new Error('Not logged in'), {}, null, undefined])
    assert.equal(signInReason(f), null);
});
