// Sent-message rewind returns input to its original draft after its message view retires.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadStore, resetAll, impl, native } from './support/store-harness.ts';
await import('./support/dom.ts');
(window as any).native = native;
const { act, createElement: h, createContext } = await import('react');
const { mount, click, mockTsx } = await import('./support/composer-kit.ts');
const { store: S, resetState } = await loadStore();
const stub = (path: string, exports: Record<string, any>) => mockTsx(new URL('../src/' + path, import.meta.url), exports);
const passthrough = ({ children }: any) => children;
stub('components/markdown/SkillLink.tsx', { SkillLink: passthrough });
stub('components/thread/view/sentSkill.ts', { useSentSkill: () => null });
stub('components/ui/ImageLightbox.tsx', { ZoomableImage: () => null });
stub('components/thread/QuestionReplyBubble.tsx', { QuestionReplyBubble: passthrough });
stub('components/composer/SelectionChip.tsx', { SelectionChip: () => null });
stub('components/ui/Popover.tsx', { Tooltip: passthrough });
stub('components/markdown/MessagePathLink.tsx', { FileMentionLink: ({ token }: any) => token });
stub('components/thread/PeerMessages.tsx', { PeerContext: createContext([]) });
stub('components/diff/DiffComments.tsx', { linesLabel: () => '' });
const { UserMessage } = await import('../src/components/thread/view/UserMessage.tsx');
const { withSelections } = await import('../shared/selections.mjs');
beforeEach(() => {
  resetState();
  resetAll();
});
async function begin(text = 'edit me') {
  let resolve!: (value: any) => void;
  let reject!: (error: Error) => void;
  impl['run.runSemantic'] = () =>
    new Promise((r, j) => {
      resolve = r;
      reject = j;
    });
  S.useStore.setState({
    drafts: { origin: { text: 'unsent draft', attachments: [], goal: true }, other: { text: 'other draft', attachments: [] } },
  } as any);
  const m = await mount(
    h(UserMessage, {
      threadId: 'origin',
      turnId: 'turn',
      userIndex: 0,
      canEdit: true,
      item: { type: 'userMessage', id: 'message', content: [{ type: 'text', text: withSelections(text, ['quote']) }] },
    } as any),
  );
  await click(m.host.querySelector('[aria-label="Edit message"]'));
  return { m, resolve, reject };
}
test('successful native rewind after view disposal retains text and selection in originating saved draft', async () => {
  const { m, resolve } = await begin();
  await m.unmount();
  await act(async () => resolve({ ok: true, value: true }));
  const draft = S.useStore.getState().drafts.origin;
  assert.equal(draft.text, 'unsent draft\nedit me');
  assert.deepEqual(
    draft.attachments.map((a) => a.text),
    ['quote'],
  );
  assert.equal(draft.goal, true);
  assert.equal(S.useStore.getState().drafts.other.text, 'other draft');
});

for (const result of [
  { ok: true, value: false },
  { ok: false, reason: 'unsupported' },
])
  test(`rewind without success leaves draft unchanged: ${JSON.stringify(result)}`, async () => {
    const { m, resolve } = await begin();
    await act(async () => resolve(result));
    assert.equal(S.useStore.getState().drafts.origin.text, 'unsent draft');
    assert.deepEqual(S.useStore.getState().drafts.origin.attachments, []);
    await m.unmount();
  });
test('rejected native rewind retains existing input without inventing successful recovery', async () => {
  const { m, reject } = await begin();
  await m.unmount();
  await act(async () => reject(new Error('rewind failed')));
  assert.equal(S.useStore.getState().toasts.at(-1)?.text, "Couldn't edit: rewind failed");
  assert.equal(S.useStore.getState().drafts.origin.text, 'unsent draft');
});
test('input written while native rewind is pending survives recovery', async () => {
  const { m, resolve } = await begin();
  await m.unmount();
  S.setDraft('origin', { text: 'latest draft', attachments: [{ kind: 'file', name: 'keep', path: '/keep' }], goal: true });
  await act(async () => resolve({ ok: true, value: true }));
  assert.equal(S.useStore.getState().drafts.origin.text, 'latest draft\nedit me');
  assert.deepEqual(
    S.useStore.getState().drafts.origin.attachments.map((a) => a.name),
    ['keep', 'Selection'],
  );
});

for (const reverse of [false, true])
  test(`independent accepted rewind deliveries combine once in completion order (reverse=${reverse})`, async () => {
    const first = await begin('first');
    const second = await begin('second');
    await first.m.unmount();
    await second.m.unmount();
    const ordered = reverse ? [second, first] : [first, second];
    for (const op of ordered) await act(async () => op.resolve({ ok: true, value: true }));
    assert.equal(S.useStore.getState().drafts.origin.text, reverse ? 'unsent draft\nsecond\nfirst' : 'unsent draft\nfirst\nsecond');
    assert.deepEqual(
      S.useStore.getState().drafts.origin.attachments.map((a) => a.text),
      ['quote', 'quote'],
    );
  });
