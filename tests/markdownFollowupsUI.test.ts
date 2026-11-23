// Markdown follow-ups target their owning chat; global previews deliberately retain the focused-composer shortcut.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { mockStore, autoMock, stubComponent, render, settle, resetStore, callsTo, moduleCalls, window } from './support/thread-kit.ts';

mockStore();
autoMock('src/session/open.ts', 'open');
autoMock('src/lib/highlight.ts', 'hl');
autoMock('src/components/ui/ImageLightbox.tsx', 'img', { ZoomableImage: stubComponent('ZoomableImage') });
autoMock('src/components/markdown/SkillLink.tsx', 'skill', { SkillLink: stubComponent('SkillLink') });
autoMock('src/components/markdown/Visualization.tsx', 'viz', { Visualization: stubComponent('Visualization') });
const { Markdown } = await import('../src/components/markdown/Markdown.tsx');
const { AgentChatContext } = await import('../src/components/agents/AgentChatContext.ts');
beforeEach(() => {
  resetStore();
  moduleCalls.length = 0;
});

test('global preview suggestions put their prompt or label in the focused composer', async () => {
  const sent: unknown[] = [];
  const on = (e: any) => sent.push(e.detail);
  window.addEventListener('composer-insert', on);
  const v = await render(
    h(Markdown, {
      text: 'Done.\n\n:codex-followup[Run tests]{prompt="npm test"}\n:codex-followup[Only label]{}\n:codex-followup{prompt="just prompt"}',
    }),
  );
  try {
    const buttons = v.$$('.md-followup');
    assert.deepEqual(
      buttons.map((b) => b.textContent),
      ['Run tests', 'Only label', 'just prompt'],
    );
    assert.equal(buttons[0].title, 'npm test');
    for (const b of buttons) await settle(() => b.click());
    assert.deepEqual(sent, ['npm test', 'Only label', 'just prompt']);
    assert.deepEqual(callsTo('store:giveBackToComposer'), []);
  } finally {
    window.removeEventListener('composer-insert', on);
    await v.unmount();
  }
});

test('a side-chat or agent-report follow-up edits its owning chat even when another composer has focus', async () => {
  const sent: unknown[] = [];
  const on = (e: any) => sent.push(e.detail);
  window.addEventListener('composer-insert', on);
  const text = ':codex-followup[Run tests]{prompt="npm test"}';
  const owned = (id: string) => h(AgentChatContext.Provider, { value: id }, h(Markdown, { text }));
  const v = await render(owned('side-chat:opaque/id'));
  try {
    await settle(() => v.$('.md-followup')!.click());
    assert.deepEqual(callsTo('store:giveBackToComposer'), [['side-chat:opaque/id', 'npm test']]);
    assert.deepEqual(sent, [], 'a chat-owned edit must never emit the global focused-composer shortcut');
    // The Markdown props are unchanged: its context must still replace the memoized recipient.
    await v.rerender(owned('replacement-chat'));
    await settle(() => v.$('.md-followup')!.click());
    assert.deepEqual(callsTo('store:giveBackToComposer').at(-1), ['replacement-chat', 'npm test']);
  } finally {
    window.removeEventListener('composer-insert', on);
    await v.unmount();
  }
});
