// electron/platform/virtualMachine.cjs: the one check of whether MoPilot runs inside a virtual machine (behind the release
// suites' gate and the app), and the VM-only bench switch that counts a benchmark VM as attended for computer use (#1600).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  VM_SYSCTL,
  SYSCTL,
  execText,
  vmFromProbe,
  probeVirtualMachine,
  benchAttended,
  makeBenchAttended,
} = require('../electron/platform/virtualMachine.cjs');
const { insideVirtualMachine } = require('../scripts/release-suites.cjs');

const fails = () => {
  throw new Error('unknown oid');
};

test('vmFromProbe: kern.hv_vmm_present on macOS; another platform or a failed probe is not a VM', () => {
  assert.deepEqual(VM_SYSCTL, ['-n', 'kern.hv_vmm_present']);
  // by its full path: a PATH with another sysctl can't make a Mac pass for a VM
  assert.equal(SYSCTL, '/usr/sbin/sysctl');
  assert.equal(
    vmFromProbe('darwin', () => '1\n'),
    true,
  );
  assert.equal(
    vmFromProbe('darwin', () => '0\n'),
    false,
  );
  assert.equal(
    vmFromProbe('linux', () => '1\n'),
    false,
  );
  assert.equal(vmFromProbe('darwin', fails), false);
  // the suites' synchronous gate decides the same way
  assert.equal(insideVirtualMachine({ platform: 'darwin', sysctl: () => '1\n' }), true);
  assert.equal(insideVirtualMachine({ platform: 'darwin', sysctl: fails }), false);
});

test('probeVirtualMachine: the same decision without blocking main; a failed or missing probe is not a VM', async () => {
  assert.equal(await probeVirtualMachine({ platform: 'darwin', sysctl: async () => '1\n' }), true);
  assert.equal(await probeVirtualMachine({ platform: 'darwin', sysctl: async () => '0\n' }), false);
  assert.equal(await probeVirtualMachine({ platform: 'win32', sysctl: async () => '1\n' }), false);
  assert.equal(await probeVirtualMachine({ platform: 'darwin', sysctl: async () => fails() }), false);
  // the real probe agrees with the suites' gate on this machine
  assert.equal(await probeVirtualMachine(), insideVirtualMachine());
  assert.equal(await probeVirtualMachine({ platform: 'darwin' }), insideVirtualMachine({ platform: 'darwin' }));
});

test('execText: a command’s output, or its failure, without blocking', async () => {
  const calls: any[] = [];
  const ok = (file: string, args: string[], o: any, cb: Function) => (calls.push([file, args, o]), cb(null, '1\n'));
  assert.equal(await execText('/usr/sbin/sysctl', ['-n', 'x'], ok), '1\n');
  assert.deepEqual(calls, [['/usr/sbin/sysctl', ['-n', 'x'], { encoding: 'utf8' }]]);
  const bad = (_f: string, _a: string[], _o: any, cb: Function) => cb(new Error('ENOENT'), '');
  await assert.rejects(execText('/nope', [], bad), /ENOENT/);
  assert.equal(typeof (await execText(process.execPath, ['-e', 'process.stdout.write("ok")'])), 'string');
});

test('benchAttended: only MOPILOT_BENCH_ATTENDED=1 inside a VM; ignored on a host, unset or set to anything else (#1600)', async () => {
  let probes = 0;
  const vm = async () => (probes++, true);
  const host = async () => false;
  assert.equal(await benchAttended({ MOPILOT_BENCH_ATTENDED: '1' }, vm), true);
  assert.equal(await benchAttended({ MOPILOT_BENCH_ATTENDED: '1' }, host), false, 'a real Mac never counts as attended by a switch');
  for (const v of [undefined, '', '0', 'true', 'yes', ' 1', '1 ']) {
    assert.equal(await benchAttended({ MOPILOT_BENCH_ATTENDED: v }, vm), false, `MOPILOT_BENCH_ATTENDED=${JSON.stringify(v)}`);
  }
  assert.equal(probes, 1, 'without the switch the machine is never probed');
  // the default reads this process's environment and probes the machine
  assert.equal(await benchAttended(), process.env.MOPILOT_BENCH_ATTENDED === '1' && insideVirtualMachine());
});

test('makeBenchAttended: probes the machine once per process, and a failed probe is not a VM', async () => {
  let probes = 0;
  const once = makeBenchAttended(async () => (probes++, true));
  assert.deepEqual(await Promise.all([once({ MOPILOT_BENCH_ATTENDED: '1' }), once({ MOPILOT_BENCH_ATTENDED: '1' })]), [true, true]);
  assert.equal(await once({}), false);
  assert.equal(probes, 1);
  const failing = makeBenchAttended(() => probeVirtualMachine({ platform: 'darwin', sysctl: async () => fails() }));
  assert.equal(await failing({ MOPILOT_BENCH_ATTENDED: '1' }), false);
  // the default probe is probeVirtualMachine
  assert.equal(await makeBenchAttended()({ MOPILOT_BENCH_ATTENDED: '1' }), insideVirtualMachine());
});

test('one VM check: no other JavaScript source names kern.hv_vmm_present', () => {
  const { spawnSync } = require('node:child_process');
  // status 1: no file matches
  const root = new URL('..', import.meta.url).pathname;
  const found = spawnSync('git', ['grep', '-l', '--untracked', 'kern.hv_vmm_present', '--', '*.cjs', '*.mjs', '*.js', '*.ts', '*.tsx'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.ok(found.status === 0 || found.status === 1, found.stderr);
  const files = String(found.stdout)
    .split('\n')
    .filter(Boolean)
    // the helper holds the flag; this test names it
    .filter((f) => f !== 'electron/platform/virtualMachine.cjs' && f !== 'tests/virtualMachine.test.ts');
  assert.deepEqual(files, [], 'use VM_SYSCTL / vmFromProbe from electron/platform/virtualMachine.cjs instead of probing again');
});
