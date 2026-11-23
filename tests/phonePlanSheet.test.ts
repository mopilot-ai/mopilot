// A plan waiting for approval opens as a sheet over the chat, closes to a reminder row, and an approval has one main action.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot, flush, click } from './support/phone/component-kit';
import { withOutbox } from './support/phone/outbox-kit';
import { fakeDraft } from './support/phone/drafts';
const threadPath = '../mobile/src/screens/Thread';
const cardPath = '../mobile/src/components/RequestCard';
const { Thread } = await import(threadPath);
const { RequestCard } = await import(cardPath);

const PLAN = {
  id: 'p1',
  rev: 1,
  title: 'Approve this plan?',
  kind: 'plan',
  plan: { text: '1. Round once\n2. Add a test' },
  choices: [
    { key: 'once', label: 'Approve plan' },
    { key: 'deny', label: 'Deny', deny: true },
  ],
};

/** Holds every card answer until released, so a second tap can be made while the first is on its way. */
let holdAnswers: Promise<void> | null = null;
const PLAN_KEY = JSON.stringify(['p1', 1]);

async function mount(cards: any[], answerError?: () => Error | null, props: object = {}) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const calls: any[] = [];
  const runtime: any = {
    snapshot: () => ({ selectedPair: 'p', generation: 1 }),
    onEvent: () => () => {},
    request: async (method: string, p: any) => {
      calls.push([method, p]);
      if (method === 'chat.follow') return { rev: 1, feedSeq: 0, session: { turn: 'awaitingUser', cards }, itemsShape: 'rows', items: [] };
      if (method === 'card.answer' && holdAnswers) await holdAnswers;
      if (method === 'card.answer' && answerError?.()) throw answerError();
      return {};
    },
  };
  withOutbox(runtime);
  const { draft = '', ...rest } = props as { draft?: string };
  await act(async () => root.render(createElement(Thread, { runtime, chatId: 'c', back: () => {}, drafts: fakeDraft(draft), ...rest })));
  await flush();
  return {
    host,
    calls,
    done: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}
const has = (host: HTMLElement, label: string) => !!host.querySelector(`button[aria-label="${label}"]`);
/** Whether the sheet is shown: the overlay around its scrim carries `display`; false when there is no sheet at all. */
const sheetShown = (host: HTMLElement) => {
  for (let el = host.querySelector('button[aria-label="Close plan"]')?.parentElement; el; el = el.parentElement) {
    const style = el.dataset.style && JSON.parse(el.dataset.style);
    if (style?.display) return style.display === 'flex';
  }
  return false;
};

test('a waiting plan opens as a sheet; closing it leaves a reminder that reopens it', async () => {
  const v = await mount([PLAN]);
  assert.match(v.host.textContent!, /1\.\s*Round once/);
  assert.equal(sheetShown(v.host), true, 'the scrim closes the sheet');
  assert.match(v.host.textContent!, /Approve plan/);
  assert.equal(has(v.host, 'Review plan'), false);
  await click('Close plan');
  assert.equal(sheetShown(v.host), false);
  assert.match(v.host.textContent!, /This plan is waiting for your answer\./);
  await click('Review plan');
  assert.equal(sheetShown(v.host), true);
  assert.equal(has(v.host, 'Review plan'), false);
  await click('Approve plan');
  assert.deepEqual(v.calls.at(-1)?.[1].key, 'once');
  await v.done();
});

test('an approved plan leaves the sheet for a receipt: no second answer is possible, from the sheet or the card', async () => {
  const v = await mount([PLAN]);
  await click('Approve plan');
  const answers = () => v.calls.filter(([m]) => m === 'card.answer').length;
  assert.equal(answers(), 1);
  assert.equal(sheetShown(v.host), false);
  assert.match(v.host.textContent!, /Approve plan · answered on this (iPhone|phone)/);
  assert.equal(has(v.host, 'Approve plan'), false, 'the buttons went with the answer');
  assert.equal(has(v.host, 'Review plan'), false);
  assert.equal(answers(), 1);
  await v.done();
});

test('Ask for changes closes the sheet and leaves the field asking what should change', async () => {
  const v = await mount([PLAN]);
  await click('Ask for changes');
  assert.deepEqual(v.calls.at(-1)?.[1].key, 'deny');
  assert.equal(sheetShown(v.host), false, 'the sheet makes way for the field');
  assert.equal((v.host.querySelector('input') as HTMLInputElement).placeholder, 'What should change in the plan?');
  await v.done();
});

