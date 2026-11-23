// A key the app lent the Host (host/src/credentialLease.mjs) reaches the Claude Code CLI only through its environment (host/src/claudeFamily.mjs spawn), never its command line; a key taken back is gone from the next CLI, and a CLI started with the old one is retired.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { createAcpRuntime } from '../host/src/acp.mjs';
import { createClaudeFamily } from '../host/src/claudeFamily.mjs';
import { createCredentialLeases } from '../host/src/credentialLease.mjs';
import { installElectronPorts } from '../host/src/electronPorts.mjs';
import { createPaths } from '../host/src/paths.mjs';
import { createHostSessions } from '../host/src/sessions.mjs';
// @ts-ignore: plain ESM without declarations
import { createFakeClaudeSdk } from './support/fakeClaudeSdk.mjs';

const KEY = 'sk-ant-dummy-0000-test-key-abcd';
const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-claude-key-')));
const configDir = path.join(base, 'claude-config');
process.env.CLAUDE_CONFIG_DIR = configDir;
after(() => fs.rmSync(base, { recursive: true, force: true }));
const until = async (fn: () => any, ms = 8000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};

test('I: the lent key is in the CLI’s environment, never its arguments; one taken back is gone from the next CLI', async () => {
  const dir = fs.mkdtempSync(path.join(base, 'd-'));
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(bin, '#!/bin/sh\n');
  const fake = createFakeClaudeSdk({ configDir });
  const leases = createCredentialLeases();
  const restore = installElectronPorts({
    paths: { dataDir: dir, configDir: path.join(dir, 'config') },
    openExternal: async () => undefined,
  });
  const runtime = createAcpRuntime({ paths: createPaths({ dataDir: dir, env: {} }), env: {} });
  let family: any;
  const make = createClaudeFamily({ sdk: fake.sdk, leases });
  const sessions = createHostSessions({
    paths: createPaths({ dataDir: dir, env: {} }),
    env: { MOPILOT_CLAUDE_BIN: bin },
    runtime,
    families: { claude: (ctx: any) => (family = make(ctx)) },
  });
  try {
    await sessions.chatRuntime.send({ key: `claude:${crypto.randomUUID()}`, text: 'hello', cwd: dir });
    const spawnCli = await until(() => fake.queries[0]?.options.spawnClaudeCodeProcess);
    const args = ['-e', 'process.stdout.write(JSON.stringify({ env: process.env.ANTHROPIC_API_KEY ?? null, keep: process.env.KEEP }))'];
    /** What a CLI started now sees, and the arguments it was started with. */
    const seen = async () => {
      const child = spawnCli({
        command: process.execPath,
        args,
        cwd: dir,
        env: { PATH: process.env.PATH, KEEP: '1' },
        signal: new AbortController().signal,
      });
      let out = '';
      child.stdout.on('data', (d: Buffer) => (out += d));
      await new Promise((r) => child.once('close', r));
      return { ...JSON.parse(out), argv: child.spawnargs.join(' ') };
    };
    assert.equal((await seen()).env, null, 'nothing lent yet');
    leases.set('claude', KEY);
    const lent = await seen();
    assert.deepEqual([lent.env, lent.keep], [KEY, '1'], 'the key joins the env the SDK gave, which stays');
    assert.doesNotMatch(lent.argv, /sk-ant/);
    leases.set('claude', null);
    assert.equal((await seen()).env, null);
    // the chat's CLI started before the key changed lets it go: the next message starts one with the key there is now
    await until(() => fake.queries[0].closed);
    const retired = fake.queries.length;
    leases.set('codex', null);
    leases.set('claude', null);
    family.signedOut();
    assert.equal(fake.queries.length, retired, 'nothing new was started by it');
    // a sign-in on the built family takes a failed turn's mark back; another harness's sign-in leaves it alone
    const taken = family.claudeTurns.marks;
    taken.snapshot = () => new Map([['a', { expired: true }]]);
    taken.works = (account: string) => taken.worked.push(account);
    taken.worked = [] as string[];
    assert.equal(family.loginRefused(), true);
    make.signedIn('codex');
    assert.deepEqual(taken.worked, []);
    make.signedIn('claude');
    assert.deepEqual(taken.worked, ['a'], 'the mark on the old login is over');
  } finally {
    sessions.close();
    runtime.close();
    await family?.close();
    restore();
  }
});

test('a sign-out before the family is built, or of another harness, changes nothing', () => {
  const make = createClaudeFamily({});
  make.signedOut('claude');
  make.signedOut('codex');
  // a sign-in is the same: nothing to clear before the family exists, and another harness's sign-in is not Claude's
  make.signedIn('claude');
  make.signedIn('codex');
});
