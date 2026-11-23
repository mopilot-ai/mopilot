// The exit gate's quiet request (a restart nobody asked for, electron/app/stealthUpdate.cjs): it never asks, and never answers a quit the user asked for.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ExitGate, emptySummary } = require('../electron/platform/exitGate.cjs');

function gate(sum: any, confirmClose = 'shortcut') {
  const asked: string[] = [];
  let answer = (_v: boolean) => {};
  let collect = async () => sum;
  const g = new ExitGate({
    collect: () => collect(),
    confirm: (_s: any, reason: string) => (asked.push(reason), new Promise<boolean>((r) => (answer = r))),
    confirmClose: () => confirmClose,
    pauseCodex: async () => {},
    pauseClaude: async () => {},
  });
  return { g, asked, answer: (v: boolean) => answer(v), setCollect: (fn: () => Promise<any>) => (collect = fn) };
}
const running = { ...emptySummary(), turns: [{ chatId: 'c', title: 't' }] };

test('a quiet request passes when nothing would stop, and gives up without asking otherwise', async () => {
  assert.equal(await gate(emptySummary()).g.request('update', { quiet: true }), true);
  for (const [sum, confirmClose] of [
    [running, 'shortcut'],
    // "never ask me when I quit" is not "stop my work unattended"
    [running, 'never'],
    [emptySummary(), 'always'],
  ] as const) {
    const { g, asked } = gate(sum, confirmClose);
    assert.equal(await g.request('update', { quiet: true }), false);
    assert.deepEqual(asked, [], 'nobody is asked about a restart they did not ask for');
    assert.equal(g.passed, false, 'a later quit still goes through the gate');
  }
  const { g, setCollect } = gate(emptySummary());
  setCollect(async () => {
    throw new Error('count failed');
  });
  assert.equal(await g.request('update', { quiet: true }), false, 'not knowing what would stop is not quiet');
});

test("a quit the user asks for while a quiet request runs is asked itself, not answered by the quiet 'no'", async () => {
  let release!: () => void;
  const { g, asked, answer, setCollect } = gate(running);
  setCollect(() => new Promise((r) => (release = () => r(running))));
  const quiet = g.request('update', { quiet: true });
  const user = g.request('quit');
  // another quiet request meanwhile shares the quiet answer
  const quiet2 = g.request('update', { quiet: true });
  setCollect(async () => running);
  release();
  assert.equal(await quiet, false);
  assert.equal(await quiet2, false);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(asked, ['quit']);
  answer(true);
  assert.equal(await user, true);
  // and a quiet request that passed lets the user's quit through with it
  const p = gate(emptySummary());
  const q = p.g.request('update', { quiet: true });
  assert.equal(await p.g.request('quit'), true);
  assert.equal(await q, true);
});

test('a gate that let a restart through asks again once it reopens (the restart did not happen)', async () => {
  const { g, asked, answer } = gate(running);
  answer(true);
  g.passed = true;
  assert.equal(await g.request('quit'), true, 'passed: nothing asked');
  g.reopen();
  const q = g.request('quit');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(asked, ['quit']);
  answer(false);
  assert.equal(await q, false);
});
