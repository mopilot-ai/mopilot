// A question the agent on a machine asks, drawn as the app's own question card and settled like a This Mac chat's (src/components/thread/HostAskedCard.tsx): the card leaves at once, the answers become the answered-questions record, a machine that cannot take the answer brings the card back with the cause, and a question answered elsewhere is gone.
import { test, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import postcss from 'postcss';
import './support/dom.ts';
import { createElement as h, act } from 'react';
import { createRoot } from 'react-dom/client';
import { appCss } from './support/app-css.ts';
import { cssRules } from './support/css-rules.ts';
import { installNativeStub } from './support/ports/native.ts';
let listed: any[] = [];
const sent: any[] = [];
const notes: any[] = [];
let answer: any = async () => ({ status: 'written' });
mock.module('../src/store/session/useSession.ts', {
  namedExports: { flushSessionPatches: () => {}, useSession: () => ({ questions: listed }), useSessionField: () => undefined },
});
mock.module('../src/store/answersNote.ts', { namedExports: { answersNote: (...a: any[]) => void notes.push(a) } });
installNativeStub({
  session: {
    answerQuestion: (...a: any[]) => {
      sent.push(a);
      return answer(...a);
    },
  },
});
const { HostAskedCard } = await import('../src/components/thread/HostAskedCard.tsx');
const { AcpQuestions } = await import('../src/components/thread/AcpQuestions.tsx');
await import('../src/lib/native/session.ts');
const roots: any[] = [];
const ASKED = [
  {
    id: 'q1',
    question: 'Which fruit?',
    header: 'Fruit',
    options: [{ label: 'apple' }, { label: 'pear' }],
    multiSelect: false,
    isOther: true,
    isSecret: false,
  },
];
const view = (extra: any = {}) => ({
  id: 'c1',
  kind: 'question',
  status: 'pending',
  harness: 'Codex',
  message: 'A question for you',
  toolCallId: null,
  form: { fields: [] },
  asked: ASKED,
  error: null,
  ...extra,
});
let host: HTMLElement;
async function draw(q: any, readOnly = false) {
  host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  const again = async (next: any) =>
    act(async () => root.render(h(HostAskedCard, { question: next, asked: ASKED, threadId: 'chat', readOnly })));
  await again(q);
  return again;
}
const tile = (label: string) =>
  Array.from(host.querySelectorAll('.question-option')).find(
    (t) => t.querySelector('.question-option-label')?.textContent === label,
  ) as HTMLElement;
const click = (el: Element) =>
  act(async () => {
    (el as HTMLElement).click();
  });
afterEach(async () => {
  for (const r of roots.splice(0)) await act(async () => r.unmount());
  host?.remove();
  sent.length = 0;
  notes.length = 0;
  answer = async () => ({ status: 'written' });
});

test('the card is the app’s question card; an answer sends the card’s own answers, removes the card at once, and the record is written when the machine takes it', async () => {
  const again = await draw(view());
  assert.ok(host.querySelector('.question-card'));
  assert.equal(host.textContent?.includes('Drafts stay in this window'), false);
  await click(tile('pear'));
  assert.deepEqual(sent, [['chat', 'c1', { action: 'accept', content: { answers: { q1: { answers: ['pear'] } } } }]]);
  assert.equal(host.querySelector('.question-card'), null, 'gone at once');
  assert.deepEqual(notes, []);
  // the machine took it
  await again(view({ status: 'answered' }));
  assert.equal(host.querySelector('.question-card'), null);
  assert.equal(notes.length, 1);
  assert.deepEqual(notes[0][2], { answers: { q1: { answers: ['pear'] } } });
  // seen again (a repeated event) writes it once
  await again(view({ status: 'answered' }));
  assert.equal(notes.length, 1);
});

test('a machine that cannot take the answer brings the card back with the cause; answering again goes through', async () => {
  answer = async () => ({ status: 'written' });
  const again = await draw(view());
  await click(tile('apple'));
  assert.equal(host.querySelector('.question-card'), null);
  // main published the failure as pending with the cause (and one more retry counted), after the sending state
  await again(view({ status: 'sending' }));
  await again(view({ status: 'pending', error: 'The machine could not be reached. Ask again.', retried: 1 }));
  assert.ok(host.querySelector('.question-card'), 'back');
  assert.match(host.textContent ?? '', /could not be reached/);
  await click(tile('apple'));
  assert.equal(sent.length, 2);
});

test('a machine that fails twice in a row brings the card back each time, and a lost question says why', async () => {
  const again = await draw(view());
  for (const n of [1, 2]) {
    await click(tile('apple'));
    assert.equal(host.querySelector('.question-card'), null);
    await again(view({ status: 'pending', error: 'The machine could not be reached. Ask again.', retried: n }));
    assert.ok(host.querySelector('.question-card'), `back after failure ${n}`);
  }
  await again(view({ status: 'retired', error: 'This question is no longer available.' }));
  assert.equal(host.querySelector('.question-card'), null);
  assert.match(host.textContent ?? '', /no longer available/);
});

test('an answer main refuses or loses brings the card back with the cause', async () => {
  answer = async () => ({ status: 'pending', error: 'Check the required fields and allowed values.' });
  await draw(view());
  await click(tile('apple'));
  assert.ok(host.querySelector('.question-card'));
  assert.match(host.textContent ?? '', /Check the required fields/);
  answer = async () => ({ status: 'retired' });
  await click(tile('pear'));
  assert.match(host.textContent ?? '', /no longer available/);
  answer = async () => {
    throw new Error('offline');
  };
  await click(tile('pear'));
  assert.match(host.textContent ?? '', /Couldn't send your answer: offline/);
});

test('a question answered elsewhere (cancelled), or an old Host’s retired one, shows nothing; another window’s read-only card cannot answer', async () => {
  const again = await draw(view({ status: 'cancelled' }));
  assert.equal(host.querySelector('.question-card'), null);
  assert.equal(notes.length, 0, 'no record: this window gave no answer');
  await again(view());
  assert.ok(host.querySelector('.question-card'));
  await again(view({ error: 'earlier' }));
  assert.match(host.textContent ?? '', /earlier/);
  await draw(view(), true);
  await click(tile('apple'));
  assert.equal(sent.length, 0);
});

test('the Host question card and the ACP form both use the composer column when docked', async () => {
  host = document.createElement('div');
  host.className = 'thread-composer-area';
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  const form = {
    fields: [
      { key: 'name', type: 'string', title: 'Name', description: null, required: true, options: null, min: null, max: null, format: null },
    ],
  };
  listed = [view({ id: 'c1' }), view({ id: 'c2', asked: undefined, form, message: 'Who?' })];
  try {
    await act(async () => root.render(h(AcpQuestions, { threadId: 'chat', readOnly: false })));
    const question = host.querySelector<HTMLElement>('.question-card')!;
    const formCard = host.querySelector<HTMLElement>('section.approval-card')!;
    assert.match(question.textContent ?? '', /Which fruit\?/);
    assert.match(formCard.textContent ?? '', /Drafts stay in this window/);
    // The DOM fixture does not resolve CSS min(). Compare the actual width declarations and selector matching.
    const { decls } = cssRules(postcss.parse(appCss()));
    const dockedCard = '.thread-composer-area > .approval-card';
    const width = decls('.composer-wrap').width;
    assert.ok(width);
    assert.equal(decls(dockedCard).width, width);
    assert.equal(decls('.approval-stack').width, width);
    assert.ok(question.matches(dockedCard));
    assert.ok(formCard.matches(dockedCard));
    host.className = 'needs-you-answer';
    assert.equal(question.matches(dockedCard), false, 'questions in the transcript use their own layout');
  } finally {
    listed = [];
  }
});
