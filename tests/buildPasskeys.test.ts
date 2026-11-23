// scripts/build-passkeys.mjs with clang, codesign and publishing replaced: the compiler line for each arch, ad-hoc or
// unsigned output, macOS only, and the command line. On a Mac, one real build from a checkout that never built it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recorder, runScript } from './support/scripts-shared-cli.ts';

const passkeys = await import('../scripts/build-passkeys.mjs');

test('passkeys: the compiler writes into a folder that exists, in a checkout that never built it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'passkeys-scratch-'));
  try {
    // native/passkeys/build is gitignored, so a fresh clone (the release's runners) has no such folder
    const scratch = path.join(dir, 'never-built', 'build');
    const exec = recorder((_cmd: string, args: string[]) => {
      assert.ok(fs.existsSync(path.dirname(args.at(-1) as string)), 'the output folder exists before clang links');
    });
    passkeys.buildPasskeys({
      out: '/out',
      scratch,
      arch: 'arm64',
      sign: false,
      exec: exec as any,
      platform: 'darwin',
      log: () => {},
      publish: recorder(),
      headers: () => '/inc',
    });
    assert.equal(exec.calls[0][1].at(-1), path.join(scratch, '.passkeys-arm64.node'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const noClang = process.platform !== 'darwin' || spawnSync('clang++', ['--version'], { stdio: 'ignore' }).status !== 0;
test('passkeys: a real build from a clean tree, as the release packages it', { skip: noClang, timeout: 120_000 }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'passkeys-build-'));
  try {
    const out = path.join(dir, 'out');
    const built = passkeys.buildPasskeys({ out, scratch: path.join(dir, 'scratch'), sign: false, log: () => {} });
    assert.equal(built, path.join(out, 'passkeys.node'));
    const file = spawnSync('file', ['-b', built], { encoding: 'utf8' });
    assert.match(file.stdout, /Mach-O 64-bit bundle/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('passkeys: builds on macOS only', () => {
  assert.throws(() => passkeys.buildPasskeys({ platform: 'linux', log: () => {} }), /passkeys\.node builds on macOS only/);
});

test('passkeys: the compiler line for each arch, release or debug', () => {
  const args = passkeys.clangArgs({ arch: 'x64', include: '/inc', source: '/src/passkeys.mm', output: '/out/p.node' });
  assert.deepEqual(args.slice(args.indexOf('-arch'), args.indexOf('-arch') + 3), ['-arch', 'x86_64', '-I/inc']);
  assert.ok(args.includes('-O2'));
  assert.ok(args.includes('-Werror'), 'an unguarded newer API fails the build');
  assert.ok(args.includes('-Wunguarded-availability'));
  assert.deepEqual(args.slice(-3), ['/src/passkeys.mm', '-o', '/out/p.node']);
  const debug = passkeys.clangArgs({ arch: 'arm64', debug: true, include: '/inc', source: 's', output: 'o' });
  assert.ok(debug.includes('-g'));
  assert.equal(debug[debug.indexOf('-arch') + 1], 'arm64');
  assert.equal(
    passkeys.clangArgs({ include: '/i', source: 's', output: 'o' }).includes(process.arch === 'x64' ? 'x86_64' : process.arch),
    true,
  );
});

test('passkeys: compiles, then publishes ad-hoc signed, or unsigned for the package', (t) => {
  // the default scratch folder is made in the checkout; leave none behind where there was none, so a clean-tree
  // repro on this machine stays clean
  const scratch = path.resolve('native/passkeys/build');
  if (!fs.existsSync(scratch)) t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const exec = recorder();
  const publish = recorder((_src: string, _dest: string, sign?: (s: string) => void) => sign?.('/staged'));
  const log = recorder();
  const out = passkeys.buildPasskeys({
    out: '/out',
    arch: 'arm64',
    exec: exec as any,
    platform: 'darwin',
    log,
    publish,
    headers: () => '/inc',
  });
  assert.equal(out, '/out/passkeys.node');
  assert.equal(exec.calls[0][0], 'clang++');
  assert.ok(exec.calls[0][1].includes('-I/inc'));
  assert.match(exec.calls[0][1].at(-1), /native\/passkeys\/build\/\.passkeys-arm64\.node$/);
  assert.deepEqual(exec.calls[1].slice(0, 2), ['codesign', ['--force', '--sign', '-', '/staged']]);
  assert.equal(publish.calls[0][1], '/out/passkeys.node');
  assert.match(log.calls[0][0], /^clang\+\+ /);
  assert.deepEqual(log.calls[1], ['Built /out/passkeys.node (ad-hoc signed)']);

  const exec2 = recorder();
  const publish2 = recorder();
  const log2 = recorder();
  passkeys.buildPasskeys({
    out: '/o',
    arch: 'x64',
    sign: false,
    debug: true,
    exec: exec2 as any,
    platform: 'darwin',
    log: log2,
    publish: publish2,
  });
  assert.equal(publish2.calls[0][2], undefined);
  assert.equal(exec2.calls.length, 1);
  assert.ok(exec2.calls[0][1].includes('-I' + path.resolve('node_modules/node-api-headers/include')), 'the headers package by default');
  assert.deepEqual(log2.calls[1], ['Built /o/passkeys.node (unsigned)']);
});

test('passkeys: the command line passes its options and has --help', () => {
  const build = recorder();
  passkeys.cli(['--out', 'rel/out', '--arch', 'arm64', '--debug'], { build });
  assert.deepEqual(build.calls, [[{ out: path.resolve('rel/out'), arch: 'arm64', debug: true }]]);
  const log = recorder();
  passkeys.cli(['--help'], { build, log });
  assert.match(log.calls[0][0], /^usage: node scripts\/build-passkeys\.mjs/);
  const r = runScript('scripts/build-passkeys.mjs', ['--help']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^usage: /);
});
