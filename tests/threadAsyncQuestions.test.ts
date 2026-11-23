// Async and native questions share Claude-style choices, context and summaries with retryable delivery.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h, StrictMode } from 'react';
import { autoMock, render, settle, impl, callsTo, moduleCalls, window } from './support/thread-kit.ts';
import { deferred } from './support/async-scenarios.ts';

autoMock('src/harness/adapters/proxy.ts', 'proxy', {
  chatProxy: {
    send: (...args: any[]) => {
      moduleCalls.push(['proxy:send', args]);
      return impl['proxy:send']?.(...args);
    },
  },
});
const { useSessions } = await import('../src/store/session/useSession.ts');
const { EMPTY_SESSION } = await import('../src/store/session/sessionState.ts');
const { AsyncQuestions } = await import('../src/components/thread/AsyncQuestions.tsx');

const questions = [
  { title: 'Which view?', options: ['Chat', 'Window'] },
  { title: 'Which harness?', options: null },
];
const props = { questions, threadId: 'c1', cwd: '/repo', readOnly: false };
beforeEach(() => {
  moduleCalls.length = 0;
  delete impl['proxy:send'];
  useSessions.setState({ sessions: {} });
});
const type = (el: HTMLTextAreaElement, value: string) =>
  settle(() => {
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new window.Event('input', { bubbles: true }) as any);
  });
/** The card's send button: Next before the last question, then Submit (Sending… on its way) */
const sendOf = (v: { $: (s: string) => Element | null }) => v.$('.question-foot .ap-btn.allow') as HTMLButtonElement;
const key = (value: string, target: any = window, init = {}) =>
  settle(() => target.dispatchEvent(new window.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...init })));

test('single async choices use the shared Claude question card and become an answered summary', async () => {
  const v = await render(h(AsyncQuestions, { ...props, questions: [questions[0]] }));
  assert.ok(v.$('.question-card'));
  assert.deepEqual(
    v.$$('kbd.question-option-key').map((n) => n.textContent),
    ['1', '2', '3'],
  );
  await settle(() => v.$$('.question-option')[1].click());
  assert.deepEqual(callsTo('proxy:send'), [['c1', 'Which view?\nWindow', [], { human: true }, 'steer']]);
  assert.equal(v.$('.answered-question')?.textContent, 'Which view?');
  assert.equal(v.$('.answered-answer')?.textContent, 'Window');
  assert.equal(v.$('textarea'), null);
  assert.equal(v.$('button'), null);
  await v.unmount();
});

test('several questions go one at a time and send their answers together once', async () => {
  const v = await render(h(AsyncQuestions, props));
  assert.equal(sendOf(v).disabled, true);
  assert.equal(sendOf(v).textContent, 'Next ⌘↵');
  await key('Enter');
  assert.deepEqual(callsTo('proxy:send'), []);
  await settle(() => v.$$('.question-option')[1].click());
  // the second question, typed text only
  assert.equal(v.$('.question-title')?.textContent, 'Which harness?');
  const field = v.$('textarea') as HTMLTextAreaElement;
  assert.equal(field.value, '');
  await type(field, ' Codex ');
  assert.equal(sendOf(v).disabled, false);
  const pending = deferred();
  impl['proxy:send'] = () => pending.promise;
  await settle(() => field.focus());
  await settle(() => {
    sendOf(v).click();
    sendOf(v).click();
  });
  assert.equal(sendOf(v).textContent, 'Sending… ⌘↵');
  assert.equal(field.readOnly, true);
  assert.equal(document.activeElement, field);
  // Even synthetic Enter in a read-only field cannot submit another request while delivery is pending.
  await key('Enter', field);
  await key('Escape');
  assert.deepEqual(callsTo('proxy:send'), [['c1', 'Which view?\nWindow\n\nWhich harness?\nCodex', [], { human: true }, 'steer']]);
  await settle(() => pending.resolve(undefined));
  assert.deepEqual(
    v.$$('.answered-answer').map((n) => n.textContent),
    ['Window', 'Codex'],
  );
  assert.equal(v.$('button'), null);
  await v.unmount();
});

test("Skip answers a question with Claude Code's No preference, which reads as skipped", async () => {
  const v = await render(h(AsyncQuestions, props));
  await settle(() => v.$('.question-option')!.click());
  await settle(() => [...v.$$('button')].find((b) => b.textContent === 'Skip')!.click());
  assert.deepEqual(callsTo('proxy:send'), [['c1', 'Which view?\nChat\n\nWhich harness?\n[No preference]', [], { human: true }, 'steer']]);
  assert.deepEqual(
    v.$$('.answered-answer').map((n) => n.textContent),
    ['Chat', 'Skipped'],
  );
  assert.equal(v.$('.answered-answer.skipped')?.textContent, 'Skipped');
  await v.unmount();
});

