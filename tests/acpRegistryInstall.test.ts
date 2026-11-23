// Registry distributions prepare packages or verify and safely extract binaries; launchers preserve literal arguments and auth replacement.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { deferred } from './support/async-scenarios.ts';
import { zip } from './support/zip-kit.ts';
import { agent, directory, which } from './support/acp-registry.ts';

const require = createRequire(import.meta.url);
const { installDistribution, launcher, checkTar, writeLauncher } = require('../electron/harness/registry/install.cjs');
const bytes = Buffer.from('fake agent binary');
const sha256 = createHash('sha256').update(bytes).digest('hex');
const binary = (archive = 'https://example.com/agent') => ({ kind: 'binary', archive, cmd: 'bin/agent', sha256, args: [], env: {} });
const fetchBinary = async () => ({ ok: true, arrayBuffer: async () => bytes }) as any;
const install = (distribution: any, extra: any = {}) =>
  installDistribution({
    agent: agent(),
    distribution,
    stage: directory(),
    which,
    fetch: fetchBinary,
    runPackage: async () => assert.fail('binary must not invoke a package manager'),
    ...extra,
  });

test('npm and uv preparation finish before launch, use pinned packages and retain literal registry arguments', async () => {
  for (const kind of ['npx', 'uvx']) {
    const packageSpec = kind === 'npx' ? '@example/agent@1.2.3' : 'agent==1.2.3';
    const calls: any[] = [];
    const result = await install(
      { kind, package: packageSpec, args: ['--acp', 'literal; $(touch file)'], env: { EXAMPLE: 'value' } },
      {
        runPackage: async (spec: any) => {
          calls.push(spec);
        },
      },
    );
    assert.equal(result.program, `/tools/${kind}`);
    const cache = path.join(calls[0].cwd, 'package-cache');
    assert.deepEqual(result.prefix, kind === 'npx' ? ['--cache', cache, '--yes', packageSpec] : ['--cache-dir', cache, packageSpec]);
    assert.deepEqual(result.args, ['--acp', 'literal; $(touch file)']);
    assert.deepEqual(result.env, { EXAMPLE: 'value' });
    assert.deepEqual(
      calls[0].argv,
      kind === 'npx'
        ? ['/tools/npm', 'exec', '--cache', cache, '--yes', '--package', packageSpec, '--call', 'exit 0']
        : ['/tools/uvx', '--cache-dir', cache, '--from', packageSpec, 'python', '-c', 'pass'],
    );
    for (const absent of kind === 'npx' ? ['npm', 'npx'] : ['uvx'])
      await assert.rejects(install({ kind }, { which: (name: string) => (name === absent ? null : which(name)) }), /Install/);
  }
});

test('a checksummed raw binary is installed executable, and downloads, checksums and installer formats fail explicitly', async () => {
  const result = await install(binary());
  assert.equal(fs.readFileSync(result.program, 'utf8'), bytes.toString());
  assert.equal(fs.statSync(result.program).mode & 0o777, 0o700);
  assert.deepEqual(result.prefix, []);
  await assert.rejects(install(binary(), { fetch: async () => ({ ok: false, status: 503 }) }), /HTTP 503/);
  await assert.rejects(install({ ...binary(), sha256: '0'.repeat(64) }), /checksum/);
  for (const extension of ['deb', 'rpm', 'dmg', 'pkg', 'msi', 'appimage'])
    await assert.rejects(install(binary(`https://example.com/agent.${extension}`)), /unsupported installer/);
});

