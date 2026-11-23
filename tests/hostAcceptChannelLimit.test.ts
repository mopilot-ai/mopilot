// The acceptance run's channel to a machine: a command may be given a longer limit than the channel's own (a test run in the machine), and one without keeps the channel's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createChannel, sshLauncher } from '../scripts/host-accept/channel.mjs';

test('A: a command given its own limit is not cut at the channel’s, and one without is', async () => {
  const slow = () => () => {
    const child: any = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      stdin: null,
      kill: () => undefined,
    });
    setTimeout(() => child.emit('close', 0), 60);
    return child;
  };
  const channel = createChannel({ launcher: sshLauncher('x'), spawnFn: slow() as any, timeoutMs: 20 });
  assert.deepEqual([(await channel.run('a')).code, (await channel.run('a', undefined, { timeoutMs: 2_000 })).code], [-1, 0]);
});