test('failed custom sends keep the draft and display errors until successful retry', async () => {
  impl['proxy:send'] = async () => {
    throw new Error('IPC disconnected');
  };
  const v = await render(h(AsyncQuestions, { ...props, questions: [{ title: 'Anything else?', options: null }] }));
  await type(v.$('textarea') as HTMLTextAreaElement, 'Claude\nKeep context');
  await key('Enter', v.$('textarea'), { shiftKey: true });
  assert.equal(callsTo('proxy:send').length, 0);
  await key('Enter', v.$('textarea'));
  assert.equal(v.$('[role="alert"]')?.textContent, "Couldn't send: IPC disconnected");
  assert.equal((v.$('textarea') as HTMLTextAreaElement).value, 'Claude\nKeep context');
  impl['proxy:send'] = async () => {
    throw 'offline';
  };
  await settle(() => sendOf(v).click());
  assert.equal(v.$('[role="alert"]')?.textContent, "Couldn't send: offline");
  impl['proxy:send'] = async () => {};
  await settle(() => sendOf(v).click());
  assert.ok(!v.$('[role="alert"]'));
  assert.equal(v.$('.answered-answer')?.textContent, 'Claude\nKeep context');
  await v.unmount();
});

test('submitted history is an immutable summary after reload, including in read-only views', async () => {
  for (const readOnly of [false, true]) {
    const v = await render(h(AsyncQuestions, { ...props, readOnly, submittedAnswers: { 0: 'Chat', 1: 'Codex' } }));
    assert.deepEqual(
      v.$$('.answered-answer').map((n) => n.textContent),
      ['Chat', 'Codex'],
    );
    assert.equal(v.$('button'), null);
    assert.equal(v.$('textarea'), null);
    await key('1');
    await key('Escape');
    assert.deepEqual(callsTo('proxy:send'), []);
    await v.unmount();
  }
});

test('read-only or externally running cards cannot answer through clicks or shortcuts', async () => {
  for (const readOnly of [true, false]) {
    useSessions.setState({ sessions: { c1: { ...EMPTY_SESSION, runningElsewhere: !readOnly } } });
    const v = await render(h(AsyncQuestions, { ...props, readOnly }));
    // every button but the fold caret, which only shows or hides the choices
    assert.ok(
      v
        .$$('button')
        .every((button) => (button as HTMLButtonElement).disabled || button.getAttribute('aria-label') === 'View question options'),
    );
    assert.ok(v.$$('textarea').every((field) => (field as HTMLTextAreaElement).readOnly));
    await settle(() => v.$('.question-option')!.click());
    await key('1');
    await key('Escape');
    assert.deepEqual(callsTo('proxy:send'), []);
    await v.unmount();
  }
});

test("the X and Escape dismiss every question with Claude Code's words, which read as dismissed", async () => {
  for (const action of ['[aria-label="Dismiss question"]', 'Escape']) {
    const v = await render(h(AsyncQuestions, props));
    await type(v.$('textarea') as HTMLTextAreaElement, 'draft that is not submitted');
    // a card in the transcript takes keys pressed inside it
    if (action === 'Escape') await key('Escape', v.$('.question-card'));
    else await settle(() => v.$(action)!.click());
    const dismissed = '[User dismissed — do not proceed, wait for next instruction]';
    assert.deepEqual(callsTo('proxy:send').at(-1), [
      'c1',
      `Which view?\n${dismissed}\n\nWhich harness?\n${dismissed}`,
      [],
      { human: true },
      'steer',
    ]);
    assert.deepEqual(
      v.$$('.answered-answer').map((n) => n.textContent),
      ['Dismissed', 'Dismissed'],
    );
    await v.unmount();
  }
});

test('a rejected choice remains selected with an empty custom response for retry', async () => {
  impl['proxy:send'] = async () => {
    throw new Error('try again');
  };
  const v = await render(h(StrictMode, null, h(AsyncQuestions, { ...props, questions: [questions[0]] })));
  await key('2', v.$('.question-card'));
  assert.match(v.$('[role="alert"]')!.textContent!, /try again/);
  assert.match(v.$$('.question-option')[1].className, /\bsel\b/);
  assert.equal((v.$('textarea') as HTMLTextAreaElement).value, '');
  impl['proxy:send'] = async () => {};
  await settle(() => sendOf(v).click());
  assert.equal(v.$('.answered-answer')?.textContent, 'Window');
  await v.unmount();
});

