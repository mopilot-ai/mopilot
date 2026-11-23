// Desktop ACP discovery, admission and launch share the selected installation through changes to PATH and manual pins.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { test, type TestContext } from 'node:test';
import { deferred } from './support/async-scenarios.ts';
import { fakeSpawn, INIT } from './support/electron-acp-fake.ts';

const require = createRequire(import.meta.url);
const { createHighestBasic } = require('../electron/harness/detect.cjs');
const { which, childEnv } = require('../electron/platform/env.cjs');
const { Admission, binStamp } = require('../electron/harness/admission.cjs');
const { AcpHost } = require('../electron/harness/acp.cjs');
const { quirks } = require('../electron/harness/quirks/index.cjs');

function scratch(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'highest-acp-'));
  const saved = { PATH: process.env.PATH, SAGE_ACP_BINS: process.env.SAGE_ACP_BINS };
  delete process.env.SAGE_ACP_BINS;
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function install(dir: string, name: string, version: string | null) {
  fs.mkdirSync(dir, { recursive: true });
  const bin = path.join(dir, process.platform === 'win32' ? `${name}.cmd` : name);
  if (process.platform === 'win32') {
    const packageDir = path.join(dir, 'node_modules', name);
    fs.mkdirSync(packageDir, { recursive: true });
    fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ version }));
    fs.writeFileSync(bin, `@rem /node_modules/${name}/cli.js\r\n@exit /b 1\r\n`);
  } else {
    fs.writeFileSync(bin, version ? `#!/bin/sh\nprintf '%s\\n' '${version}'\n` : '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  }
  return bin;
}

test('ACP admission and a new agent use the same highest copy behind PATH, even without a window', async (t) => {
  const dir = scratch(t);
  const stable = install(path.join(dir, 'path-one'), 'goose', '2.9.0');
  const beta = install(path.join(dir, 'path-two'), 'goose', '2.10.0-beta.3');
  const unreadable = install(path.join(dir, 'path-three'), 'goose', null);
  const alias = path.join(dir, 'alias', path.basename(beta));
  fs.mkdirSync(path.dirname(alias));
  if (process.platform !== 'win32') fs.symlinkSync(beta, alias);
  process.env.PATH = [stable, alias, beta, unreadable].map((p) => path.dirname(p)).join(path.delimiter);
  let pin: string | undefined;
  const binaries = createHighestBasic({ manualOf: () => pin, which, env: childEnv });
  assert.equal(binaries.resolveBin('goose'), stable);
  await binaries.discoverBin('missing-quirks');
  assert.equal(binaries.resolveBin('missing-quirks'), null);
  const spawn = fakeSpawn();
  const common = {
    ...binaries,
    ids: ['goose'],
    quirks,
    dataDir: dir,
    env: childEnv,
    spawnFn: spawn.spawnFn,
  };
  const admission = new Admission({
    ...common,
    tools: { prepare: async () => ({ mcpServers: [] }), admission: async () => true, end() {} },
    file: path.join(dir, 'admission.json'),
  });
  const acp = new AcpHost({
    ...common,
    admission,
    resolveBin: async (id: string) => (await admission.current(id))?.bin ?? null,
  });
  t.after(() => acp.closeAll());
  const selected = process.platform === 'win32' ? beta : alias;
  const agent = await acp.agent('goose');
  assert.equal(agent.command, selected);
  assert.deepEqual(
    spawn.calls.map((call) => call.command),
    [selected, selected],
    'probe and launch checked the same executable',
  );
  assert.equal(admission.list()[0].bin, selected);
  assert.equal(admission.list()[0].state, 'admitted');
  assert.equal(await acp.agentForLogin('goose'), agent, 'a sign-in to the current copy can use its running agent');
  fs.appendFileSync(beta, '\n');
  assert.equal((await admission.refresh())[0].bin, selected);
  acp.authFailed('goose', { code: -32000, message: 'replaced copy failed' }, 'session/prompt', agent);
  assert.equal(admission.list()[0].state, 'admitted', 'the old process cannot mark a new installation at the same path signed out');
  const newLogin = await acp.agentForLogin('goose');
  assert.notEqual(newLogin, agent, 'sign-in selects the replacement even at the same path');
  newLogin.kill();

  pin = stable;
  assert.equal((await admission.refresh({ force: true }))[0].bin, stable);
  assert.equal(spawn.calls.at(-1).command, stable);
  assert.equal(await acp.authenticate('goose', 'test-sign-in'), true);
  assert.equal(spawn.calls.at(-1).command, stable, 'sign-in uses the selected copy even when another copy has a live chat');
  assert.equal(await acp.agent('goose'), agent, 'sign-in leaves the old agent running');
  acp.authFailed('goose', { code: -32000, message: 'old copy failed' }, 'session/prompt', agent);
  assert.equal(admission.list()[0].state, 'admitted');
  assert.equal(admission.list()[0].catalog?.modes ?? null, null);
  acp.authFailed('goose', { code: -32000, message: 'current copy failed' }, 'session/prompt', {
    command: stable,
    binaryStamp: binStamp(stable),
  });
  assert.equal(admission.acceptsBin('goose', agent.command, agent.binaryStamp), false, 'old prompt success belongs to its own install');
  assert.equal(admission.list()[0].state, 'signin');
  assert.equal((await admission.verify('goose'))?.state, 'signin', 'verifying the same copy preserves its prompt refusal');

  pin = path.join(dir, 'removed-pin');
  assert.equal((await admission.verify('goose'))?.bin, selected, 'a signed-out record cannot keep the old pin selected for scheduled work');
  fs.rmSync(beta);
  fs.rmSync(unreadable);
  assert.equal((await admission.refresh())[0].bin, stable);
  fs.rmSync(stable);
  assert.equal((await admission.refresh({ force: true }))[0].state, 'missing');

  process.env.SAGE_ACP_BINS = JSON.stringify({ goose: '/fake-goose' });
  await binaries.discoverBin('goose');
  assert.equal(binaries.resolveBin('goose'), '/fake-goose');
  assert.equal(binaries.resolveBin('kimi'), null, 'test overrides never fall through to the real machine');
});

test('the first ACP send adopts only a warm process for the selected installation', async (t) => {
  const dir = scratch(t);
  const first = install(path.join(dir, 'first'), 'goose', '1.0.0');
  const next = install(path.join(dir, 'next'), 'goose', '2.0.0');
  let selected = first;
  let waiting: Promise<string> | undefined;
  let failWarm = false;
  const spawn = fakeSpawn({
    initialize: () => {
      if (!failWarm) return INIT();
      failWarm = false;
      return INIT({}, { protocolVersion: 2 });
    },
  });
  const common = { quirks, dataDir: dir, env: childEnv, spawnFn: spawn.spawnFn };
  const acp = new AcpHost({
    ...common,
    admission: { acceptsBin: (_id: string, bin: string, stamp: string) => bin === selected && stamp === binStamp(bin) },
    resolveBin: () => waiting ?? selected,
  });
  t.after(() => acp.closeAll());
  const warm = await acp.agent('goose');
  assert.equal(await acp.agent('goose', 'acp:goose:reuse', false), warm);

  const outdated = await acp.agent('goose');
  selected = next;
  const replacement = await acp.agent('goose', 'acp:goose:replace', false);
  assert.equal(replacement.command, next);
  assert.equal(outdated.proc.stdin.ended, true, 'the unused old process is retired');

  failWarm = true;
  const failed = acp.agent('goose');
  const recovering = acp.agent('goose', 'acp:goose:recover', false);
  await assert.rejects(failed, /speaks ACP v2/);
  assert.equal((await recovering).command, next, 'a failed prewarm cannot stand in for a fresh start');

  const last = await acp.agent('goose');
  const gate = deferred<string>();
  waiting = gate.promise;
  const adopting = acp.agent('goose', 'acp:goose:closed', false);
  await Promise.resolve();
  acp.closeAll();
  const before = spawn.calls.length;
  gate.resolve(first);
  await assert.rejects(adopting, /ACP chat closed/);
  assert.equal(last.proc.stdin.ended, true);
  assert.equal(spawn.calls.length, before, 'retired slot cannot launch a replacement after selection settles');
});

test('a pin changed during an ACP probe retires the old result before the waiting launch can read it', async (t) => {
  const dir = scratch(t);
  const first = install(path.join(dir, 'first'), 'goose', '2.0.0');
  const next = install(path.join(dir, 'next'), 'goose', '1.0.0');
  let pin = first;
  const binaries = createHighestBasic({ manualOf: () => pin, which, env: childEnv });
  const started = deferred<void>();
  const release = deferred<void>();
  let attempts = 0;
  const spawn = fakeSpawn({
    initialize: async () => {
      if (++attempts === 1) {
        started.resolve();
        await release.promise;
      }
      return INIT();
    },
  });
  const a = new Admission({
    ...binaries,
    ids: ['goose'],
    quirks,
    env: childEnv,
    tools: { prepare: async () => ({ mcpServers: [] }), admission: async () => true, end() {} },
    file: path.join(dir, 'admission.json'),
    dataDir: dir,
    spawnFn: spawn.spawnFn,
  });
  const seen: { bin: string; state: string }[] = [];
  a.onChange((list: typeof seen) => seen.push(...list));
  const firstCheck = a.current('goose');
  await started.promise;
  pin = next;
  const replacement = a.refresh({ force: true, only: 'goose' });
  release.resolve();
  assert.equal((await firstCheck)?.bin, next);
  assert.equal((await replacement)[0].bin, next);
  assert.deepEqual(
    spawn.calls.map((call) => call.command),
    [first, next],
  );
  assert.deepEqual(
    seen.filter((entry) => entry.state === 'admitted').map((entry) => entry.bin),
    [next],
  );
});
