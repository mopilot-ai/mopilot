// src/components/thread/SessionWork.tsx: under a worktree session's live card, git's facts (lines, files, commits,
// uncommitted files, its PR) and, once it is not working and has commits, "Merge into <branch>" and "Open PR"; what a
// merge or PR that didn't go through came to is said there, a failure is a toast.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { render, click, flush } from './support/pages-kit.ts';
import { installNativeStub } from './support/ports/native.ts';
import { stubStore } from './support/stubs.ts';

const { createElement: h } = await import('react');
const calls: any[] = [];
let answer: any = { status: 'merged', into: 'main', commit: 'abc' };
let fail: Error | null = null;
stubStore({ toast: (...a: any[]) => calls.push(['toast', ...a]) });
installNativeStub({
  session: { snapshot: async (id: string) => (calls.push(['snapshot', id]), null) },
  shell: {
    openExternal: async (u: string) => {
      calls.push(['open', u]);
      if (u.includes('broken')) throw new Error('no browser');
    },
  },
  orchestration: {
    child: async (id: string, action: string) => {
      calls.push(['child', id, action]);
      if (fail) throw fail;
      return answer;
    },
  },
});
const { SessionWork, factsLine, workNote } = await import('../src/components/thread/SessionWork.tsx');

const facts = { branch: 'kid', base: 'main', ahead: 2, files: 3, added: 120, removed: 14, uncommitted: 0, pr: null, at: 1 };
const linked = (o: any = {}) => ({
  parentId: 'top',
  name: 'kid',
  title: 'Fix',
  harness: null,
  useWorktree: true,
  createdAt: 1,
  lastReport: null,
  facts,
  merged: null,
  ...o,
});
const text = (el: Element | null) => el?.textContent ?? '';
const buttons = (host: Element) => [...host.querySelectorAll('button')] as HTMLButtonElement[];

test('merge waits for the parent turn while PR remains available, then becomes usable', async () => {
  calls.length = 0;
  const props = { chatId: 'kid', parentTurn: 'idle', linked: linked(), settled: true };
  const v = await render(h(SessionWork, { ...props, parentTurn: 'running' }));
  assert.equal(buttons(v.host)[0].disabled, true);
  assert.match(v.host.textContent ?? '', /Wait until this chat is idle/);
  assert.equal(buttons(v.host)[1].disabled, false);
  await v.rerender(h(SessionWork, { ...props, parentTurn: null }));
  assert.equal(buttons(v.host)[0].disabled, true);
  assert.match(v.host.textContent ?? '', /Checking this chat’s status/);
  await click(buttons(v.host)[2]);
  assert.deepEqual(calls.splice(0), [['snapshot', 'top']]);
  await v.rerender(h(SessionWork, { ...props, parentTurn: 'awaitingUser' }));
  assert.equal(buttons(v.host)[0].disabled, true);
  await v.rerender(h(SessionWork, { ...props, parentTurn: 'crashed' }));
  assert.equal(buttons(v.host)[0].disabled, true);
  await v.rerender(h(SessionWork, { ...props, parentTurn: 'idle' }));
  assert.equal(buttons(v.host)[0].disabled, false);
  await click(buttons(v.host)[0]);
  assert.deepEqual(calls.splice(0), [['child', 'kid', 'merge']]);
  await v.unmount();
});

test('the facts as one line, and what an action that did not go through came to', () => {
  assert.equal(factsLine(facts), '+120 −14 · 3 files · 2 commits');
  assert.equal(factsLine({ ...facts, files: 1, ahead: 1, uncommitted: 2 }), '+120 −14 · 1 file · 1 commit · 2 uncommitted');
  assert.equal(
    workNote({ status: 'conflicts', into: 'main', files: ['a.ts', 'b.ts'] }),
    'Conflicts with main in a.ts, b.ts: merge it yourself, or ask the session to.',
  );
  assert.equal(
    workNote({ status: 'refused', reason: 'parent_dirty', message: 'main has uncommitted changes' }),
    'main has uncommitted changes',
  );
  assert.equal(workNote({ status: 'merged', into: 'main', commit: 'c' }), null);
  assert.equal(workNote({ status: 'opened' }), null);
});

