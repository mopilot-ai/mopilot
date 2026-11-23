// Renderer family archive follows authoritative main events; delayed receipts never archive a newly restored chat.
import './support/dom.ts';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadStore, impl, resetAll, flush, callsOf } from './support/store-harness.ts';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { ArchiveFamilyDialog } from '../src/components/dialogs/ArchiveFamilyDialog.tsx';
import { cancelArchiveFamilyChoices } from '../src/lib/archiveFamilyChoice.ts';
import { deferred } from './support/async-scenarios.ts';
const { store, resetState } = await loadStore();
const { archiveWithFamily } = await import('../src/store/familyArchive.ts');
const empty = { children: {}, deliveries: {}, proposals: {}, queue: [], plans: {}, wrapUps: {} };
beforeEach(() => {
  cancelArchiveFamilyChoices();
  resetAll();
  resetState();
  store.useStore.setState({ threads: { top: { id: 'top', name: 'Parent', updatedAt: 1 } as any } });
});

test('ordinary chats use their own archive; former roots and detached children retain main lifecycle', async () => {
  for (const view of [
    empty,
    { ...empty, children: { child: { parentId: 'top', detached: true } } },
    { ...empty, families: ['top'] },
    { ...empty, children: { top: { parentId: 'old', detached: true } } },
  ]) {
    impl['orchestration.snapshot'] = async () => view;
    impl['orchestration.archiveFamily'] = async () => ({ archived: [], remaining: [], needsChoice: false });
    let single = 0;
    await archiveWithFamily('top', async () => {
      single++;
    });
    assert.equal(single, view === empty || 'child' in view.children ? 1 : 0);
  }
});

test('a family choice scopes the second call to exactly the shown children; cancellation sends nothing', async () => {
  for (const choice of ['all', 'parent', null]) {
    impl['orchestration.snapshot'] = async () => ({ ...empty, children: { child: { parentId: 'top' } } });
    let calls = 0;
    impl['orchestration.archiveFamily'] = async () =>
      ++calls === 1
        ? { archived: [], remaining: ['child'], working: 1, needsChoice: true }
        : { archived: ['top', 'child'], remaining: [], needsChoice: false };
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    let pending!: Promise<void>;
    try {
      await act(async () => {
        root.render(createElement(ArchiveFamilyDialog));
        pending = archiveWithFamily('top', async () => assert.fail('family bypassed'));
        await flush();
      });
      const label = choice === 'all' ? 'Archive 2 sessions' : choice === 'parent' ? 'Archive this session' : 'Cancel';
      const button = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === label) as HTMLButtonElement;
      assert.ok(button, label);
      await act(async () => {
        button.click();
        await pending;
      });
      assert.equal(calls, choice ? 2 : 1);
      if (choice) assert.deepEqual(callsOf('orchestration.archiveFamily').at(-1), ['top', choice, ['child']]);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  }
});

test('a delayed archive receipt never restamps a restored chat, while current archive events produce a toast', async () => {
  impl['orchestration.snapshot'] = async () => ({ ...empty, families: ['top'] });
  const reply = deferred<any>();
  impl['orchestration.archiveFamily'] = () => reply.promise;
  const pending = archiveWithFamily('top', async () => assert.fail('family bypassed'));
  await flush();
  store.useStore.setState({ claudeArchived: {} });
  reply.resolve({ archived: ['top'], remaining: [], needsChoice: false });
  await pending;
  assert.equal(store.useStore.getState().claudeArchived.top, undefined);
  assert.equal(store.useStore.getState().threads.top?.id, 'top');
  store.useStore.setState({ claudeArchived: { top: 1, child: 1 } });
  impl['orchestration.archiveFamily'] = async () => ({ archived: ['top', 'child'], remaining: [], needsChoice: false });
  await archiveWithFamily('top', async () => assert.fail('family bypassed'));
  impl['orchestration.archiveFamily'] = async () => ({ archived: ['top'], remaining: [], needsChoice: false });
  await archiveWithFamily('top', async () => assert.fail('family bypassed'));
});
