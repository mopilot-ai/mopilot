// The Changes pane is memoized on its two props: a parent rendering again (a window, sidebar or pane resize) does not
// render the whole diff again (#2049).
import { test } from 'node:test';
import { Profiler } from 'react';
import assert from 'node:assert/strict';
import { store, h, act, DiffPanel, settle, render, git, DIFF } from './support/diff-panel-ui/fixture.ts';

test('a parent rendering again with the same cwd and chat does not render the Changes pane again', async () => {
  // every render of the pane reads its "last turn only" preference: count those reads
  let renders = 0;
  const prefs = new Proxy({}, { get: (_, key) => (key === 'changesLastTurnOnly' && renders++, undefined) });
  store.set({ diffPanel: { open: true, scope: 'uncommitted' }, runtime: {}, prefs, drafts: {} });
  const tree = (cwd: string, width: number) => h('div', { style: { width } }, h(DiffPanel, { cwd, threadId: 't1' }));
  const r = await render(tree('/repo', 600));
  await settle(act);
  assert.ok(r.host.querySelector('.cp-file'), 'the diff is shown');
  const before = renders;
  await r.rerender(tree('/repo', 700));
  await r.rerender(tree('/repo', 800));
  assert.equal(renders, before, 'new widths above it render nothing in it');
  await r.rerender(tree('/other', 800));
  assert.ok(renders > before, 'a new folder still renders it');
  await r.unmount();
});

test('a Git poll that reads the same diff renders nothing; a changed diff renders again', async () => {
  let renders = 0;
  const prefs = new Proxy({}, { get: (_, key) => (key === 'changesLastTurnOnly' && renders++, undefined) });
  store.set({ diffPanel: { open: true, scope: 'uncommitted' }, runtime: {}, prefs, drafts: {} });
  const r = await render(h(DiffPanel, { cwd: '/repo', threadId: 't1' }));
  await settle(act);
  const before = renders;
  const poll = async () => {
    await act(async () => window.dispatchEvent(new Event('focus')));
    await settle(act);
  };
  await poll();
  await poll();
  assert.equal(renders, before, 'the same diff read again keeps the pane as it is');
  git.diff = async () => DIFF.replace('+new', '+newer');
  await poll();
  assert.ok(renders > before, 'a changed diff is shown');
  assert.ok(r.host.querySelector('[data-path="src/a.ts"]'));
  await r.unmount();
});

test("a harness switch of the walk's chat re-renders its findings' harness mark, though the pane is memoized", async () => {
  const findings = [{ file: 'src/a.ts', line: 2, summary: 'new is wrong' }];
  const turns = [{ id: 't', status: 'completed', items: [{ id: 'r1', type: 'exitedReviewMode', review: '', level: 'high', findings }] }];
  store.exports.__harness = 'claude';
  store.set({
    diffPanel: { scope: 'uncommitted', walk: { chatId: 't1', reviewId: 'r1', current: 0, settled: true } },
    runtime: { t1: { turns } },
    prefs: {},
    drafts: {},
    reviewMarks: {},
  });
  const r = await render(h(DiffPanel, { cwd: '/repo', threadId: 't1' }));
  await settle(act, 60);
  const author = () => r.host.querySelector('.finding-annotation-author')!.textContent;
  assert.equal(author(), 'Claude');
  // the chat switches to Codex: main records a new segment, which no prop of the pane carries
  store.exports.__harness = 'codex';
  await act(async () => store.set({ segments: { t1: [{ harness: 'codex' }] } }));
  assert.equal(author(), 'Codex', 'the mark follows the switch');
  await r.unmount();
  store.exports.__harness = 'claude';
});

test('a streamed frame renders the Changes pane only in the last-turn scope', async () => {
  let renders = 0;
  const frame = (n: number) => ({
    t1: {
      activeTurnId: 'b',
      turns: [
        { id: 'a', status: 'completed', items: [{ n }] },
        { id: 'b', status: 'inProgress', items: [{ n }] },
      ],
    },
  });
  store.set({ diffPanel: { open: true, scope: 'uncommitted' }, runtime: frame(0), prefs: {}, drafts: {} });
  const r = await render(h(Profiler, { id: 'diff', onRender: () => void renders++ }, h(DiffPanel, { cwd: '/repo', threadId: 't1' })));
  await settle(act);
  const before = renders;
  for (let n = 1; n <= 10; n++) await act(async () => store.set({ runtime: frame(n) }));
  assert.equal(renders, before, 'before: one render per frame');
  // the last-turn scope reads the turns, so it follows them
  await act(async () => store.set({ diffPanel: { open: true, scope: 'turn' } }));
  await settle(act);
  const inTurn = renders;
  await act(async () => store.set({ runtime: frame(11) }));
  assert.ok(renders > inTurn, 'a frame renders the last-turn scope');
  await r.unmount();
});