test('a plan answered elsewhere is a plain card, not a sheet', async () => {
  const v = await mount([PLAN], () => new Error('That request was already answered.'));
  await click('Approve plan');
  assert.match(v.host.textContent!, /Answered on your Mac/);
  assert.equal(has(v.host, 'Close plan'), false);
  assert.equal(has(v.host, 'Review plan'), false);
  await v.done();
});

test('an approval has one main action first, the other choices quieter beside each other, and a refusal in red', async () => {
  const answers: string[] = [];
  const mountCard = async (card: any) => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(createElement(RequestCard, { card, answer: async (key: string) => (answers.push(key), true) })));
    return {
      host,
      done: async () => {
        await act(async () => root.unmount());
        host.remove();
      },
    };
  };
  const buttons = (host: HTMLElement) => [...host.querySelectorAll('button')].map((b) => b.textContent);
  const v = await mountCard({
    id: 'a',
    rev: 1,
    title: 'Run this command?',
    detail: 'rm -rf dist',
    choices: [
      { key: 'deny', label: 'Deny', deny: true },
      { key: 'once', label: 'Allow once' },
      { key: 'always', label: 'Always allow' },
    ],
  });
  assert.deepEqual(buttons(v.host), ['Allow once', 'Deny', 'Always allow'], 'the main action first, the rest in their order');
  await click('Allow once');
  assert.deepEqual(answers, ['once']);
  await v.done();

  // nothing but refusals: they are all there is, and none is a main action
  const refuse = await mountCard({ id: 'b', rev: 1, title: 'Stop?', choices: [{ key: 'no', label: 'No', deny: true }] });
  assert.deepEqual(buttons(refuse.host), ['No']);
  await refuse.done();

  // a card with no choices shows its title only
  const none = await mountCard({ id: 'c', rev: 1, title: 'FYI' });
  assert.deepEqual(buttons(none.host), []);
  await none.done();
});

const field = (host: HTMLElement) => host.querySelector('input') as HTMLInputElement;
const methods = (calls: any[]) => calls.map(([m]) => m).filter((m) => m === 'card.answer' || m === 'chat.send');

test('a chat opened to ask what should change leaves its plan unanswered, the sheet closed and the field asking', async () => {
  const v = await mount([PLAN], undefined, { askChanges: PLAN_KEY });
  assert.equal(sheetShown(v.host), false, 'the sheet makes way for the field');
  assert.equal(field(v.host).placeholder, 'What should change in the plan?');
  assert.deepEqual(methods(v.calls), [], 'nothing is sent until the person says what to change');
  await v.done();
});

test('what the person types is sent after the plan is sent back, as the chat does it: the refusal first, then the words', async () => {
  const v = await mount([PLAN], undefined, { askChanges: PLAN_KEY, draft: 'round once, at the end' });
  await click('Send message');
  await flush();
  await flush();
  assert.deepEqual(methods(v.calls), ['card.answer', 'chat.send']);
  assert.equal(v.calls.find(([m]) => m === 'card.answer')![1].key, 'deny');
  assert.equal(v.calls.find(([m]) => m === 'chat.send')![1].text, 'round once, at the end');
  await v.done();
});

test('a plan refused by the Mac is not followed by the words, and the field keeps asking', async () => {
  const v = await mount([PLAN], () => new Error('The Mac refused that.'), { askChanges: PLAN_KEY, draft: 'round once' });
  await click('Send message');
  await flush();
  await flush();
  assert.deepEqual(methods(v.calls), ['card.answer'], 'the words wait for the plan to be sent back');
  assert.equal(field(v.host).placeholder, 'What should change in the plan?');
  await v.done();
});

test('a plan that no longer waits is not refused: what the person typed is just sent', async () => {
  const v = await mount([], undefined, { askChanges: PLAN_KEY, draft: 'round once' });
  await click('Send message');
  await flush();
  await flush();
  assert.deepEqual(methods(v.calls), ['chat.send']);
  await v.done();
});

