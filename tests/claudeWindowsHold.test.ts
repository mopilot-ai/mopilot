// On Windows, where watchTree records nothing, a Claude Code CLI's tree is held in a Job Object from its reported pid
// and what it left running ends when its session finishes or the SDK starts it again (electron/harness/claude/sessionLifetime.cjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createSessionLifetime } = require('../electron/harness/claude/sessionLifetime.cjs');

const state = () => ({ sessions: new Map(), retiring: new Map(), prewarmed: new Set(), timing: { retireMs: 0 } });
/** A lifetime on `platform` whose holds and ends are recorded. */
function lifetime(platform: string) {
  const held: number[] = [];
  const ended: number[] = [];
  const life = createSessionLifetime(state(), {
    platform,
    hold: (pid: number) => (held.push(pid), Promise.resolve(true)),
    endHeld: async (h: { pid: number }) => (ended.push(h.pid), true),
  });
  return { life, held, ended };
}

test('on Windows the CLI is held from its pid, and its job ends when the session finishes, once', () => {
  const { life, held, ended } = lifetime('win32');
  const s: any = { key: 'k' };
  life.claim(s);
  life.watch(s, 4242);
  assert.deepEqual(held, [4242]);
  assert.deepEqual(ended, []);
  life.finish(s);
  life.finish(s);
  assert.deepEqual(ended, [4242], 'a second finish has nothing left to end');
});

test('a CLI the SDK starts again is held afresh, and the replaced one’s job ends', () => {
  const { life, held, ended } = lifetime('win32');
  const s: any = { key: 'k' };
  life.watch(s, 1);
  life.watch(s, 2);
  assert.deepEqual(held, [1, 2]);
  assert.deepEqual(ended, [1]);
  life.finish(s);
  assert.deepEqual(ended, [1, 2]);
});

test('elsewhere the process group recording does this, and nothing is held', () => {
  const { life, held, ended } = lifetime('darwin');
  const s: any = { key: 'k' };
  life.watch(s, 999_999); // no such process: nothing of this test runner is recorded or reaped
  life.finish(s);
  assert.deepEqual(held, []);
  assert.deepEqual(ended, []);
});
