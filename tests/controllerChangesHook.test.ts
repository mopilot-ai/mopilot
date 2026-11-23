// The switch sheet's control lines hook (src/harness/controllerChanges.ts): asks main what a switch would change about
// who controls each surface, for the chat and target the sheet shows; an answer for a sheet already closed is dropped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { window } from './support/dom.ts';
import { createElement as h, act } from 'react';
import { installNativeStub } from './support/ports/native.ts';

const asked: string[][] = [];
const answers = new Map<string, { resolve: (l: string[]) => void; reject: (e: unknown) => void }>();
installNativeStub({
  session: {
    controllerChanges: (chatId: string, harness: string) =>
      new Promise<string[]>((resolve, reject) => {
        asked.push([chatId, harness]);
        answers.set(`${chatId}→${harness}`, { resolve, reject });
      }),
  },
});
const { createRoot } = await import('react-dom/client');
const { useControllerChanges } = await import('../src/harness/controllerChanges.ts');

function Lines({ chatId, target }: { chatId: string; target: string }) {
  const lines = useControllerChanges(chatId, target);
  return h('ul', null, ...lines.map((l) => h('li', { key: l }, l)));
}

test("the sheet's lines come from main for its chat and target; a late answer for another target or a failed read shows none", async () => {
  const el = window.document.createElement('div');
  const root = createRoot(el as any);
  await act(async () => root.render(h(Lines, { chatId: 'c1', target: 'codex' })));
  assert.equal(el.textContent, '', 'nothing until main answers');
  // the user picks another target before main answered: the first answer arriving late is dropped
  await act(async () => root.render(h(Lines, { chatId: 'c1', target: 'claude' })));
  await act(async () => answers.get('c1→codex')!.resolve(['stale']));
  assert.equal(el.textContent, '');
  await act(async () => answers.get('c1→claude')!.resolve(['After the switch, your Chrome is controlled by Claude in Chrome.']));
  assert.equal(el.textContent, 'After the switch, your Chrome is controlled by Claude in Chrome.');
  // another chat: the previous lines go at once, and a read that fails shows none; the sheet still switches
  await act(async () => root.render(h(Lines, { chatId: 'c2', target: 'codex' })));
  assert.equal(el.textContent, '', "the other chat's lines are not shown while main answers");
  await act(async () => answers.get('c2→codex')!.reject(new Error('no plan')));
  assert.equal(el.textContent, '');
  assert.deepEqual(asked, [
    ['c1', 'codex'],
    ['c1', 'claude'],
    ['c2', 'codex'],
  ]);
  await act(async () => root.unmount());
});
