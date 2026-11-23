// The user's own key lent to an ACP agent on a Host (#3361 Tier 1 for ACP): Gemini and Grok read their key from their env once told to sign in with it (shared/host/credentials.mjs keyAuthMethod); the Host gives each agent only its own key (host/src/acp.mjs), tells a freshly started agent to use it (electron/harness/acp/lentKeyAuth.cjs), and the app lends it per message (electron/host/remoteCredentials.cjs).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
// @ts-ignore: plain ESM without declarations
import { createAcpRuntime } from '../host/src/acp.mjs';
import { createCredentialLeases } from '../host/src/credentialLease.mjs';
import { createPaths } from '../host/src/paths.mjs';
import { KEYED, acpKeyed, keyAuthMethod } from '../shared/host/credentials.mjs';

const require = createRequire(import.meta.url);
const { signInWithLentKey, KEY_AUTH_MS } = require('../electron/harness/acp/lentKeyAuth.cjs');
const { startAgent } = require('../electron/harness/acp/launch.cjs');
const { withCredentials } = require('../electron/host/remoteCredentials.cjs');

const ROOT = path.join(import.meta.dirname, '..');
const AGENT = path.join(ROOT, 'tests/fixtures/fake-acp-agent.mjs');
const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-acp-keys-')));
after(() => fs.rmSync(base, { recursive: true, force: true }));
const GEMINI_KEY = 'AIzaSyDUMMY-gemini-key-000000000000000';
const XAI_KEY = 'xai-DUMMY-grok-key-0000000000000000000000';

test('the shared table: Gemini and Grok take their key from the env and sign in with their key method; others take none', () => {
  assert.deepEqual(KEYED.gemini, { env: 'GEMINI_API_KEY', provider: 'google', via: 'env', acp: true, authMethod: 'gemini-api-key' });
  assert.deepEqual(KEYED.grok, { env: 'XAI_API_KEY', provider: 'xai', via: 'env', acp: true, authMethod: 'xai.api_key' });
  assert.deepEqual(KEYED.dsh, { env: 'DEEPSEEK_API_KEY', provider: 'deepseek', via: 'env', acp: true });
  const ids = ['gemini', 'grok', 'dsh', 'claude', 'codex', 'opencode', 'toString'];
  assert.deepEqual(ids.map(keyAuthMethod), ['gemini-api-key', 'xai.api_key', null, null, null, null, null]);
  // dsh takes its key in its env with no sign-in method; Claude Code and Codex take theirs their own way
  assert.deepEqual(ids.map(acpKeyed), [true, true, true, false, false, false, false]);
});

test('W: each agent’s process gets only its own lent key; a fresh agent is told to use it; a change restarts the agents between turns', () => {
  const dir = fs.mkdtempSync(path.join(base, 'w-'));
  const leases = createCredentialLeases();
  const runtime = createAcpRuntime({ paths: createPaths({ dataDir: dir, env: {} }), env: { KEEP: '1' }, leases });
  const restarts: number[] = [];
  runtime.host.closeAll = (only?: boolean) => void (only && restarts.push(1));
  try {
    assert.deepEqual(runtime.host.envOf('gemini'), { KEEP: '1' }, 'nothing lent');
    assert.equal((runtime.host as any).lentAuthFn('gemini'), null);
    leases.set('gemini', GEMINI_KEY);
    assert.deepEqual(restarts, [1], 'idle: restarted at once, so the next process starts with the key');
    assert.deepEqual(runtime.host.envOf('gemini'), { KEEP: '1', GEMINI_API_KEY: GEMINI_KEY });
    assert.deepEqual(runtime.host.envOf('grok'), { KEEP: '1' }, 'Gemini’s key never reaches Grok');
    assert.deepEqual(runtime.host.envOf(), { KEEP: '1' }, 'a caller that names no agent gets none');
    assert.deepEqual(runtime.host.envOf('opencode'), { KEEP: '1' });
    assert.equal((runtime.host as any).lentAuthFn('gemini'), 'gemini-api-key');
    assert.equal((runtime.host as any).lentAuthFn('grok'), null, 'no key lent for Grok');
    // dsh gets its own key in its env and is told nothing: it has no sign-in to pick
    leases.set('dsh', 'sk-DUMMY-deepseek-key-00000000000000');
    assert.deepEqual(runtime.host.envOf('dsh'), { KEEP: '1', DEEPSEEK_API_KEY: 'sk-DUMMY-deepseek-key-00000000000000' });
    assert.equal((runtime.host as any).lentAuthFn('dsh'), null);
    assert.deepEqual(runtime.host.envOf('gemini'), { KEEP: '1', GEMINI_API_KEY: GEMINI_KEY }, 'nor does Gemini get dsh’s');
    assert.equal((runtime.host as any).lentAuthFn('opencode'), null, 'takes no key');
    leases.set('grok', XAI_KEY);
    assert.deepEqual(runtime.host.envOf('grok'), { KEEP: '1', XAI_API_KEY: XAI_KEY });
    assert.equal((runtime.host as any).lentAuthFn('grok'), 'xai.api_key');
    // an organization lease for the agent wins: it is not told to sign in with the key
    leases.setOrg(
      {
        harness: 'grok',
        identity: 'a'.repeat(32),
        token: 'eyJ.dummy-org-token-0000.sig',
        gateways: {},
        expiresAt: Date.now() + 60_000,
      },
      Date.now(),
    );
    assert.equal((runtime.host as any).lentAuthFn('grok'), null);
    // a turn runs: a key change waits for it
    restarts.length = 0;
    runtime.host.emit('event', { kind: 'turnStart', turnId: 't', key: 'acp:gemini:a' });
    leases.set('gemini', null);
    assert.deepEqual(restarts, [], 'never mid-turn');
    leases.set('claude', 'sk-ant-DUMMY-0000000000000000000000');
    assert.deepEqual(restarts, [], 'Claude Code’s key is not the ACP agents’ business');
  } finally {
    runtime.close();
  }
  // a Host without leases tells no agent anything
  const bare = createAcpRuntime({ paths: createPaths({ dataDir: fs.mkdtempSync(path.join(base, 'b-')), env: {} }), env: {} });
  assert.equal((bare.host as any).lentAuthFn('gemini'), null);
  assert.deepEqual(bare.host.envOf('gemini'), {});
  bare.close();
});

