// The agent's waiting questions docked above the composer (src/components/thread/DockedQuestions.tsx): the docked card
// for the item, keyed by it, so another item's questions start fresh.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { $, mockTsx, mount } from './support/composer-kit.ts';

const { createElement: h } = await import('react');
mockTsx(new URL('../src/components/thread/AsyncQuestions.tsx', import.meta.url), {
  AsyncQuestions: (p: any) =>
    h('div', { className: 'asked', 'data-docked': String(p.docked), 'data-readonly': String(p.readOnly) }, p.questions[0].title),
});
const { DockedQuestions } = await import('../src/components/thread/DockedQuestions.tsx');

test("the dock holds the item's questions as a docked, answerable card", async () => {
  const item: any = { type: 'agentMessage', id: 'q1', text: '', questions: [{ title: 'Which?', options: null }] };
  const v = await mount(h(DockedQuestions, { threadId: 'c', cwd: '/w', item }));
  try {
    assert.ok($('.docked-questions .asked'));
    assert.equal($('.asked').textContent, 'Which?');
    assert.equal($('.asked').getAttribute('data-docked'), 'true');
    assert.equal($('.asked').getAttribute('data-readonly'), 'false');
  } finally {
    await v.unmount();
  }
});
