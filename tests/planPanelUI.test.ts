// Plan pane reading and repeated line comments retain their originating snapshot and chat draft.
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h, useState, useRef } from 'react';
import {
  mockStore,
  autoMock,
  stubComponent,
  render,
  resetStore,
  setStore,
  useStore,
  settle,
  key,
  impl,
  callsTo,
  window,
} from './support/thread-kit.ts';

mockStore({ setDraft: (id: string, draft: unknown) => setStore((s: any) => ({ drafts: { ...s.drafts, [id]: draft } })) });
autoMock('src/components/markdown/Markdown.tsx', 'md', { Markdown: stubComponent('Markdown') });
autoMock('src/components/ui/Dictation.tsx', 'dictation', { Dictation: () => null });
autoMock('src/session/open.ts', 'open');
autoMock('src/store/plans/pane.ts', 'plans');
const { useSessions } = await import('../src/store/session/useSession.ts');
const { EMPTY_SESSION } = await import('../src/store/session/sessionState.ts');
const { PlanCard } = await import('../src/components/thread/PlanCard.tsx');
const { PlanPanel } = await import('../src/components/panels/PlanPanel.tsx');
const proposal = (id: string, text: string, extra = {}) => ({ id, status: 'completed', items: [{ type: 'plan', id, text, ...extra }] });
const history = (id: string, text: string, extra = {}) => ({ a: { turns: [proposal(id, text, extra)] } });
const panel = (threadId = 'a', itemId?: string) => h(PlanPanel, { threadId, plan: itemId ? { turnId: 'old', itemId } : undefined });
const button = (host: HTMLElement, text: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent === text || b.getAttribute('aria-label') === text)!;
const click = (host: HTMLElement, text: string) => settle(() => button(host, text).click());
const type = (host: HTMLElement, text: string) =>
  settle(() => {
    const field = host.querySelector('input')!;
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(field, text);
    field.dispatchEvent(new window.Event('input', { bubbles: true }) as any);
  });
const attachments = (chat = 'a') => useStore.getState().drafts[chat]?.attachments ?? [];

beforeEach(() => {
  resetStore({ threads: { a: { cwd: '/a' }, b: { cwd: '/b' } }, runtime: history('p1', '# Proposal\n\nBuild carefully') });
  useSessions.setState({ sessions: { a: { ...EMPTY_SESSION, rev: 1 }, b: { ...EMPTY_SESSION, rev: 1 } } });
  impl['store:chatOf'] = (id: string) => id;
});

test('default and unavailable historical states explain what belongs in the pane', async () => {
  await settle(() => setStore({ runtime: {} }));
  const v = await render(panel());
  assert.match(v.host.textContent!, /No plan has been proposed/);
  await v.rerender(panel('a', 'gone'));
  assert.match(v.host.textContent!, /no longer in the loaded conversation/);
  await v.rerender(panel('missing-chat'));
  assert.match(v.host.textContent!, /No plan has been proposed/);
});

test('the Plan pane shows native checklist steps, including historical progress when a newer message has arrived', async () => {
  const checklist = {
    id: 'checklist',
    status: 'completed',
    items: [],
    plan: {
      steps: [
        { step: 'Read', status: 'completed' },
        { step: 'Write', status: 'inProgress' },
      ],
    },
  };
  const next = {
    id: 'next',
    status: 'inProgress',
    items: [{ id: 'u', type: 'userMessage', content: [{ type: 'text', text: 'follow up' }] }],
  };
  await settle(() => setStore({ runtime: { a: { turns: [checklist, next], activeTurnId: 'next' } } }));
  const r = await render(panel());
  assert.match(r.host.textContent!, /Plan from before your last message/);
  assert.deepEqual(
    r.$$('.todo-step').map((li) => li.textContent),
    ['Read', 'Write'],
  );
  await settle(() => setStore({ runtime: { a: { turns: [checklist, { ...next, plan: checklist.plan }], activeTurnId: 'next' } } }));
  assert.doesNotMatch(r.host.textContent!, /Plan from before your last message/);
  assert.deepEqual(
    r.$$('.todo-step').map((li) => li.textContent),
    ['Read', 'Write'],
  );
  await r.rerender(panel('a', 'missing-proposal'));
  assert.match(r.host.textContent!, /no longer in the loaded conversation/);
  await r.unmount();
});

