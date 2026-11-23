// Foreground package output retains a single ChildProcess handle through cleanup and cannot retire a newer run by an old callback.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { packageOutput } = createRequire(import.meta.url)('../electron/harness/packageOutput.cjs');

test('foreground logs, Stop and actual completion share the same command owner', () => {
  const spawned: any[] = [];
  const killed: number[] = [];
  const ended: any[] = [];
  const output: string[] = [];
  const channel = packageOutput((argv: string[], options: any, events: any) => {
    const index = spawned.length;
    spawned.push({ argv, options, events });
    return { kill: () => killed.push(index) };
  });
  const opts = { command: ['npm', 'install'], cwd: '/project', env: { PATH: '/node' } };
  const handlers = { onData: (data: string) => output.push(data), onExit: (event: any) => ended.push(event) };
  channel.kill('missing');
  channel.write('one', 'ignored');
  channel.resize('one', 80, 24);
  channel.spawn('one', opts, handlers);
  assert.deepEqual(spawned[0].argv, opts.command);
  assert.deepEqual(spawned[0].options, { cwd: opts.cwd, env: opts.env });
  spawned[0].events.onData('install output');
  channel.kill('one');
  channel.kill('one');
  assert.deepEqual(output, ['install output']);
  assert.deepEqual(ended, []);
  assert.deepEqual(killed, [0, 0]);
  assert.throws(() => channel.spawn('one', opts, handlers), /still retiring/);
  spawned[0].events.onExit({ exitCode: 0 });
  channel.spawn('one', opts, handlers);
  spawned[0].events.onExit({ exitCode: 0 });
  channel.kill('one');
  assert.deepEqual(killed, [0, 0, 1], 'an obsolete completion cannot delete the replacement handle');
  spawned[1].events.onExit({ exitCode: 0 });
  channel.kill('one');
  assert.deepEqual(killed, [0, 0, 1]);
});

test('a failed spawn releases only its own entry, and a synchronous close leaves no stale owner', () => {
  let first = true;
  const ended: any[] = [];
  const channel = packageOutput((_argv: string[], _options: any, events: any) => {
    if (first) {
      first = false;
      throw new Error('spawn failed');
    }
    channel.kill('one'); // cancellation before a handle exists cannot authorize any process signal
    events.onExit({ exitCode: 1 });
    return { kill: () => assert.fail('a completed child cannot be killed') };
  });
  const handlers = { onData() {}, onExit: (event: any) => ended.push(event) };
  assert.throws(() => channel.spawn('one', { command: ['missing'] }, handlers), /spawn failed/);
  channel.spawn('one', { command: ['done'] }, handlers);
  channel.kill('one');
  assert.deepEqual(ended, [{ exitCode: 1 }]);
});

test('a reentrant replacement survives the old adapter closing synchronously and then throwing', () => {
  let first = true;
  let killed = 0;
  const opts = { command: ['package'] };
  const handlers = {
    onData() {},
    onExit() {
      channel.spawn('same', opts, { onData() {}, onExit() {} });
    },
  };
  const channel = packageOutput((_argv: any, _options: any, events: any) => {
    if (first) {
      first = false;
      events.onExit({ exitCode: 1 });
      throw new Error('old adapter failed after completion');
    }
    return {
      kill: () => {
        killed++;
      },
    };
  });
  assert.throws(() => channel.spawn('same', opts, handlers), /old adapter failed/);
  channel.kill('same');
  assert.equal(killed, 1);
});
