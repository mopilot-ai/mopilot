// Which Host tarball a machine gets (electron/host/install.cjs, shared/host/coreBuild.mjs): the one for the build its Node names, and none, with nothing changed there, when it has no build or could not be asked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { bundle, machine } from './support/host-install-kit.ts';
const require = createRequire(import.meta.url);
const { createInstaller } = require('../electron/host/install.cjs');

test('the tarball is the one for the build the machine’s Node names, and the step says so', async () => {
  const m = machine({ 'process.report': { stdout: 'motd from a login shell\nlinux-arm64-musl\n' } });
  const asked: string[] = [];
  const out = await createInstaller({
    channel: m.channel,
    bundle: (build: string) => (asked.push(build), { ...bundle(), core: build }),
  }).install('me@box');
  assert.equal(out.ok, true);
  assert.deepEqual(asked, ['linux-arm64-musl']);
  assert.equal(out.steps.find((s: any) => s.id === 'prepare').output, 'Host 1.2.3 for linux-arm64-musl');
  // the Node that will load the addon is the one asked, and it is asked once it is set up
  const ids = m.commands();
  assert.ok(ids.findIndex((c) => c.includes('process.report')) > ids.findIndex((c) => c.includes('echo have')));
  assert.match(m.commands().find((c) => c.includes('process.report')) as string, /runtime\/current\/bin\/node/);
});

test('a machine with no build is refused before anything of the Host changes, and a Host already there stays (A)', async () => {
  const cases: [any, RegExp][] = [
    [{ stdout: 'linux-riscv64-gnu\n' }, /no Host build for this machine \(linux-riscv64-gnu\); a Host already on it keeps running\.$/],
    // a question that failed is not an unsupported machine: what went wrong is said
    [
      { stdout: '', code: 127, stderr: 'node: not found' },
      /^Could not ask this machine which Host build it needs: Node: not found\.$|needs: node: not found\.$/,
    ],
    [new Error('ssh dropped'), /needs: ssh dropped\.$/],
  ];
  for (const [said, words] of cases) {
    const m = machine({
      'process.report': said,
      'test -f': { stdout: 'installed\n{"running":true}\n' },
    });
    let built = 0;
    const out = await createInstaller({ channel: m.channel, bundle: (b: string) => (built++, bundle(b)) }).install('me@box');
    assert.equal(out.failedStep, 'prepare');
    assert.match(out.error, words);
    assert.equal(out.rolledBack, false);
    assert.equal(built, 0, 'no archive is made for it');
    assert.ok(
      !m.commands().some((c) => /cat >|tar -xzf|systemctl|uninstall/.test(c)),
      'nothing was uploaded, unpacked, stopped or removed',
    );
  }
});