test('read mode shows the plan and opens its file; source mode numbers lines and disables blank comments', async () => {
  await settle(() => setStore({ runtime: history('p1', '# Proposal\n\nBuild carefully', { planFilePath: '/a/plan.md' }) }));
  const v = await render(panel());
  assert.equal(v.$('[data-stub="Markdown"]')?.dataset.text, '# Proposal\n\nBuild carefully');
  await click(v.host, 'plan.md');
  assert.equal(callsTo('open:openMessageLink').at(-1)?.[0], '/a/plan.md');
  await click(v.host, 'Comment on lines');
  assert.equal(v.$$('.plan-source-line').length, 3);
  assert.equal((button(v.host, 'Comment on plan line 2') as HTMLButtonElement).disabled, true);
  await click(v.host, 'Read plan');
  assert.ok(v.$('[data-stub="Markdown"]'));
});

test('the default pane keeps a newer checklist alongside an older proposal, while explicit links open the proposal', async () => {
  const old = proposal('old', 'Earlier proposal');
  const current = {
    ...proposal('current', ''),
    items: [],
    plan: { steps: [{ step: 'Verify the new change', status: 'pending' }] },
  };
  await settle(() => setStore({ runtime: { a: { turns: [old, current] } } }));
  const r = await render(panel());
  assert.equal(r.$('.todo-step')?.textContent, 'Verify the new change');
  assert.equal(r.$('[data-stub="Markdown"]')?.dataset.text, 'Earlier proposal');
  await r.rerender(panel('a', 'old'));
  assert.equal(r.$('.todo-step'), null);
  assert.equal(r.$('[data-stub="Markdown"]')?.dataset.text, 'Earlier proposal');
  await r.unmount();
});

