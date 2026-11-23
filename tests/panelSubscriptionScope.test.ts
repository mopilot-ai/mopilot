// The side panels read the narrow part of a chat's runtime they show, so a streamed frame (patchRuntime replaces
// runtime[id].turns) renders none of them: the shared links and the context panel's Compact.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mockStore, autoMock, impl, render, setStore, settle, resetStore } from './support/thread-kit.ts';

const { createElement: h } = await import('react');
mockStore();
autoMock('src/store/session/useCaps.ts', 'caps', { useChatCaps: () => ({ loaded: false }) });
const { SummarySources } = await import('../src/components/panels/SummarySources.tsx');
const { useCompact } = await import('../src/components/context/useCompact.ts');

const text = (t: string) => ({ id: `u-${t}`, type: 'userMessage', content: [{ type: 'text', text: t }] });
const frames = (n: number, items: unknown[] = []) => ({
  c: {
    activeTurnId: 't2',
    turns: [
      { id: 't1', status: 'completed', items },
      { id: 't2', status: 'inProgress', items: [{ id: 'm', type: 'agentMessage', text: `n${n}` }] },
    ],
  },
});

test('the shared links list ignores streamed frames and follows a new link', async () => {
  resetStore({ runtime: frames(0, [text('see https://example.com/a')]) });
  const v = await render(h(SummarySources, { threadId: 'c' }));
  assert.match(v.host.textContent!, /example\.com/);
  let commits = 0;
  const observer = new MutationObserver(() => void (commits += 1));
  observer.observe(v.host, { subtree: true, childList: true, characterData: true, attributes: true });
  for (let n = 1; n <= 20; n++) await settle(() => setStore({ runtime: frames(n, [text('see https://example.com/a')]) }));
  await settle();
  assert.equal(commits, 0, 'before: re-rendered per frame');
  await settle(() => setStore({ runtime: frames(21, [text('see https://example.com/a and https://other.dev/b')]) }));
  assert.match(v.host.textContent!, /other\.dev/);
  observer.disconnect();
  await v.unmount();
});

let renders = 0;
let compact: ReturnType<typeof useCompact>;
function CompactProbe({ running }: { running: boolean }) {
  renders += 1;
  compact = useCompact('c', running);
  return null;
}

test('Compact reads the last turn once asked, and a streamed frame renders nothing', async () => {
  resetStore({ runtime: frames(0) });
  const v = await render(h(CompactProbe, { running: true }));
  const before = renders;
  for (let n = 1; n <= 20; n++) await settle(() => setStore({ runtime: frames(n) }));
  assert.equal(renders - before, 0, 'before: one render per frame');
  assert.equal(compact.compacting, false);
  // asked: the turn that follows, running and only compacting, holds it
  impl['store:compactThread'] = async () => ({ action: 'started', id: 'compact' });
  await settle(() => compact.compact());
  const compacting = (turn: unknown) => settle(() => setStore({ runtime: { c: { activeTurnId: 't3', turns: [turn] } } }));
  await compacting({
    id: 't3',
    status: 'inProgress',
    items: [{ id: 'u', type: 'userMessage', content: [{ type: 'text', text: '/compact' }] }],
  });
  assert.equal(compact.compacting, true);
  await compacting({ id: 't3', status: 'inProgress', items: [text('real question')] });
  assert.equal(compact.compacting, false, 'a turn that is not a compaction ends it');
  await v.unmount();
});
