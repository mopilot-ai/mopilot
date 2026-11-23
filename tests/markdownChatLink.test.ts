// A link an agent writes to another chat in a message, [title](mopilot:chat/<id>) (electron/capabilities/contract/sessionsNote.cjs),
// renders as a pill that opens that chat (src/components/markdown/ChatLink.tsx, shared with the linked-session cards).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { mockStore, autoMock, stubComponent, render, settle, resetStore, impl, callsTo, nativeCalls } from './support/thread-kit.ts';

mockStore();
autoMock('src/session/open.ts', 'open');
autoMock('src/lib/highlight.ts', 'hl');
autoMock('src/components/ui/ImageLightbox.tsx', 'img', { ZoomableImage: stubComponent('ZoomableImage') });
autoMock('src/components/markdown/SkillLink.tsx', 'skill', { SkillLink: stubComponent('SkillLink') });
autoMock('src/components/markdown/Visualization.tsx', 'viz', { Visualization: stubComponent('Visualization') });
// the linked sessions the windows know (src/lib/sideSessions.ts): one child with its handle
autoMock('src/lib/sideSessions.ts', 'side', { useOrchestration: () => ({ children: { kid: { name: 'fix-login' } } }) });
const { Markdown } = await import('../src/components/markdown/Markdown.tsx');
const { chatIdFromHref } = await import('../src/lib/chatLink.ts');

const text = (el: Element | null | undefined) => el?.textContent ?? '';

test('a link to another chat is a pill that opens it, named by its title, else the link’s words, its handle or its id', async () => {
  resetStore({ threads: { known: { id: 'known', name: 'Known chat' } } });
  impl['store:threadTitle'] = (t: any) => t.name;
  const v = await render(
    h(Markdown, {
      text: '[Fix login](mopilot:chat/kid) [Old name](mopilot:chat/known) [](mopilot:chat/kid) [](mopilot:chat/ghost) [bad](mopilot:chat/../x)',
      cwd: '/repo',
    }),
  );
  const pills = v.$$('button.md-chat-link');
  assert.deepEqual(
    pills.map((p) => text(p)),
    ['Fix login', 'Known chat', 'fix-login', 'ghost'],
  );
  assert.ok(pills.every((p) => p.classList.contains('peer-chat-link')));
  // not a chat id: an ordinary link whose unsafe address is dropped
  const plain = v.$$('a').find((a) => text(a) === 'bad');
  assert.equal(plain?.getAttribute('href'), '');
  await settle(() => pills[1].click());
  assert.deepEqual(callsTo('store:navigate'), [[{ name: 'thread', id: 'known' }]]);
});

test('a chat pill in a message wraps a long title instead of cutting it off', async () => {
  const { readFile } = await import('node:fs/promises');
  const css = await readFile(new URL('../src/styles/app/markdown.css', import.meta.url), 'utf8');
  const rule = css.match(/\.md \.md-chat-link \{([^}]*)\}/)?.[1] ?? '';
  const decl = (prop: string) => rule.match(new RegExp(`(?:^|[\\s;])${prop}:\\s*([^;]+);`))?.[1].trim();
  // .peer-chat-link (cards) is one clipped line; the more specific .md rule must undo that
  assert.equal(decl('max-width'), '100%');
  assert.equal(decl('white-space'), 'normal');
  assert.equal(decl('overflow'), 'visible');
  assert.equal(decl('text-overflow'), 'clip');
  assert.equal(decl('overflow-wrap'), 'anywhere');
});

test('Cmd/Ctrl-clicking a repair link keeps every harness in the current window, including repeated clicks', async () => {
  for (const id of ['01a1fc49-7e0d-7623-b588-309b0df9f0f5', 'claude:repair', 'acp:opencode:repair']) {
    const v = await render(h(Markdown, { text: `[Red main issue #5330](mopilot:chat/${id})` }));
    const pill = v.$('button.md-chat-link')!;
    const before = callsTo('store:navigate').length;
    const windows = nativeCalls.filter((c) => c.path === 'native.win.open').length;
    for (const modifier of [{ metaKey: true }, { ctrlKey: true }, { metaKey: true }])
      await settle(() => pill.dispatchEvent(new MouseEvent('click', { bubbles: true, ...modifier })));
    assert.deepEqual(callsTo('store:navigate').slice(before), Array(3).fill([{ name: 'thread', id }]));
    assert.equal(nativeCalls.filter((c) => c.path === 'native.win.open').length, windows);
    assert.deepEqual(callsTo('open:openMessageLink'), []);
    await v.unmount();
  }
});

test('chatIdFromHref reads only a chat link', () => {
  assert.equal(chatIdFromHref('mopilot:chat/0b8e-11'), '0b8e-11');
  assert.equal(chatIdFromHref('mopilot:chat/claude:abc'), 'claude:abc');
  assert.equal(chatIdFromHref('mopilot:chat/'), null);
  assert.equal(chatIdFromHref('https://example.com'), null);
  assert.equal(chatIdFromHref(undefined), null);
  assert.equal(chatIdFromHref(''), null);
});
