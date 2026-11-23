// Cards on the phone: a card answered elsewhere says so, a plan is read before it is approved, and the chat list shows chips.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot, flush, click } from './support/phone/component-kit';
import { withOutbox } from './support/phone/outbox-kit';
import { fakeDraft } from './support/phone/drafts';
const threadPath = '../mobile/src/screens/Thread';
const rowPath = '../mobile/src/components/ChatRow';
const { Thread } = await import(threadPath);
const { ChatRow } = await import(rowPath);

const PLAN = {
  id: 'p1',
  rev: 1,
  title: 'Ready to start on this plan?',
  kind: 'plan',
  plan: { text: '1. Add the chip\n2. Test it', file: 'plan.md' },
  choices: [
    { key: 'once', label: 'Approve plan' },
    { key: 'deny', label: 'Deny', deny: true },
  ],
};

async function mount(cards: any[], answerError?: () => Error | null) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const calls: any[] = [];
  let listener: (e: any) => void = () => {};
  let draft = '';
  const runtime: any = {
    snapshot: () => ({ selectedPair: 'p', generation: 1 }),
    onEvent: (f: any) => ((listener = f), () => {}),
    request: async (method: string, p: any) => {
      calls.push([method, p]);
      if (method === 'chat.follow') return { rev: 1, feedSeq: 0, session: { turn: 'awaitingUser', cards }, itemsShape: 'rows', items: [] };
      if (method === 'card.answer' && answerError?.()) throw answerError();
      return {};
    },
  };
  withOutbox(runtime);
  const render = () =>
    createElement(Thread, {
      runtime,
      chatId: 'c',
      back: () => {},
      drafts: fakeDraft(draft, { set: (v: string) => (draft = v), clear: () => (draft = '') }),
    });
  await act(async () => root.render(render()));
  await flush();
  return {
    host,
    root,
    calls,
    render,
    emit: (e: any) => act(async () => listener({ kind: 'event', chatId: 'c', ...e })),
    setDraft: (v: string) => (draft = v),
  };
}

test('a card answered on the Mac says so, keeps its place after the Mac takes it down, and shows no raw error', async () => {
  const s = await mount(
    [{ id: 'a', rev: 1, title: 'Run it?', choices: [{ key: 'yes', label: 'Yes' }] }],
    () => new Error('That request was already answered.'),
  );
  await click('Yes');
  assert.match(s.host.textContent!, /Answered on your Mac/);
  assert.doesNotMatch(s.host.textContent!, /already answered/);
  assert.ok(![...s.host.querySelectorAll('button')].some((b) => b.textContent === 'Yes'));
  // the Mac's update removes the card; the note stays so the user is not left wondering
  await s.emit({ ev: 'session.patch', rev: 2, patch: { cards: [] } });
  assert.match(s.host.textContent!, /Run it\?/);
  assert.match(s.host.textContent!, /Answered on your Mac/);
  // the next message ends the notes
  s.setDraft('Go on');
  await act(async () => s.root.render(s.render()));
  await click('Send');
  assert.doesNotMatch(s.host.textContent!, /Answered on your Mac/);
  // a new card is its own thing
  await s.emit({
    ev: 'session.patch',
    rev: 3,
    patch: { cards: [{ id: 'b', rev: 1, title: 'Next?', choices: [{ key: 'ok', label: 'OK' }] }] },
  });
  assert.ok([...s.host.querySelectorAll('button')].some((b) => b.textContent === 'OK'));
  await act(async () => s.root.unmount());
  s.host.remove();
});

test('a refusal that is not "answered" still shows as an error and the card stays answerable', async () => {
  const s = await mount(
    [{ id: 'a', rev: 1, title: 'Run it?', choices: [{ key: 'yes', label: 'Yes' }] }],
    () => new Error('Allow this from your Mac.'),
  );
  await click('Yes');
  assert.match(s.host.textContent!, /Allow this from your Mac\./);
  assert.doesNotMatch(s.host.textContent!, /Answered on your Mac/);
  assert.ok([...s.host.querySelectorAll('button')].some((b) => b.textContent === 'Yes'));
  await act(async () => s.root.unmount());
  s.host.remove();
});

test('a plan card shows the plan to read, approves it, or asks for changes and then waits for what to change', async () => {
  const s = await mount([PLAN]);
  assert.match(s.host.textContent!, /1\.\s*Add the chip/);
  assert.match(s.host.textContent!, /Saved as plan\.md/);
  assert.doesNotMatch(s.host.textContent!, /Only the start/);
  assert.ok(![...s.host.querySelectorAll('button')].some((b) => b.textContent === 'Deny'));
  assert.equal((s.host.querySelector('input') as HTMLInputElement).placeholder, 'Message this chat');
  await click('Ask for changes');
  assert.deepEqual(s.calls.at(-1), ['card.answer', { chatId: 'c', cardId: 'p1', rev: 1, key: 'deny', values: {} }]);
  assert.equal((s.host.querySelector('input') as HTMLInputElement).placeholder, 'What should change in the plan?');
  // sending the message ends the wait
  s.setDraft('Use a pill');
  await act(async () => s.root.render(s.render()));
  await click('Send');
  assert.equal((s.host.querySelector('input') as HTMLInputElement).placeholder, 'Message this chat');
  await act(async () => s.root.unmount());
  s.host.remove();
});

