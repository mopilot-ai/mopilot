// What a Host's status says of Claude Code while it is still finding out (#5243): the CLI's own login is being read, or its models asked for. The row says it is still being checked and lists no login yet, not a default "signed out" the read has not confirmed; once both have answered it says everything.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createModelCache } from '../host/src/claudeModels.mjs';
import { createCredentialLeases } from '../host/src/credentialLease.mjs';
import { createOwnCredentials } from '../host/src/ownCredentials.mjs';
import { reportedHarness } from '../host/src/harnessState.mjs';
import { createAcpRuntime } from '../host/src/acp.mjs';
import { createClaudeFamily } from '../host/src/claudeFamily.mjs';
import { installElectronPorts } from '../host/src/electronPorts.mjs';
import { createPaths } from '../host/src/paths.mjs';
import { createHostSessions } from '../host/src/sessions.mjs';
import { loginsOf } from '../shared/host/agentReadiness.mjs';
import { useFakeProc } from './support/ports/proc.ts';
import { waitFor } from './support/waitFor.ts';
// @ts-ignore: plain ESM without declarations
import { createFakeClaudeSdk } from './support/fakeClaudeSdk.mjs';

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-settling-')));
const configDir = path.join(base, 'claude-config');
process.env.CLAUDE_CONFIG_DIR = configDir;
after(() => fs.rmSync(base, { recursive: true, force: true }));

test('the model cache says an ask is under way from its start until it answers', async () => {
  let release: (v: any[]) => void = () => undefined;
  const c = createModelCache({ ask: () => new Promise((r) => (release = r)), report: () => undefined });
  assert.equal(c.asking(), false);
  c.get();
  assert.equal(c.asking(), true);
  release([{ id: 'a', name: 'A', default: false, efforts: [] }]);
  await c.settled();
  assert.equal(c.asking(), false);
});

test('a refresh or a retry after the first ask is not "asking": the row does not go back to checking', async () => {
  let at = 0;
  let release: (v: any[]) => void = () => undefined;
  const answers: (() => Promise<any[]>)[] = [async () => [], () => new Promise((r) => (release = r))];
  let n = 0;
  const c = createModelCache({ ask: () => answers[Math.min(n++, 1)](), now: () => at, report: () => undefined });
  c.get();
  assert.equal(c.asking(), true);
  await c.settled();
  assert.equal(c.asking(), false, 'the first ask found none');
  at += 61_000;
  c.get();
  assert.equal(c.asking(), false, 'the retry runs, and says nothing of it');
  release([]);
  await c.settled();
});

test('a status asked while the CLI login is being read says checking and lists no login; the next one, once read, lists it', async () => {
  const dir = fs.mkdtempSync(path.join(base, 'd-'));
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(bin, '#!/bin/sh\n');
  const fake = createFakeClaudeSdk({ configDir });
  const leases = createCredentialLeases();
  const ownRuns = createOwnCredentials({ leases, dataDir: dir });
  const restore = installElectronPorts({
    paths: { dataDir: dir, configDir: path.join(dir, 'config') },
    openExternal: async () => undefined,
  });
  const runtime = createAcpRuntime({ paths: createPaths({ dataDir: dir, env: {} }), env: {} });
  let family: any;
  const sessions = createHostSessions({
    paths: createPaths({ dataDir: dir, env: {} }),
    env: { MOPILOT_CLAUDE_BIN: bin },
    runtime,
    families: { claude: (ctx: any) => (family = createClaudeFamily({ sdk: fake.sdk, leases, ownRuns })(ctx)) },
  });
  try {
    await sessions.chatRuntime.send({ key: `claude:${crypto.randomUUID()}`, text: 'hello', cwd: dir });
    let finish: () => void = () => undefined;
    family.claude.turnApi.readCliLogin = () => new Promise<void>((r) => (finish = r));
    const view = { active: 'default', accounts: [{ id: 'default', isDefault: true, loggedIn: false, checked: false }] };
    family.claude.turnApi.accounts = () => view;
    const io = { codex: { models: async () => [] }, sessions, leases, credentials: undefined };
    const asked = await reportedHarness({ id: 'claude', detected: true, signedIn: true }, io as any);
    assert.deepEqual(
      [(asked as any).checking, 'logins' in asked, 'loginsSupported' in asked],
      [true, false, false],
      'the login read has not answered: no signed-out login is told',
    );
    view.accounts[0].loggedIn = true;
    (view.accounts[0] as any).checked = true;
    finish();
    await new Promise((r) => setImmediate(r));
    const answered = await reportedHarness({ id: 'claude', detected: true, signedIn: true }, io as any);
    assert.deepEqual(
      [(answered as any).checking, (answered as any).logins.map((l: any) => [l.id, l.state]), (answered as any).loginsSupported],
      [undefined, [['default', 'ok']], true],
    );
  } finally {
    sessions.close();
    runtime.close();
    restore();
  }
});

