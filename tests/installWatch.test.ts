// src/components/harness/installWatch.ts: an open setup step looks for its harness in the background (at once, every
// few seconds and on focus) and looks again once when its binary shows up; waits that run out; a run's elapsed time.
// Also the launch's first moments (src/components/pages/WelcomeColdStart.tsx), which wait with those.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { render } from './support/pages-kit.ts';
import { installNativeStub } from './support/ports/native.ts';

const { createElement: h, act } = await import('react');
const calls: any[] = [];
let answer: () => Promise<string | null> = async () => null;
let recheck: () => Promise<unknown> = async () => undefined;
installNativeStub({
  harnessRuns: { find: (kind: string) => (calls.push(['find', kind]), answer()) },
  app: { ignored: (context: string) => calls.push(['ignored', context]) },
});
mock.module('../src/session/harness/harnessRuns.ts', {
  namedExports: { recheckHarness: (kind: string) => (calls.push(['recheck', kind]), recheck()) },
});
const { useFoundPoll, useAfter, useElapsed, clockText, FIND_EVERY_MS, RECHECK_AFTER_MS } = await import(
  '../src/components/harness/installWatch.ts'
);
const { ColdStart, useColdStartCapped, COLD_START_CAP_MS } = await import('../src/components/pages/WelcomeColdStart.tsx');

const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));
const Poll = ({ kind, active }: { kind: string; active: boolean }) => (useFoundPoll(kind, active), null);
const finds = () => calls.filter((c) => c[0] === 'find').length;

test('the waits are a few seconds to look again, and longer before Re-check or the welcome list shows', () => {
  assert.equal(FIND_EVERY_MS, 3000);
  assert.equal(RECHECK_AFTER_MS, 20_000);
  assert.equal(COLD_START_CAP_MS, 10_000);
});

test('an open step asks at once and on focus; once the binary is there, the harness is looked for again, once', async () => {
  calls.length = 0;
  answer = async () => null;
  const v = await render(h(Poll, { kind: 'acp:qwen', active: true }));
  await settle();
  assert.ok(finds() >= 1, 'asked at once');
  assert.equal(calls.filter((c) => c[0] === 'recheck').length, 0);
  // back from the user's own terminal: asked again
  const before = finds();
  await act(async () => window.dispatchEvent(new Event('focus')));
  await settle();
  assert.ok(finds() > before);
  answer = async () => '/bin/qwen:1:1';
  await act(async () => window.dispatchEvent(new Event('focus')));
  await settle();
  await act(async () => window.dispatchEvent(new Event('focus')));
  await settle();
  const rechecks = () => calls.filter((c) => c[0] === 'recheck');
  assert.deepEqual(rechecks(), [['recheck', 'acp:qwen']], 'looked for again once, however often it is seen');
  await v.unmount();
  // a step that remounts (its row passed through Checking…) over the same binary that didn't run: not again
  const w = await render(h(Poll, { kind: 'acp:qwen', active: true }));
  await settle();
  assert.equal(rechecks().length, 1);
  // a binary that changed (rewritten, made runnable) is looked for again
  answer = async () => '/bin/qwen:2:2';
  await act(async () => window.dispatchEvent(new Event('focus')));
  await settle();
  assert.deepEqual(rechecks(), [
    ['recheck', 'acp:qwen'],
    ['recheck', 'acp:qwen'],
  ]);
  await w.unmount();
});

test('an inactive step asks nothing; one closed before the answer starts nothing; failures are noted, not thrown', async () => {
  calls.length = 0;
  const idle = await render(h(Poll, { kind: 'codex', active: false }));
  await settle();
  assert.equal(finds(), 0);
  await idle.unmount();
  // the answer comes after the step closed
  let release: (v: string | null) => void = () => undefined;
  answer = () => new Promise((r) => (release = r));
  const v = await render(h(Poll, { kind: 'codex', active: true }));
  await v.unmount();
  await act(async () => release('/bin/codex:1:1'));
  await settle();
  assert.equal(calls.filter((c) => c[0] === 'recheck').length, 0);
  // main can't answer, or the harness can't be looked for: noted
  calls.length = 0;
  answer = async () => {
    throw new Error('no main');
  };
  const w = await render(h(Poll, { kind: 'claude', active: true }));
  await settle();
  await w.unmount();
  answer = async () => '/bin/claude:1:1';
  recheck = async () => {
    throw new Error('probe failed');
  };
  const x = await render(h(Poll, { kind: 'claude', active: true }));
  await settle();
  await x.unmount();
  recheck = async () => undefined;
  assert.deepEqual(
    calls.filter((c) => c[0] === 'ignored').map((c) => c[1]),
    ['ask whether claude is installed yet', 'look for claude once its binary showed up'],
  );
});

test('useAfter turns true once its wait has held, and false again when it stops holding', async () => {
  let seen: boolean[] = [];
  const After = ({ active }: { active: boolean }) => (seen.push(useAfter(20, active)), null);
  const v = await render(h(After, { active: true }));
  assert.equal(seen.at(-1), false);
  await act(async () => new Promise((r) => setTimeout(r, 40)));
  assert.equal(seen.at(-1), true);
  await v.rerender(h(After, { active: false }));
  assert.equal(seen.at(-1), false);
  seen = [];
  await act(async () => new Promise((r) => setTimeout(r, 40)));
  assert.ok(
    seen.every((x) => !x),
    'an inactive wait never runs out',
  );
  await v.unmount();
});

test("a run's elapsed time ticks from its start, and is 0 without one; it reads as m:ss", async () => {
  let seen: number[] = [];
  const Elapsed = ({ since }: { since: number | null }) => (seen.push(useElapsed(since)), null);
  const v = await render(h(Elapsed, { since: Date.now() - 65_000 }));
  assert.ok(seen.at(-1)! >= 65 && seen.at(-1)! < 67);
  await v.rerender(h(Elapsed, { since: null }));
  assert.equal(seen.at(-1), 0);
  // a clock a little ahead of this one never reads as negative
  await v.rerender(h(Elapsed, { since: Date.now() + 5000 }));
  assert.equal(seen.at(-1), 0);
  await v.unmount();
  seen = [];
  assert.deepEqual([clockText(0), clockText(7), clockText(92), clockText(600)], ['0:00', '0:07', '1:32', '10:00']);
});

test('the launch says what it is looking for, and is capped only while it looks', async () => {
  const v = await render(h(ColdStart));
  assert.equal(v.host.querySelector('[role=status]')!.textContent, 'Looking for your coding agents…');
  assert.ok(v.host.querySelector('.center-fill.welcome-cold'));
  await v.unmount();
  let capped: boolean[] = [];
  const Cap = ({ checking }: { checking: boolean }) => (capped.push(useColdStartCapped(checking)), null);
  const w = await render(h(Cap, { checking: true }));
  assert.equal(capped.at(-1), false, 'not before its 10 s');
  await w.rerender(h(Cap, { checking: false }));
  assert.equal(capped.at(-1), false);
  await w.unmount();
  capped = [];
});