test('typing is retained before Done, Enter or Escape; repeated comments keep independent quotes and ids', async () => {
  const v = await render(panel());
  await click(v.host, 'Comment on lines');
  await click(v.host, 'Comment on plan line 1');
  await type(v.host, 'Keep this small');
  assert.equal(attachments()[0].annotation, 'Keep this small');
  assert.match(attachments()[0].text, /Plan \(p1\), line 1:\n# Proposal/);
  await key(v.$('input')!, 'keydown', { key: 'Escape' });
  assert.equal(v.$('input'), null);
  await click(v.host, 'Comment on plan line 3');
  await type(v.host, ' add tests ');
  await settle(() => v.$('form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }) as any));
  assert.equal(v.$('input'), null);
  assert.equal(attachments()[1].annotation, 'add tests');
  assert.notEqual(attachments()[0].annotationId, attachments()[1].annotationId);
  await click(v.host, 'Comment on plan line 1');
  await type(v.host, 'Third');
  await click(v.host, 'Done');
  assert.equal(attachments().length, 3);
  assert.equal(attachments()[2].annotation, 'Third');
  assert.equal(callsTo('store:sendMessage').length, 0);
  assert.equal(callsTo('store:resolveRequest').length, 0);
});

test('a plan comment is deleted from its own editor, as Codex deletes a comment', async () => {
  const v = await render(panel());
  await click(v.host, 'Comment on lines');
  await click(v.host, 'Comment on plan line 1');
  await click(v.host, 'Comment on plan line 3');
  await type(v.host, 'drop me');
  await click(v.host, 'Delete annotation');
  assert.equal(v.$('input'), null, 'the editor closes');
  assert.equal(attachments().length, 1, 'only the deleted comment leaves the draft');
  assert.match(attachments()[0].text, /line 1:/);
});

test('updated and replacement plans do not retarget a typed comment; navigation retains the originating chat', async () => {
  const v = await render(panel());
  await click(v.host, 'Comment on lines');
  await click(v.host, 'Comment on plan line 3');
  await type(v.host, 'Original snapshot');
  await settle(() => setStore({ runtime: history('p1', 'Changed plan') }));
  assert.match(v.$('blockquote')!.textContent!, /Build carefully/);
  await type(v.host, 'Still original');
  await settle(() => setStore({ runtime: history('p2', 'Replacement') }));
  assert.equal(v.$('input'), null);
  assert.equal(attachments()[0].annotation, 'Still original');
  await v.rerender(panel('b'));
  assert.equal(attachments('b').length, 0);
  assert.match(attachments()[0].text, /p1/);
});

test('a proposal without text waits, then follows pending permission text before approval', async () => {
  await settle(() => setStore({ runtime: { a: { ...history('p1', '').a, activeTurnId: 'p1' } } }));
  const v = await render(panel());
  assert.match(v.host.textContent!, /Waiting for the plan text/);
  await settle(() =>
    useSessions.setState({
      sessions: {
        a: {
          ...EMPTY_SESSION,
          rev: 1,
          approvals: [
            {
              id: 'ask',
              method: 'claude/permission',
              params: { toolName: 'ExitPlanMode', toolUseID: 'p1', input: { plan: 'Read before approving' } },
            },
          ] as any,
        },
      },
    }),
  );
  assert.equal(v.$('[data-stub="Markdown"]')?.dataset.text, 'Read before approving');
});

test('Open plan on a card routes its exact proposal to its own chat, on every harness', async () => {
  for (const threadId of ['codex', 'claude', 'acp']) {
    const v = await render(h(PlanCard, { item: { id: 'historical', text: 'Proposal' }, threadId, turnId: 'turn', cwd: '/repo' }));
    await click(v.host, 'Open plan');
    assert.deepEqual(callsTo('plans:openPlanPane').at(-1), [threadId, { turnId: 'turn', itemId: 'historical' }]);
    await v.unmount();
  }
  const v = await render(h(PlanCard, { item: { text: 'Unidentified proposal' }, threadId: 'a', turnId: 't', cwd: '/repo' }));
  await click(v.host, 'Open plan');
  assert.deepEqual(callsTo('plans:openPlanPane').at(-1), ['a', undefined]);
  await v.rerender(h(PlanCard, { item: { id: 'p', text: 'No turn identity' }, threadId: 'a', cwd: '/repo' }));
  await click(v.host, 'Open plan');
  assert.deepEqual(callsTo('plans:openPlanPane').at(-1), ['a', undefined]);
});

test('a retained quote without annotation text remains an empty writable comment', async () => {
  const v = await render(panel());
  await click(v.host, 'Comment on lines');
  await click(v.host, 'Comment on plan line 1');
  await settle(() =>
    setStore((s: any) => ({
      drafts: { ...s.drafts, a: { ...s.drafts.a, attachments: attachments().map((a: any) => ({ ...a, annotation: undefined })) } },
    })),
  );
  assert.equal((v.$('input') as HTMLInputElement).value, '');
  await type(v.host, 'Kept with its quote');
  assert.equal(attachments()[0].annotation, 'Kept with its quote');
});

test('ordinary replies offer an explicit fallback instead of silently being treated as proposals', async () => {
  await settle(() =>
    setStore({
      runtime: {
        a: { turns: [{ id: 'reply-turn', status: 'completed', items: [{ id: 'reply', type: 'agentMessage', text: 'Proposed steps' }] }] },
      },
    }),
  );
  const v = await render(panel());
  await click(v.host, 'Use latest reply as plan');
  assert.deepEqual(callsTo('plans:openPlanPane').at(-1), ['a', { turnId: 'reply-turn', itemId: 'reply', source: 'reply' }]);
  await v.rerender(h(PlanPanel, { threadId: 'a', plan: { turnId: 'reply-turn', itemId: 'reply', source: 'reply' } }));
  assert.equal(v.$('[data-stub="Markdown"]')?.dataset.text, 'Proposed steps');
});

const { useSelectionAttachments } = await import('../src/components/composer/useSelectionAttachments.ts');
const { useComposerDraft } = await import('../src/components/composer/useComposerDraft.ts');
const saveDraft = (id: string, draft: unknown) => setStore((s: any) => ({ drafts: { ...s.drafts, [id]: draft } }));
function DraftComposer() {
  const [items, setItems] = useState<any[]>(useStore.getState().drafts.a?.attachments ?? []);
  const input = useRef(null);
  useSelectionAttachments('a', setItems, input);
  useComposerDraft('a', '', items, saveDraft);
  return h(
    'div',
    null,
    h('button', { onClick: () => setItems([]) }, 'Remove annotation'),
    h(
      'button',
      {
        onClick: () => {
          setItems([]);
          saveDraft('a', { text: '', attachments: [] });
        },
      },
      'Send draft',
    ),
    h(
      'button',
      { onClick: () => setItems((all) => all.map((a) => ({ ...a, annotation: 'Edited in composer' }))) },
      'Edit annotation elsewhere',
    ),
  );
}
for (const action of ['Remove annotation', 'Send draft'])
  test(`a live composer can ${action.toLowerCase()} and retires the Plan editor`, async () => {
    const v = await render(h('div', null, panel(), h(DraftComposer)));
    await click(v.host, 'Comment on lines');
    await click(v.host, 'Comment on plan line 1');
    await type(v.host, 'Owned comment');
    assert.equal(attachments()[0].annotation, 'Owned comment');
    await click(v.host, 'Edit annotation elsewhere');
    assert.equal((v.$('input') as HTMLInputElement).value, 'Edited in composer');
    await click(v.host, action);
    assert.equal(v.$('input'), null);
    assert.equal(attachments().length, 0);
    await click(v.host, 'Comment on plan line 3');
    await type(v.host, 'New owned comment');
    assert.equal(attachments().length, 1);
    assert.equal(attachments()[0].annotation, 'New owned comment');
  });