test('a settled session with commits offers Merge and Open PR; their outcomes are said under the card', async () => {
  calls.length = 0;
  const v = await render(h(SessionWork, { chatId: 'kid', parentTurn: 'idle', linked: linked(), settled: true }));
  assert.equal(text(v.host.querySelector('.session-work-facts')), '+120 −14 · 3 files · 2 commits');
  assert.deepEqual(
    buttons(v.host).map((b) => b.textContent),
    ['Merge into main', 'Open PR'],
  );
  answer = { status: 'conflicts', into: 'main', files: ['a.ts'] };
  await click(buttons(v.host)[0]);
  await flush();
  assert.match(text(v.host.querySelector('.session-work-note')), /Conflicts with main in a\.ts/);
  answer = { status: 'opened' };
  await click(buttons(v.host)[1]);
  await flush();
  assert.equal(v.host.querySelector('.session-work-note'), null);
  fail = new Error('main gone');
  await click(buttons(v.host)[0]);
  await flush();
  fail = null;
  assert.deepEqual(calls.splice(0), [
    ['child', 'kid', 'merge'],
    ['child', 'kid', 'pr'],
    ['child', 'kid', 'merge'],
    ['toast', 'main gone', 'error'],
  ]);
  await v.unmount();
});

test('no actions while it works, with nothing ahead, or once merged; its PR is a link instead of Open PR', async () => {
  for (const [props, why] of [
    [{ linked: linked(), settled: false }, 'working'],
    [{ linked: linked({ facts: { ...facts, ahead: 0 } }), settled: true }, 'nothing ahead'],
    [{ linked: linked({ merged: { into: 'main', commit: 'abc', at: 2 } }), settled: true }, 'merged'],
  ] as const) {
    const v = await render(h(SessionWork, { chatId: 'kid', parentTurn: 'idle', ...props }));
    assert.equal(v.host.querySelector('.session-work-actions'), null, why);
    await v.unmount();
  }
  const merged = await render(
    h(SessionWork, {
      chatId: 'kid',
      parentTurn: 'idle',
      linked: linked({ merged: { into: 'main', commit: 'abc', at: 2 } }),
      settled: true,
    }),
  );
  assert.equal(text(merged.host.querySelector('.session-work-merged')), 'Merged into main (abc)');
  await merged.unmount();
  calls.length = 0;
  const withPr = await render(
    h(SessionWork, {
      chatId: 'kid',
      parentTurn: 'idle',
      linked: linked({ facts: { ...facts, pr: { number: 7, state: 'OPEN', url: 'https://x/7' } } }),
      settled: true,
    }),
  );
  assert.deepEqual(
    buttons(withPr.host).map((b) => b.textContent),
    ['PR #7 · open', 'Merge into main'],
  );
  await click(buttons(withPr.host)[0]);
  assert.deepEqual(calls.splice(0), [['open', 'https://x/7']]);
  await withPr.unmount();
  const broken = await render(
    h(SessionWork, {
      chatId: 'kid',
      parentTurn: 'idle',
      linked: linked({ facts: { ...facts, pr: { number: 8, state: 'MERGED', url: 'https://broken/8' } } }),
      settled: true,
    }),
  );
  await click(buttons(broken.host)[0]);
  await flush();
  assert.deepEqual(calls.splice(0), [
    ['open', 'https://broken/8'],
    ['toast', 'no browser', 'error'],
  ]);
  await broken.unmount();
  const none = await render(h(SessionWork, { chatId: 'kid', parentTurn: 'idle', linked: linked({ facts: null }), settled: true }));
  assert.equal(none.host.innerHTML, '');
  await none.unmount();
});
