// Managed package caches keep one stable version owner across preparation, launch, auth, failure and retry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { registryAgent } from '../shared/acpRegistry.mjs';
const require = createRequire(import.meta.url);
const { RegistryHarnesses } = require('../electron/harness/registry/service.cjs');
const { writeLauncher } = require('../electron/harness/registry/install.cjs');
const { installFs } = require('../electron/platform/ports/fs.cjs');

for (const kind of ['npx', 'uvx'])
  test(`${kind} versions retain their cache after publication; cancelled retries cannot reuse a damaged owner`, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mopilot-registry-cache-'));
    const dir = path.join(root, 'registry cache $literal');
    const driver = path.join(root, 'manager.cjs');
    const manager = path.join(root, 'manager');
    fs.writeFileSync(
      driver,
      `const fs = require('node:fs');
const args = process.argv.slice(2);
console.log(JSON.stringify({ args, ready: fs.readFileSync(require('node:path').join(args[1], 'ready'), 'utf8'), acp: process.env.ACP_ONLY, auth: process.env.AUTH_ONLY }));
`,
    );
    writeLauncher(manager, { program: process.execPath, args: [driver], env: {} });
    const entry = (version: string) =>
      registryAgent({
        id: `cache-${kind}`,
        name: 'Cache agent',
        version,
        distribution: { [kind]: { package: kind === 'npx' ? '@example/cache' : 'cache-agent', args: ['--acp'], env: { ACP_ONLY: '1' } } },
      });
    const catalog = { agents: [entry('1.0.0')], dispose() {} };
    const service = new RegistryHarnesses({ dir, platform: 'linux', arch: 'x64', which: () => manager, catalog });
    t.after(async () => {
      await service.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    });
    const flag = kind === 'npx' ? '--cache' : '--cache-dir';
    const caches: string[] = [];
    const stages: string[] = [];
    const prepare = async (spec: any) => {
      const index = spec.argv.indexOf(flag);
      assert.ok(index > 0, 'package preparation must select its owned cache explicitly');
      const cache = spec.argv[index + 1];
      assert.ok(cache.startsWith(path.join(dir, '.packages', `cache-${kind}`) + path.sep));
      assert.equal(cache.startsWith(spec.cwd + path.sep), false, 'virtual environments must not move when staging is published');
      caches.push(cache);
      stages.push(spec.cwd);
      fs.mkdirSync(cache, { recursive: true });
      fs.writeFileSync(path.join(cache, 'ready'), catalog.agents[0].version);
    };
    const execute = (file: string, auth = false) =>
      JSON.parse(
        execFileSync(file, [auth ? '--login' : 'turn'], {
          encoding: 'utf8',
          env: { ...process.env, ACP_ONLY: undefined, AUTH_ONLY: auth ? '1' : undefined },
        }),
      );
    const first = await service.install(`cache-${kind}`, prepare);
    const launch = execute(first.file);
    assert.deepEqual(launch.args.slice(0, 2), [flag, caches[0]]);
    assert.equal(launch.ready, '1.0.0');
    assert.equal(launch.acp, '1');
    const auth = execute(service.resolveAuth(first.id), true);
    assert.deepEqual(auth.args.slice(0, 2), [flag, caches[0]]);
    assert.equal(auth.args.includes('--acp'), false);
    assert.equal(auth.acp, undefined);
    assert.equal(auth.auth, '1');
    assert.equal(auth.ready, '1.0.0');
    assert.equal(fs.existsSync(stages[0]), false);

    catalog.agents = [entry('2.0.0')];
    const second = await service.install(`cache-${kind}`, prepare);
    assert.notEqual(caches[1], caches[0]);
    assert.equal(execute(first.file).ready, '1.0.0', 'a running version retains its original package files');
    assert.equal(execute(second.file).ready, '2.0.0');

    catalog.agents = [entry('3.0.0')];
    await assert.rejects(
      service.install(`cache-${kind}`, async (spec: any) => {
        await prepare(spec);
        throw new Error('cancelled after process retirement');
      }),
      /cancelled/,
    );
    assert.equal(fs.existsSync(caches[2]), false);
    assert.equal(fs.existsSync(stages[2]), false);
    assert.equal(execute(second.file).ready, '2.0.0');
    service.onInstalled = async () => {
      throw new Error('admission offline');
    };
    await assert.rejects(service.install(`cache-${kind}`, prepare), /admission offline/);
    assert.notEqual(caches[3], caches[2]);
    assert.equal(fs.existsSync(caches[3]), true, 'committed caches survive a failed admission callback');
    service.onInstalled = async () => undefined;
    const third = await service.install(`cache-${kind}`, () => assert.fail('committed package is reused'));
    assert.equal(execute(third.file).ready, '3.0.0');

    catalog.agents = [entry('4.0.0')];
    const previous = installFs({
      ...fs,
      renameSync: (from: string, to: string) => {
        if (to === service.file) throw new Error('manifest write failed');
        return fs.renameSync(from, to);
      },
    });
    try {
      await assert.rejects(service.install(`cache-${kind}`, prepare), /manifest write failed/);
    } finally {
      installFs(previous);
    }
    assert.equal(fs.existsSync(caches[4]), false);
    assert.equal(fs.existsSync(stages[4]), false);
    assert.equal(service.resolve(third.id), third.file);
    assert.equal(execute(third.file).ready, '3.0.0');
  });
