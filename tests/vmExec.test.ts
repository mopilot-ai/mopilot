// scripts/vm-exec.sh picks the virtual machine (--vm, MOPILOT_VM, then mopilot-bench), refuses anything but a mopilot-* machine, and hands the rest of the command to `tart exec` unchanged.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// a stand-in `tart` that prints the arguments it was given, one per line
const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-exec-'));
after(() => fs.rmSync(bin, { recursive: true, force: true }));
fs.writeFileSync(path.join(bin, 'tart'), '#!/bin/sh\nfor a in "$@"; do echo "$a"; done\n', { mode: 0o755 });

function run(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync('scripts/vm-exec.sh', args, {
    encoding: 'utf8',
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: os.homedir(), MOPILOT_VM_HOSTS: path.join(bin, 'absent-hosts'), ...env },
  });
  return { status: r.status, argv: r.stdout.split('\n').filter(Boolean), stderr: r.stderr };
}

test('the default machine is mopilot-bench, and MOPILOT_VM overrides it', () => {
  assert.deepEqual(run(['zsh', '-lc', 'echo hi']).argv, ['exec', 'mopilot-bench', 'zsh', '-lc', 'echo hi']);
  assert.deepEqual(run(['true'], { MOPILOT_VM: 'mopilot-cuj' }).argv, ['exec', 'mopilot-cuj', 'true']);
});

test('--vm picks the machine and is not passed on to the command', () => {
  assert.deepEqual(run(['--vm', 'mopilot-cuj', 'zsh', '/Users/admin/run.sh', '--vm']).argv, [
    'exec',
    'mopilot-cuj',
    'zsh',
    '/Users/admin/run.sh',
    '--vm',
  ]);
  // --vm wins over MOPILOT_VM
  assert.deepEqual(run(['--vm', 'mopilot-cuj', 'true'], { MOPILOT_VM: 'mopilot-bench' }).argv, ['exec', 'mopilot-cuj', 'true']);
});

test('only a mopilot-* machine is reached, and a command is required', () => {
  for (const args of [['--vm', 'other-vm', 'true'], ['--vm', 'mopilot-', 'true'], ['--vm']]) {
    const r = run(args);
    assert.equal(r.status, 2, args.join(' '));
    assert.deepEqual(r.argv, [], args.join(' '));
    assert.match(r.stderr, /must name a mopilot-\* machine/);
  }
  assert.equal(run(['true'], { MOPILOT_VM: 'ubuntu' }).status, 2);
  for (const args of [[], ['--vm', 'mopilot-cuj']]) {
    const r = run(args);
    assert.equal(r.status, 2, args.join(' '));
    assert.match(r.stderr, /^usage: scripts\/vm-exec\.sh/);
  }
});

test('a machine name that walks out of its own directory is refused, so it cannot reach another VM on the host', () => {
  for (const vm of [
    'mopilot-x/../mopilot-bench',
    'mopilot-cuj/..',
    'mopilot-../x',
    'mopilot-a b',
    'mopilot--x',
    'mopilot-x/y',
    'mopilot-é',
  ]) {
    for (const r of [run(['--vm', vm, 'true']), run(['true'], { MOPILOT_VM: vm })]) {
      assert.equal(r.status, 2, vm);
      assert.deepEqual(r.argv, [], `${vm} reached tart`);
      assert.match(r.stderr, /must name a mopilot-\* machine/);
    }
  }
  assert.deepEqual(run(['--vm', 'mopilot-g8frames-28b0.v2', 'true']).argv, ['exec', 'mopilot-g8frames-28b0.v2', 'true']);
});
