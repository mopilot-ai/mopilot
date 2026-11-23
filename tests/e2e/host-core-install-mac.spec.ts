// e2e-runner: bench
// A Host installed by the app's installer on macOS loads its Rust core (tests/e2e/fixtures/hostCoreInstall.ts). Named on the command line only: `node scripts/ci-cuj.mjs --spec tests/e2e/host-core-install-mac.spec.ts`.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { coreBuildHere } from '../../shared/host/coreBuild.mjs';
import { ROOT, buildCore, installAndCheck, routesUnderElectron } from './fixtures/hostCoreInstall';

test.skip(process.platform !== 'darwin', 'this is the macOS install; host-core-install.spec.ts is Linux');
test.skip(!process.env.GITHUB_ACTIONS, 'a runner only: it turns on sshd and installs a service');

test('the installer puts the Host and its core on this Mac, and the core answers', () => {
  test.setTimeout(14 * 60_000);
  const build = coreBuildHere();
  const core = path.join(ROOT, 'core');
  execFileSync('rustup', ['toolchain', 'install'], { cwd: core, stdio: 'inherit' });
  execFileSync('rustup', ['target', 'add', process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin'], {
    cwd: core,
    stdio: 'inherit',
  });
  buildCore(build);
  expect(routesUnderElectron(build)).toBeGreaterThan(0);
  installAndCheck(build);
});