test('an agent that is not Claude Code, or a status with nothing under way, never says checking for it', async () => {
  const io = {
    codex: { models: async () => [] },
    sessions: { modelsOf: () => [], loginsOf: () => [], settlingOf: () => true },
    leases: { has: () => false },
    credentials: undefined,
  };
  assert.equal('checking' in (await reportedHarness({ id: 'codex', detected: true, signedIn: true }, io as any)), false);
  assert.equal('checking' in (await reportedHarness({ id: 'claude', detected: false, signedIn: false }, io as any)), false);
});

test('a successful Host sign-in re-reads the CLI profile even if it was already checked', async (t) => {
  const dir = fs.mkdtempSync(path.join(base, 'renew-'));
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(bin, '', { mode: 0o700 });
  let signedIn = false;
  useFakeProc(t, {
    execFile: (bin: string | null, args: string[], _opts: unknown, done: (err: null, stdout: string) => void) => {
      if (bin === null) throw new Error('The CLI was removed');
      assert.deepEqual(args.slice(-3), ['auth', 'status', '--json']);
      queueMicrotask(() =>
        done(null, JSON.stringify({ loggedIn: signedIn, email: signedIn ? 'renewed@example.test' : 'old@example.test' })),
      );
      return {};
    },
  });
  const restore = installElectronPorts({ paths: { dataDir: dir, configDir: path.join(dir, 'config') }, openExternal: async () => {} });
  const paths = createPaths({ dataDir: dir, env: {} });
  const runtime = createAcpRuntime({ paths, env: {} });
  const fake = createFakeClaudeSdk({ configDir });
  const claude = createClaudeFamily({ sdk: fake.sdk });
  let family: any;
  const sessions = createHostSessions({
    paths,
    env: { MOPILOT_CLAUDE_BIN: bin },
    runtime,
    families: { claude: (ctx) => (family = claude(ctx)) },
  });
  try {
    await sessions.chatRuntime.send({ key: `claude:${crypto.randomUUID()}`, text: 'hello', cwd: dir });
    await family.claude.turnApi.readCliLogin(bin);
    assert.equal(loginsOf(sessions.loginsOf('claude'))?.[0]?.state, 'signedOut');
    const read = () =>
      reportedHarness(
        { id: 'claude', detected: true, signedIn: true },
        { codex: { models: async () => [] }, sessions, leases: createCredentialLeases() },
      );
    await read();
    await waitFor(() => !family.settling(), 'the initial status to settle');
    signedIn = true;
    claude.signedIn('claude');
    await waitFor(() => !family.settling(), 'the renewed status to settle');
    const status = await read();
    assert.deepEqual(
      (status as any).logins.map((l: any) => [l.id, l.label, l.state]),
      [['default', 'renewed@example.test', 'ok']],
    );
    await family.claude.turnApi.readCliLogin(undefined, true);
    assert.equal(
      loginsOf(sessions.loginsOf('claude'))?.[0]?.label,
      'renewed@example.test',
      'an unavailable CLI preserves the last account',
    );
    family.claude.turnApi.readCliLogin = async () => {
      throw new Error('Cannot save the login status');
    };
    claude.signedIn('claude');
    await waitFor(() => !family.settling(), 'the refused status read to settle');
    assert.equal(loginsOf(sessions.loginsOf('claude'))?.[0]?.state, 'ok');
  } finally {
    sessions.close();
    runtime.close();
    await family?.close();
    restore();
  }
});
