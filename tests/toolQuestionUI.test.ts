import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { iconStubs, mockSource } from './support/stubs.ts';

mockSource('src/components/ui/icons.tsx', iconStubs());
mock.module('../src/components/markdown/Markdown.tsx', { namedExports: { Markdown: ({ text }: { text: string }) => text } });
mock.module('../src/store/session/useSession.ts', {
  namedExports: {
    flushSessionPatches: () => {},
    useSession: () => ({ runningElsewhere: false }),
    useSessionField: (id: any, pick: any) => pick(((() => ({ runningElsewhere: false })) as (id: any) => any)(id)),
  },
});
mock.module('../src/harness/adapters/proxy.ts', { namedExports: { chatProxy: { send: async () => {} } } });
const { RunningCommand } = await import('../src/components/thread/RunningCommand.tsx');
const { AsyncQuestions } = await import('../src/components/thread/AsyncQuestions.tsx');
function elements(node: any): any[] {
  if (!node || typeof node !== 'object') return [];
  return [node, ...[node.props?.children].flat(Infinity).flatMap(elements)];
}
const commandProps = {
  id: 'cmd1',
  expandedId: null,
  onExpand(_id: string | null) {},
  icon: null,
  label: 'Running command',
  children: createElement('pre', null, 'LIVE OUTPUT'),
};

test('live output stays hidden by default even when a command has produced output', () => {
  const html = renderToStaticMarkup(createElement(RunningCommand, commandProps));
  assert.match(html, /Running command/);
  assert.match(html, /aria-expanded="false"/);
  assert.doesNotMatch(html, /LIVE OUTPUT|step-body/);
});

test('a user can open and close live output; the next command stays collapsed', () => {
  const expanded: (string | null)[] = [];
  for (const expandedId of [null, 'cmd1']) {
    const tree = RunningCommand({ ...commandProps, expandedId, onExpand: (id) => expanded.push(id) });
    elements(tree)
      .find((e) => e.type === 'button')
      .props.onClick();
  }
  assert.deepEqual(expanded, ['cmd1', null]);
  const html = renderToStaticMarkup(createElement(RunningCommand, { ...commandProps, expandedId: 'cmd1' }));
  assert.match(html, /aria-expanded="true"/);
  assert.match(html, /LIVE OUTPUT/);
  const next = renderToStaticMarkup(createElement(RunningCommand, { ...commandProps, id: 'cmd2', expandedId: 'cmd1' }));
  assert.doesNotMatch(next, /LIVE OUTPUT/);
  assert.match(next, /aria-expanded="false"/);
});

const questions = [
  { title: 'Which view?', options: ['Chat', 'Window'] },
  { title: 'Which harness?', options: null },
];

test("async questions use Claude's question card: one question at a time with numbered tiles and an Other field", () => {
  const html = renderToStaticMarkup(createElement(AsyncQuestions, { questions, threadId: 'chat1', cwd: '/repo', readOnly: false }));
  assert.match(html, /question-card/);
  assert.match(html, /class="question-count">1\/2</);
  assert.match(html, /question-title[^>]*>Which view\?</);
  assert.doesNotMatch(html, /Which harness\?/);
  assert.equal((html.match(/<kbd class="question-option-key">/g) ?? []).length, 3);
  assert.equal((html.match(/<textarea/g) ?? []).length, 1);
  assert.match(html, /Type your own answer here/);
  assert.match(html, /disabled="">Next/);
  assert.doesNotMatch(html, /<input/);
});

test('remounted submitted questions show one compact immutable answer summary', () => {
  const props = { questions, threadId: 'chat1', cwd: '/repo', readOnly: false, submittedAnswers: { 0: 'Window', 1: 'Codex' } };
  for (let mount = 0; mount < 2; mount++) {
    const html = renderToStaticMarkup(createElement(AsyncQuestions, props));
    assert.match(html, /answered-card/);
    assert.match(html, /Which view\?/);
    assert.match(html, /Window/);
    assert.match(html, /Codex/);
    assert.doesNotMatch(html, /<button|<input|<textarea|Answer sent/);
  }
});

test('read-only cards expose context while all answer controls remain locked', () => {
  const html = renderToStaticMarkup(createElement(AsyncQuestions, { questions, threadId: 'chat1', cwd: '/repo', readOnly: true }));
  assert.match(html, /question-card/);
  assert.equal((html.match(/readOnly=""/g) ?? []).length, 1);
  assert.equal((html.match(/aria-disabled="true"/g) ?? []).length, 1);
  // every button but the fold caret, which only shows or hides the choices
  assert.equal((html.match(/<button/g) ?? []).length - 1, (html.match(/disabled=""/g) ?? []).length);
});

test('reloaded skipped answers share the native summary styling', () => {
  const html = renderToStaticMarkup(
    createElement(AsyncQuestions, {
      questions,
      threadId: 'chat1',
      cwd: '/repo',
      readOnly: false,
      submittedAnswers: { 0: 'Chat', 1: 'Skipped' },
    }),
  );
  assert.match(html, /answered-answer skipped/);
  assert.doesNotMatch(html, /<button/);
  // Claude Code's words for a skipped or dismissed question read as skipped and dismissed
  const now = renderToStaticMarkup(
    createElement(AsyncQuestions, {
      questions,
      threadId: 'chat1',
      cwd: '/repo',
      readOnly: false,
      submittedAnswers: { 0: '[No preference]', 1: '[User dismissed — do not proceed, wait for next instruction]' },
    }),
  );
  assert.match(now, /answered-answer skipped">Skipped</);
  assert.match(now, /answered-answer skipped">Dismissed</);
  assert.doesNotMatch(now, /No preference|do not proceed/);
});

test('docked questions leave once sent: the transcript, not the dock, shows what was answered', () => {
  const html = renderToStaticMarkup(
    createElement(AsyncQuestions, {
      questions,
      threadId: 'chat1',
      cwd: '/repo',
      readOnly: false,
      docked: true,
      submittedAnswers: { 0: 'Chat', 1: 'x' },
    }),
  );
  assert.equal(html, '');
  const open = renderToStaticMarkup(
    createElement(AsyncQuestions, { questions, threadId: 'chat1', cwd: '/repo', readOnly: false, docked: true }),
  );
  assert.match(open, /async-questions docked/);
});
