// Which Rust core a machine takes (shared/host/coreBuild.mjs): the build named by the Node that will load it, the same words from the shell probe and from inside a Host, and a refusal that says what is wrong.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { userError } from '../shared/userError.mjs';
import { CORE_BUILDS, coreBuildHere, coreBuildOf, coreProbeCommand, noCoreBuild, notAsked } from '../shared/host/coreBuild.mjs';

test('the build is the last line the machine printed, and only a build there is counts', () => {
  for (const build of CORE_BUILDS) assert.equal(coreBuildOf(`${build}\n`), build);
  assert.equal(coreBuildOf('Welcome to the box\n  linux-arm64-musl  \n'), 'linux-arm64-musl');
  for (const said of ['', '\n', 'linux-arm-gnu', 'linux-x64', 'freebsd-x64', 'linux-x64-gnu extra']) assert.equal(coreBuildOf(said), null);
});

test('the shell probe and the Host agree, and the Node running here is one the app has a build for', () => {
  const r = spawnSync('/bin/sh', ['-c', coreProbeCommand(`"${process.execPath}"`)], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), coreBuildHere());
  assert.equal(coreBuildOf(r.stdout), coreBuildHere());
});

test('inside a Host the build comes from the same facts: the C library counts on Linux only', () => {
  const report = (glibcVersionRuntime?: string) => ({ getReport: () => ({ header: { glibcVersionRuntime } }) });
  assert.equal(coreBuildHere({ platform: 'linux', arch: 'x64', report: report('2.31') }), 'linux-x64-gnu');
  assert.equal(coreBuildHere({ platform: 'linux', arch: 'arm64', report: report() }), 'linux-arm64-musl');
  assert.equal(coreBuildHere({ platform: 'darwin', arch: 'arm64', report: report() }), 'darwin-arm64');
  assert.equal(coreBuildHere({ platform: 'darwin', arch: 'x64', report: report('2.31') }), 'darwin-x64');
});

test('the probe keeps to double quotes: it travels inside single ones over ssh', () => {
  const body = coreProbeCommand('node')
    .replace(/^node -e '/, '')
    .replace(/'$/, '');
  assert.ok(!body.includes("'"));
});

test('a refusal survives userError whole, in one line, whether or not the machine named itself', () => {
  for (const said of ['motd\nlinux-riscv64-gnu\n', '']) {
    const text = noCoreBuild(said);
    assert.equal(userError(new Error(text)), text);
    assert.match(text, /a Host already on it keeps running\.$/);
  }
  assert.match(noCoreBuild('linux-riscv64-gnu'), /\(linux-riscv64-gnu\)/);
  assert.equal(notAsked('node: not found\nmore'), 'Could not ask this machine which Host build it needs: node: not found');
  assert.match(notAsked(''), /needs: the command failed$/);
  assert.doesNotMatch(notAsked('x'), /no Host build/);
});
