// Claude presence scans are shared across windows only while pending, and release ownership on every outcome.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const sid = (n: number) => `${String(n).padStart(8, '0')}-0000-0000-0000-000000000000`;

function fixture(options: { windows?: boolean } = {}) {
  const calls: { route: string; finish: (rows: unknown) => void; fail: (error: Error) => void }[] = [];
  const noted: string[] = [];
  const file = path.resolve(root, 'electron/harness/claude/presence.cjs');
  const instance = new Module(file);
  instance.filename = file;
  instance.require = (name: string) => {
    if (name === './cli.cjs') return { isWin: () => !!options.windows };
    if (name === '../../platform/core.cjs')
      return {
        coreCall: (route: string) => new Promise((finish, fail) => calls.push({ route, finish, fail })),
      };
    if (name === '../../ignored.cjs') return { noteIgnored: (context: string, error: Error) => noted.push(`${context}: ${error.message}`) };
    throw new Error(`Unexpected dependency: ${name}`);
  };
  (instance as Module & { _compile(text: string, file: string): void })._compile(fs.readFileSync(file, 'utf8'), file);
  return { ...instance.exports, calls, noted };
}

test('overlapping window and send callers share one process scan; the next read is fresh', async () => {
  const f = fixture();
  const waiting = Array.from({ length: 12 }, () => f.presence());
  const count = f.calls.length;
  f.calls[0].finish([
    [100, 1, '/Applications/Claude.app/Contents/MacOS/Claude'],
    [101, 100, `claude --resume=${sid(1)}`],
  ]);
  const results = await Promise.all(waiting);
  assert.equal(count, 1, 'one pending scan serves all 12 callers');
  assert.equal(f.calls[0].route, 'proc.commands');
  for (const result of results) assert.deepEqual(result, { [sid(1)]: ['claude-desktop'] });
  assert.equal(new Set(waiting).size, 1, 'all concurrent callers await the same operation');
  const fresh = f.presence();
  assert.equal(f.calls.length, 2);
  f.calls[1].finish([]);
  assert.deepEqual(await fresh, {}, 'the completed result is never cached');
});

test('a read that fails is noted and seen as no other apps, so a send waits on nothing, and a retry reads afresh', async () => {
  const f = fixture();
  const first = f.presence();
  const second = f.presence();
  f.calls[0].fail(new Error('read the process table: EPERM'));
  assert.deepEqual(await first, {});
  assert.deepEqual(await second, {});
  assert.deepEqual(f.noted, ["read other apps' Claude Code processes: read the process table: EPERM"]);
  const retry = f.presence();
  assert.equal(f.calls.length, 2);
  f.calls[1].finish([[100, 1, `claude -r ${sid(2)}`]]);
  assert.deepEqual(await retry, { [sid(2)]: ['other'] });
});

test('consumer continuations can start a replacement without an old cleanup clearing it', async () => {
  const f = fixture();
  const first = f.presence();
  const nextFromConsumer = first.then(() => f.presence());
  f.calls[0].finish([]);
  await first;
  const replacement = f.presence();
  assert.equal(f.calls.length, 2);
  f.calls[1].finish([[100, 1, `claude -r ${sid(3)}`]]);
  assert.deepEqual(await replacement, { [sid(3)]: ['other'] });
  assert.deepEqual(await nextFromConsumer, { [sid(3)]: ['other'] });
});

test('Windows reads no process table and creates no retained pending scan', async () => {
  const f = fixture({ windows: true });
  assert.deepEqual(await f.presence(), {});
  assert.deepEqual(await f.presence(), {});
  assert.equal(f.calls.length, 0);
});

test('the shared scan preserves parser exclusions and all supported parent classifications', async () => {
  const f = fixture();
  const pending = f.presence();
  const deep = Array.from({ length: 14 }, (_, i) => [600 + i, 601 + i, '/bin/bash']);
  f.calls[0].finish([
    [1, 0, '/sbin/launchd'],
    [100, 1, '/Applications/Claude.app/Contents/MacOS/Claude'],
    [101, 100, `/bin/claude --resume=${sid(1)}`],
    [200, 1, '/Applications/iTerm.app/Contents/MacOS/iTerm2'],
    [201, 200, `claude -r ${sid(2)}`],
    [300, 1, '/x/sagecode/Electron .'],
    [301, 300, `claude --session-id ${sid(3)}`],
    [400, process.pid, `claude --resume ${sid(4)}`],
    [process.pid, 1, `claude --resume ${sid(4)}`],
    [401, 1, `wrapper claude --resume ${sid(4)}`],
    [402, 1, 'claude --continue'],
    [500, 1, '/bin/bash'],
    [501, 500, `claude --resume ${sid(5)}`],
    [502, 999, `claude --resume ${sid(5)}`],
    ...deep,
    [700, 600, `claude --resume ${sid(6)}`],
  ]);
  assert.deepEqual(await pending, {
    [sid(1)]: ['claude-desktop'],
    [sid(2)]: ['claude-cli'],
    [sid(3)]: ['sage'],
    [sid(5)]: ['other', 'other'],
    [sid(6)]: ['other'],
  });
});