test('approving a plan sends the approve key and does not wait for feedback; a refused card is no plan feedback', async () => {
  const s = await mount([PLAN]);
  await click('Approve plan');
  assert.deepEqual(s.calls.at(-1)?.[1].key, 'once');
  // an accepted answer keeps the card shut until the Mac takes it down: a second tap cannot read as "answered elsewhere"
  assert.ok([...s.host.querySelectorAll('button')].filter((b) => b.textContent === 'Approve plan').every((b) => b.disabled));
  assert.equal((s.host.querySelector('input') as HTMLInputElement).placeholder, 'Message this chat');
  await act(async () => s.root.unmount());
  s.host.remove();
  const other = await mount([{ ...PLAN, id: 'p2' }], () => new Error('Finish this on your Mac.'));
  await click('Ask for changes');
  assert.equal((other.host.querySelector('input') as HTMLInputElement).placeholder, 'Message this chat');
  assert.match(other.host.textContent!, /Finish this on your Mac/);
  await act(async () => other.root.unmount());
  other.host.remove();
});

test('a long plan is marked as clipped; an empty or missing plan says to read it on the Mac', async () => {
  const clipped = await mount([{ ...PLAN, plan: { text: 'Start of it', clipped: true } }]);
  assert.match(clipped.host.textContent!, /Only the start of the plan is shown/);
  assert.doesNotMatch(clipped.host.textContent!, /Saved as/);
  await act(async () => clipped.root.unmount());
  clipped.host.remove();
  const empty = await mount([{ ...PLAN, plan: { text: '' } }]);
  assert.match(empty.host.textContent!, /This plan has no text/);
  await act(async () => empty.root.unmount());
  empty.host.remove();
  const bare = await mount([{ id: 'x', rev: 1, title: 'Plan?', kind: 'plan', choices: PLAN.choices }]);
  assert.match(bare.host.textContent!, /Plan\?/);
  assert.ok([...bare.host.querySelectorAll('button')].some((b) => b.textContent === 'Ask for changes'));
  await act(async () => bare.root.unmount());
  bare.host.remove();
});

test('a chat row shows its state chip and its agent and opens the chat', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const opened: string[] = [];
  await act(async () =>
    root.render(
      createElement('div', null, [
        createElement(ChatRow, {
          key: 'a',
          chat: { id: 'a', title: 'Fix build', state: 'waiting', harness: 'claude' },
          open: () => opened.push('a'),
        }),
        createElement(ChatRow, {
          key: 'b',
          chat: { id: 'b', state: 'idle', unread: true, harness: 'codex' },
          open: () => opened.push('b'),
        }),
        createElement(ChatRow, { key: 'c', chat: { id: 'c', title: 'Old' }, open: () => opened.push('c') }),
      ]),
    ),
  );
  const text = host.textContent!;
  assert.match(text, /Fix build/);
  assert.match(text, /Waiting for you/);
  assert.match(text, /Fix buildWaiting for you(?!C)/, 'the agent is not drawn in the row');
  assert.match(text, /Untitled chatDone(?!X)/);
  assert.doesNotMatch(text, /Claude Code|Codex/, 'and not a name');
  assert.equal(host.querySelector('button[aria-label="Open chat Untitled chat"]')?.getAttribute('aria-valuetext'), 'Done, Codex');
  assert.doesNotMatch(text, /Idle/, 'an idle chat says nothing of its state in the line');
  assert.equal(host.querySelector('button[aria-label="Open chat Old"]')?.getAttribute('aria-valuetext'), 'Idle');
  assert.ok(host.querySelector('button[aria-label="Open chat Fix build"]'));
  await act(async () => (host.querySelector('button[aria-label="Open chat Untitled chat"]') as HTMLElement).click());
  assert.deepEqual(opened, ['b']);
  await act(async () => root.unmount());
  host.remove();
});

test('a card with questions, fields, detail and a link hides all of them once it was answered elsewhere', async () => {
  const rich = {
    id: 'r',
    rev: 1,
    title: 'Need input',
    detail: 'Some detail',
    inApp: true,
    url: 'https://example.test/r',
    questions: [{ id: 'q', question: 'Which one?', options: [{ label: 'First' }] }],
    schema: { properties: { name: { title: 'Name', type: 'string' } } },
    choices: [{ key: 'go', label: 'Go' }],
  };
  const s = await mount([rich], () => new Error('That request was already answered.'));
  for (const text of [/Some detail/, /Finish this request on your computer/, /Which one\?/, /Name/, /example\.test/])
    assert.match(s.host.textContent!, text);
  await click('Go');
  assert.match(s.host.textContent!, /Need input/);
  assert.match(s.host.textContent!, /Answered on your Mac/);
  for (const text of [/Some detail/, /Finish this request/, /Which one\?/, /Name/, /example\.test/])
    assert.doesNotMatch(s.host.textContent!, text);
  await act(async () => s.root.unmount());
  s.host.remove();
});