test('the key sign-in: asked only for a method the agent offers; a refusal is reported and the agent still starts', async () => {
  const calls: any[] = [];
  const reports: string[] = [];
  const agent = (methods: string[], fail = false) => ({
    caps: { authMethods: methods.map((id) => ({ id })) },
    request: async (method: string, params: object, o: object) => {
      calls.push([method, params, o]);
      if (fail) throw new Error('bad key');
      return {};
    },
  });
  const report = (what: string) => reports.push(what);
  const lent = { lentAuthFn: (h: string) => (h === 'gemini' ? 'gemini-api-key' : null) };
  assert.equal(await signInWithLentKey(lent, 'gemini', agent(['oauth-personal', 'gemini-api-key']), report), true);
  assert.deepEqual(calls, [['authenticate', { methodId: 'gemini-api-key' }, { timeoutMs: KEY_AUTH_MS }]]);
  calls.length = 0;
  assert.equal(await signInWithLentKey(lent, 'gemini', agent(['oauth-personal']), report), false, 'an older agent without it');
  assert.equal(await signInWithLentKey(lent, 'grok', agent(['xai.api_key']), report), false, 'nothing lent for it');
  assert.equal(await signInWithLentKey({}, 'gemini', agent(['gemini-api-key']), report), false, 'the app’s own host lends nothing');
  assert.equal(await signInWithLentKey(lent, 'gemini', { ...agent([]), caps: null }, report), false, 'not initialized: nothing to ask');
  assert.deepEqual(calls, []);
  assert.equal(await signInWithLentKey(lent, 'gemini', agent(['gemini-api-key'], true), report), false);
  assert.deepEqual(reports, ['sign an agent in with the lent key']);
});

test('a real agent started with a key lent is signed in before its first session; without one it is not', async () => {
  const run = async (lent: string | null) => {
    const dir = fs.mkdtempSync(path.join(base, 'r-'));
    const state = path.join(dir, 'agent-state');
    fs.mkdirSync(state);
    const profile = { needsAuth: true, authMethods: [{ id: 'key', name: 'API key' }] };
    fs.writeFileSync(
      path.join(dir, 'harnesses.json'),
      JSON.stringify({
        fake: {
          label: 'Fake',
          bin: process.execPath,
          args: [AGENT],
          env: { FAKE_ACP_STATE: state, FAKE_ACP_PROFILE: JSON.stringify(profile) },
        },
      }),
    );
    const runtime = createAcpRuntime({
      paths: createPaths({ dataDir: dir, env: {} }),
      env: { PATH: process.env.PATH },
    });
    (runtime.host as any).lentAuthFn = (h: string) => (h === 'fake' ? lent : null);
    try {
      const agent = await startAgent(runtime.host, 'fake');
      agent.kill();
      return fs.existsSync(path.join(state, 'authed'));
    } finally {
      runtime.close();
    }
  };
  assert.equal(await run('key'), true);
  assert.equal(await run(null), false);
});

test('A: the app lends Gemini and Grok their own key with each message; an agent that takes none gets none; an organization lease goes first', async () => {
  const calls: any[] = [];
  let orgLends = false;
  const host = {
    modelKey: async (p: any) => void calls.push(['modelKey', p]),
    start: async (chatId: string) => void calls.push(['start', chatId]),
    send: async (chatId: string) => void calls.push(['send', chatId]),
  };
  const keys = { forHarness: (h: string) => ({ gemini: GEMINI_KEY, grok: XAI_KEY })[h] ?? null };
  const wrapped = withCredentials(host, keys, { lend: async () => orgLends, covers: () => orgLends });
  await wrapped.start('acp:gemini:1', { harness: 'acp:gemini' });
  await wrapped.send('acp:grok:2', { text: 'hi' });
  await wrapped.send('acp:opencode:3', { text: 'hi' });
  await wrapped.start('acp:x', { harness: 42 });
  assert.deepEqual(calls, [
    ['modelKey', { harness: 'gemini', key: GEMINI_KEY }],
    ['start', 'acp:gemini:1'],
    ['modelKey', { harness: 'grok', key: XAI_KEY }],
    ['send', 'acp:grok:2'],
    ['send', 'acp:opencode:3'],
    ['start', 'acp:x'],
  ]);
  calls.length = 0;
  orgLends = true;
  await wrapped.send('acp:gemini:1', { text: 'org' });
  assert.deepEqual(calls, [['send', 'acp:gemini:1']]);
});
