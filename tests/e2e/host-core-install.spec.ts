// e2e-runner: bench
// A Host installed by the app's installer on Linux loads its Rust core (tests/e2e/fixtures/hostCoreInstall.ts), and the other Linux builds load where no service can run: musl in Alpine, whose busybox tar also reads the two-part archive, and glibc on the floor, 2.17, under the Node such a machine has. Named on the command line only, and routed to the Linux x64 runner: `node scripts/ci-cuj.mjs --spec tests/e2e/host-core-install.spec.ts`.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { ROOT, buildCore, installAndCheck, routesUnderElectron } from './fixtures/hostCoreInstall';

/** The glibc 2.17 container; asked of a Node of its own: Playwright's transform cannot load that script, which reads import.meta. */
const manylinux = () =>
  execFileSync(process.execPath, ['--input-type=module', '-e', "console.log((await import('./scripts/build-core.mjs')).MANYLINUX_X64)"], {
    cwd: ROOT,
    encoding: 'utf8',
  }).trim();

const { buildBundle } = createRequire(__filename)('../../electron/host/bundle.cjs');

test.skip(!process.env.GITHUB_ACTIONS, 'a runner only: it turns on sshd and installs a service');

/** A Node 22 for glibc 2.17, from Node's unofficial builds, as an old machine would run; checked against its published sum. */
const OLD_NODE = { version: 'v22.23.4', sha256: 'd78ff597c40339cd3f40c7f33abe7a46a16c30899c3323a90263e4f028acf870' };

/** What a bundle's `status` says in `image`, unpacked there with the image's own tar. */
function statusIn(image: string, build: string, node = 'node', mounts: string[] = []) {
  buildCore(build);
  const built = buildBundle({ root: ROOT, outDir: fs.mkdtempSync(path.join(os.tmpdir(), 'host-core-bundle-')), build });
  const script = `mkdir -p /h && tar -xzf /bundle/${path.basename(built.file)} -C /h && ${node} /h/host/bin/mopilot-host.mjs status --data-dir /tmp/host`;
  const run = spawnSync('docker', ['run', '--rm', '-v', `${path.dirname(built.file)}:/bundle:ro`, ...mounts, image, 'sh', '-c', script], {
    encoding: 'utf8',
  });
  expect(run.status, run.stderr).toBe(0);
  return JSON.parse(run.stdout).core;
}

test('the installer puts the Host and its core on this machine, and the core answers', () => {
  test.setTimeout(14 * 60_000);
  buildCore('linux-x64-gnu');
  expect(routesUnderElectron('linux-x64-gnu')).toBeGreaterThan(0);
  installAndCheck('linux-x64-gnu');
});

test('the musl addon loads in Node on Alpine', () => {
  test.setTimeout(14 * 60_000);
  for (const image of ['node:22-alpine', 'node:24-alpine']) {
    const core = statusIn(image, 'linux-x64-musl');
    expect(core).toMatchObject({ loaded: true, build: 'linux-x64-musl' });
    expect(core.routes).toBeGreaterThan(0);
  }
});

test('the glibc addon loads on glibc 2.17 under a Node built for it', () => {
  test.setTimeout(14 * 60_000);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-core-old-node-'));
  const name = `node-${OLD_NODE.version}-linux-x64-glibc-217`;
  const tarball = path.join(dir, `${name}.tar.gz`);
  execFileSync('curl', [
    '-fsSL',
    '-o',
    tarball,
    `https://unofficial-builds.nodejs.org/download/release/${OLD_NODE.version}/${name}.tar.gz`,
  ]);
  expect(createHash('sha256').update(fs.readFileSync(tarball)).digest('hex')).toBe(OLD_NODE.sha256);
  execFileSync('tar', ['-xzf', tarball, '-C', dir]);
  const core = statusIn(manylinux(), 'linux-x64-gnu', `/node/${name}/bin/node`, ['-v', `${dir}:/node:ro`]);
  expect(core).toMatchObject({ loaded: true, build: 'linux-x64-gnu' });
  expect(core.routes).toBeGreaterThan(0);
});