test('a chat opened as usual still asks nothing and sends its words alone', async () => {
  const v = await mount([PLAN], undefined, { draft: 'hello' });
  assert.equal(sheetShown(v.host), true);
  assert.equal(field(v.host).placeholder, 'Message this chat');
  await click('Send message');
  await flush();
  await flush();
  assert.deepEqual(methods(v.calls), ['chat.send']);
  await v.done();
});

test('a plan with no refusal to send is not refused first: the words are just sent', async () => {
  const approveOnly = { ...PLAN, choices: [{ key: 'once', label: 'Approve plan' }] };
  const v = await mount([approveOnly], undefined, { askChanges: PLAN_KEY, draft: 'round once' });
  await click('Send message');
  await flush();
  await flush();
  assert.deepEqual(methods(v.calls), ['chat.send']);
  await v.done();
});

test('reviewing the plan again while its changes are asked for opens the sheet, and its own buttons answer as they always did', async () => {
  const v = await mount([PLAN], undefined, { askChanges: PLAN_KEY });
  assert.equal(sheetShown(v.host), false);
  await click('Review plan');
  assert.equal(sheetShown(v.host), true);
  await click('Ask for changes');
  assert.equal(v.calls.find(([m]) => m === 'card.answer')![1].key, 'deny');
  assert.equal(field(v.host).placeholder, 'What should change in the plan?');
  await v.done();
});

test('a plan the Mac revised meanwhile is another card: it opens its own sheet, is not refused unseen, and the words are just sent', async () => {
  const revised = { ...PLAN, rev: 2, plan: { text: '1. Use sqlite' } };
  const v = await mount([revised], undefined, { askChanges: PLAN_KEY, draft: 'use sqlite' });
  assert.equal(sheetShown(v.host), true, 'the revised plan is read in its own sheet');
  assert.equal(field(v.host).placeholder, 'Message this chat', 'nothing is asked of a plan that is gone');
  await click('Send message');
  await flush();
  await flush();
  assert.deepEqual(methods(v.calls), ['chat.send']);
  await v.done();
});

test('with two plans waiting, the refusal is the one that was asked about', async () => {
  const second = { ...PLAN, id: 'p2', plan: { text: '1. Other plan' } };
  const v = await mount([PLAN, second], undefined, { askChanges: JSON.stringify(['p2', 1]), draft: 'change the other one' });
  await click('Send message');
  await flush();
  await flush();
  assert.deepEqual(methods(v.calls), ['card.answer', 'chat.send']);
  assert.equal(v.calls.find(([m]) => m === 'card.answer')![1].cardId, 'p2');
  await v.done();
});

test('a second tap on Send while the refusal is on its way sends no second refusal', async () => {
  let release: () => void = () => {};
  holdAnswers = new Promise<void>((resolve) => (release = resolve));
  try {
    const v = await mount([PLAN], undefined, { askChanges: PLAN_KEY, draft: 'round once' });
    await click('Send message');
    await click('Send message');
    await flush();
    assert.equal(v.calls.filter(([m]) => m === 'card.answer').length, 1, 'one refusal, however many taps');
    await act(async () => release());
    await flush();
    await flush();
    assert.deepEqual(methods(v.calls), ['card.answer', 'chat.send']);
    await v.done();
  } finally {
    holdAnswers = null;
  }
});

test('the composer’s send, asked twice while the plan’s refusal is on its way, refuses once and sends the words once', async () => {
  const hookPath = '../mobile/src/remote/useCards';
  const { useCards } = await import(hookPath);
  let release: (taken: boolean) => void = () => {};
  const taken = new Promise<boolean>((resolve) => (release = resolve));
  let answers = 0;
  let cards: any;
  const Probe = () => {
    cards = useCards(
      [PLAN],
      async () => {
        answers += 1;
        return taken;
      },
      PLAN_KEY,
    );
    return null;
  };
  const host = document.createElement('div');
  const root = createRoot(host);
  await act(async () => root.render(createElement(Probe)));
  const sent: string[] = [];
  const send = cards.refusingFirst(() => sent.push('words'));
  send();
  send();
  assert.equal(answers, 1, 'the second ask finds the refusal on its way');
  await act(async () => release(true));
  await flush();
  assert.deepEqual(sent, ['words']);
  // taken, the plan is answered: the next ask, from the next render, just sends
  cards.refusingFirst(() => sent.push('again'))();
  assert.equal(answers, 1);
  assert.deepEqual(sent, ['words', 'again']);
  await act(async () => root.unmount());
});
