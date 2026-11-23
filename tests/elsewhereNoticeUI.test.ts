// The notice above the composer when another app has the chat (src/components/thread/ElsewhereNotice.tsx): nothing for
// an idle Claude desktop, and what is happening plus the one action that applies for a writer, a lock or a held message.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { iconStubs, mockSource, stubStore } from './support/stubs.ts';

// rendered once to static markup: the selector reads the state as it is
let state: any = { elsewhere: {}, runtime: {} };
stubStore({
  useStore: (select: (s: any) => unknown) => select(state),
  ELSEWHERE_LABEL: { 'claude-desktop': 'Claude desktop', codex: 'another Codex app' },
  cancelHeld: () => {},
  continueHere: () => {},
  sendHeld: () => {},
});
mockSource('src/components/ui/icons.tsx', iconStubs());
const { ElsewhereNotice } = await import('../src/components/thread/ElsewhereNotice.tsx');

const render = (e: any, held: any = null) => {
  state = { elsewhere: { chat: e }, runtime: { chat: { held } } };
  return renderToStaticMarkup(createElement(ElsewhereNotice, { threadId: 'chat' }));
};

test('idle Claude desktop presence does not display a persistent banner', () => {
  assert.equal(render({ app: 'claude-desktop', running: false, hard: false }), '');
  assert.equal(render(null), '');
});

test('active external writers, hard locks, and held messages retain actionable notices', () => {
  assert.match(render({ app: 'claude-desktop', running: true, hard: false }), /Claude desktop is working/);
  assert.match(render({ app: 'codex', running: false, hard: true }), /Close it there/);
  assert.match(render({ app: 'claude-desktop', running: false, hard: false }, { text: 'hello' }), /Send here/);
  assert.match(render(null, { text: 'hello' }), /Send now/);
});