test('changing chat or questions retires the old draft and pending completion', async () => {
  for (const reject of [false, true]) {
    const old = deferred();
    const next = deferred();
    impl['proxy:send'] = () => old.promise;
    const v = await render(h(AsyncQuestions, { ...props, questions: [questions[0]] }));
    await settle(() => v.$('.question-option')!.click());
    const replacement = { ...props, threadId: reject ? 'c2' : 'c1', questions: [{ title: 'New question?', options: null }] };
    await v.rerender(h(AsyncQuestions, replacement));
    assert.equal((v.$('textarea') as HTMLTextAreaElement).value, '');
    await type(v.$('textarea') as HTMLTextAreaElement, 'New answer');
    impl['proxy:send'] = () => next.promise;
    await settle(() => sendOf(v).click());
    await settle(() => (reject ? old.reject(new Error('old error')) : old.resolve(undefined)));
    assert.equal(sendOf(v).textContent, 'Sending… ⌘↵');
    assert.equal(v.$('[role="alert"]'), null);
    assert.equal(v.$('.answered-card'), null);
    await settle(() => next.resolve(undefined));
    assert.equal(v.$('.answered-answer')?.textContent, 'New answer');
    assert.equal(callsTo('proxy:send').at(-1)![0], replacement.threadId);
    await v.unmount();
  }
});

test('a pending submission coalesces synchronous repeated option activation', async () => {
  const pending = deferred();
  impl['proxy:send'] = () => pending.promise;
  const v = await render(h(AsyncQuestions, { ...props, questions: [questions[0]] }));
  const option = v.$('.question-option')!;
  const before = callsTo('proxy:send').length;
  await settle(() => {
    option.click();
    option.click();
  });
  assert.equal(callsTo('proxy:send').length, before + 1);
  await settle(() => pending.resolve(undefined));
  await v.unmount();
});

test('empty question requests cannot invent a successful reply', async () => {
  // the card answers a request that asks nothing at once; with nothing to answer, nothing is sent
  const v = await render(h(AsyncQuestions, { ...props, questions: [] }));
  await settle(() => undefined);
  assert.match(v.$('[role="alert"]')!.textContent!, /Answer every question/);
  assert.equal(callsTo('proxy:send').length, 0);
  await v.unmount();
});

test('history arriving during local delivery remains authoritative after local success or rejection', async () => {
  for (const reject of [false, true]) {
    const pending = deferred();
    impl['proxy:send'] = () => pending.promise;
    const ownProps = { ...props, questions: [questions[0]] };
    const v = await render(h(AsyncQuestions, ownProps));
    await settle(() => v.$('.question-option')!.click());
    await v.rerender(h(AsyncQuestions, { ...ownProps, submittedAnswers: { 0: 'Answer from history' } }));
    assert.equal(v.$('.answered-answer')?.textContent, 'Answer from history');
    await settle(() => (reject ? pending.reject(new Error('old local failure')) : pending.resolve(undefined)));
    assert.equal(v.$('.answered-answer')?.textContent, 'Answer from history');
    assert.equal(v.$('button'), null);
    assert.equal(v.$('[role="alert"]'), null);
    await v.unmount();
  }
});

test('the custom answer keeps keyboard focus during delivery and after rejection', async () => {
  const pending = deferred();
  impl['proxy:send'] = () => pending.promise;
  const v = await render(h(AsyncQuestions, { ...props, questions: [questions[1]] }));
  const field = v.$('textarea') as HTMLTextAreaElement;
  await type(field, 'My answer');
  await settle(() => field.focus());
  await key('Enter', field);
  assert.equal(document.activeElement, field);
  assert.equal(field.readOnly, true);
  await settle(() => pending.reject(new Error('Retry')));
  assert.equal(document.activeElement, field);
  assert.equal(field.readOnly, false);
  assert.equal(field.value, 'My answer');
  await v.unmount();
});

test("a docked card takes the window's keys; one left in the transcript only keys pressed inside it", async () => {
  const inline = await render(h(AsyncQuestions, { ...props, questions: [questions[0]] }));
  await key('2');
  assert.deepEqual(callsTo('proxy:send'), []);
  await inline.unmount();
  const docked = await render(h(AsyncQuestions, { ...props, questions: [questions[0]], docked: true }));
  await key('2');
  assert.deepEqual(callsTo('proxy:send'), [['c1', 'Which view?\nWindow', [], { human: true }, 'steer']]);
  // sent: the dock empties, and the transcript shows what was answered
  assert.equal(docked.$('.question-card'), null);
  assert.equal(docked.$('.answered-card'), null);
  await docked.unmount();
});
