// A real Composer and a sent UserMessage for the rewind tests: Edit message rewinds the turn (runSemantic answers when
// the test lets it) and returns the message, with its quote, to the chat's draft.
import { mock } from 'node:test';
import assert from 'node:assert/strict';
import './dom.ts';

let pending: Promise<any>;
mock.module('../../src/store/session/runSemantic.ts', {
  namedExports: { runSemantic: () => pending, refusalText: () => 'refused', fillTemplate: () => '' },
});
const { act, createElement: h, createContext } = await import('react');
const { mount, click, mockTsx } = await import('./composer-kit.ts');
const { mountComposer, reset, store } = await import('./composer-setup.ts');
const stub = (path: string, exports: Record<string, any>) => mockTsx(new URL('../../src/' + path, import.meta.url), exports);
const passthrough = ({ children }: any) => children;
stub('components/markdown/SkillLink.tsx', { SkillLink: passthrough });
stub('components/thread/view/sentSkill.ts', { useSentSkill: () => null });
stub('components/ui/ImageLightbox.tsx', { ZoomableImage: () => null });
stub('components/thread/QuestionReplyBubble.tsx', { QuestionReplyBubble: passthrough });
// These tests rewind ordinary user input; linked delivery cards have their own full UI contract matrix.
stub('components/thread/SideSessionCard.tsx', { SideSessionCard: () => null });
stub('components/composer/SelectionChip.tsx', { SelectionChip: () => null });
stub('components/ui/Popover.tsx', { Tooltip: passthrough });
stub('components/markdown/MessagePathLink.tsx', { FileMentionLink: ({ token }: any) => token });
stub('components/thread/PeerMessages.tsx', { PeerContext: createContext([]) });
stub('components/diff/DiffComments.tsx', { linesLabel: () => '' });
const { UserMessage } = await import('../../src/components/thread/view/UserMessage.tsx');
const { withSelections } = await import('../../shared/selections.mjs');

export { act, reset, store };

/** The origin chat's Composer with a draft, and its sent message 'edit me' (quoting 'quote') with Edit pressed. */
export async function startRewind() {
  let resolve!: (value: any) => void;
  pending = new Promise((r) => {
    resolve = r;
  });
  store.set({ drafts: { origin: { text: 'draft', attachments: [] } } });
  const composer = await mountComposer({ threadId: 'origin' });
  const view = await mount(
    h(UserMessage, {
      threadId: 'origin',
      turnId: 'turn',
      userIndex: 0,
      canEdit: true,
      item: { type: 'userMessage', id: 'message', content: [{ type: 'text', text: withSelections('edit me', ['quote']) }] },
    } as any),
  );
  await click(view.host.querySelector('[aria-label="Edit message"]'));
  /** Answers the rewind: it succeeded. */
  const rewound = () => resolve({ ok: true, value: true });
  return { composer, view, rewound };
}

/** The origin chat's draft got the message back exactly once: its text after the draft, and its quote. */
export function assertOriginRestored() {
  assert.equal(store.get().drafts.origin.text, 'draft\nedit me');
  assert.deepEqual(
    store.get().drafts.origin.attachments.map((a: any) => a.text),
    ['quote'],
  );
}
