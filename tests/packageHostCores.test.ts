// scripts/package.mjs without the Host's builds of the Rust core: a package still builds, and says what it lacks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { recorder } from './support/scripts-shared-cli.ts';
import { pkg, tools } from './support/package-tools.ts';

const pkgScript = await import('../scripts/package.mjs');

test('package: without Host builds it says so, records nothing and ships none', async () => {
  const hostCores = path.resolve('build/vendor/host-core');
  const t = tools({ existsSync: recorder((f: string) => f !== hostCores) });
  assert.equal(await pkgScript.main(['--arch', 'arm64'], { ...t, env: {}, pkg } as any), 0);
  assert.equal(t.recordHostCores.calls.length, 0);
  assert.equal(t.signHostCores.calls.length, 0);
  assert.ok(!t.packager.calls[0][0].extraResource.includes(hostCores));
  assert.ok(t.log.calls.some(([text]: string[]) => text.includes('carries no Host builds')));
});