test('tar and zip distributions keep extraction inside the staging folder and require the declared executable', async () => {
  for (const extension of ['tar.gz', 'tgz', 'tar.bz2', 'tbz2', 'tar.xz', 'tar', 'zip']) {
    const files: string[][] = [];
    const extracted = (destination: string) => {
      fs.mkdirSync(path.join(destination, 'bin'), { recursive: true });
      fs.writeFileSync(path.join(destination, 'bin/agent'), bytes);
    };
    const result = await install(binary(`https://example.com/agent.${extension}`), {
      exec: (_cmd: string, args: string[]) => {
        files.push(args);
        if (args[0] === '-tf') return './\n./bin/\n./bin/agent\n';
        if (args[0] === '-tvf') return 'drwx bin\n-rwx bin/agent\n';
        extracted(args[3]);
      },
      extractZip: async (_file: string, destination: string) => extracted(destination),
    });
    assert.equal(fs.readFileSync(result.program, 'utf8'), bytes.toString());
    assert.equal(files.length, extension === 'zip' ? 0 : 3);
  }
  await assert.rejects(install(binary('https://example.com/agent.zip'), { extractZip: async () => {} }), /declared executable/);
  checkTar('.\n./\nagent\n', '-rwx agent\n');
  for (const names of ['../escape\n', '/absolute\n', 'bin/../escape\n']) assert.throws(() => checkTar(names, '-rwx agent'), /outside/);
  for (const listing of ['lrwx link', 'hrwx hard', 'prwx pipe', 'crwx device'])
    assert.throws(() => checkTar('agent', listing), /link or special/);
});

test('real ZIP installation shares the guarded Host extractor and rejects traversal or links before publication', async () => {
  for (const entry of [
    { name: 'bin/agent', data: 'registry archive', mode: 0o100755 },
    { name: '../escape', data: 'blocked' },
    { name: 'bin/agent', data: '/etc/passwd', mode: 0o120777 },
  ]) {
    const archive = zip([entry]);
    const work = install(
      { ...binary('https://example.com/agent.zip'), sha256: createHash('sha256').update(archive).digest('hex') },
      { fetch: async () => ({ ok: true, arrayBuffer: async () => archive }) },
    );
    if (entry.mode === 0o100755) {
      const result = await work;
      assert.equal(fs.readFileSync(result.program, 'utf8'), 'registry archive');
      assert.equal(fs.statSync(result.program).mode & 0o777, 0o700);
      assert.equal(fs.statSync(path.dirname(result.program)).mode & 0o777, 0o700);
    } else await assert.rejects(work, /path it should not|link or special/);
  }
});

test('cancellation at each meaningful await prevents extraction, package publication and successful completion', async () => {
  for (const stage of ['before', 'fetch', 'body', 'zip', 'package']) {
    const controller = new AbortController();
    const gate = deferred<any>();
    const work = install(
      stage === 'package' ? { kind: 'npx', package: 'agent@1.2.3' } : binary(stage === 'zip' ? 'https://example.com/a.zip' : undefined),
      {
        signal: controller.signal,
        fetch:
          stage === 'fetch'
            ? () => gate.promise
            : async () => ({ ok: true, arrayBuffer: stage === 'body' ? () => gate.promise : async () => bytes }),
        extractZip: async () => gate.promise,
        runPackage: async () => gate.promise,
        ...(stage === 'before' ? { signal: AbortSignal.abort() } : {}),
      },
    );
    const checked = assert.rejects(work, /abort/i);
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    gate.resolve(stage === 'fetch' ? { ok: true } : bytes);
    await checked;
  }
});

test('launcher arguments, environment and appended terminal auth arguments stay literal shell data', () => {
  const dir = directory();
  const script = path.join(dir, 'launch');
  const hostile = "a' b; $(echo injected) `echo injected`";
  writeLauncher(script, {
    program: process.execPath,
    args: ['-e', 'console.log(JSON.stringify([process.env.VALUE,process.argv.slice(1)]))', hostile],
    env: { VALUE: hostile },
  });
  assert.deepEqual(JSON.parse(execFileSync(script, ['--login'], { encoding: 'utf8' })), [hostile, [hostile, '--login']]);
  assert.equal(fs.statSync(script).mode & 0o777, 0o700);
  assert.equal(launcher('/path with space/agent', [], {}).includes("'/path with space/agent'"), true);
});
