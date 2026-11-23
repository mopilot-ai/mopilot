// The chat's approval card (the card's own choices, More options, Deny with comment, offline), and its answered line.
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot, flush, click } from './support/phone/component-kit';
import { withOutbox } from './support/phone/outbox-kit';
import { fakeDraft } from './support/phone/drafts';
const threadPath = '../mobile/src/screens/Thread';
const approvalPath = '../mobile/src/components/ApprovalCard';
const cardsPath = '../mobile/src/components/ChatCards';
const linkPath = '../mobile/src/macLink';
const stackPath = '../mobile/src/stack';
const { Thread } = await import(threadPath);
const { ApprovalCard, approvalLayout, isApproval } = await import(approvalPath);
const { ResolvedApproval } = await import(cardsPath);
const { MacLinkProvider } = await import(linkPath);
const { stackOf } = await import(stackPath);

const RUN = {
  id: 'a',
  rev: 1,
  title: 'Run this command?',
  detail: 'npm test -- auth',
  choices: [
    { key: 'once', label: 'Allow once' },
    { key: 'session', label: 'Allow for this session' },
    { key: 'deny', label: 'Deny', deny: true },
    { key: 'denyAlways', label: 'Always deny', deny: true },
  ],
};

const mounted = new Set<() => Promise<void>>();
afterEach(async () => {
  for (const done of [...mounted]) await done();
});

async function mount(node: any) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const done = async () => {
    if (!mounted.delete(done)) return;
    try {
      await act(async () => root.unmount());
    } finally {
      host.remove();
    }
  };
  mounted.add(done);
  await act(async () => root.render(node));
  await flush();
  return { host, root, done };
}
// The question's header locates its card; composer and header controls are outside that owner.
const buttons = (host: HTMLElement, title = RUN.title) => {
  const heading = [...host.querySelectorAll('[role="header"]')].find((h) => h.textContent === title);
  assert.ok(heading, `Missing approval question: ${title}`);
  const card = heading.parentElement?.parentElement;
  assert.ok(card, `Missing owner for approval question: ${title}`);
  return [...card.querySelectorAll('button')].map((b) => b.getAttribute('aria-label'));
};

function thread(cards: any[], answer: (p: any) => unknown = () => ({})) {
  const calls: any[] = [];
  const runtime: any = {
    snapshot: () => ({ selectedPair: 'p', generation: 1 }),
    onEvent: () => () => {},
    request: async (method: string, p: any) => {
      calls.push([method, p]);
      if (method === 'chat.follow') return { rev: 1, feedSeq: 0, session: { turn: 'awaitingUser', cards }, itemsShape: 'rows', items: [] };
      if (method === 'card.answer') return answer(p);
      return {};
    },
  };
  withOutbox(runtime);
  return {
    calls,
    node: createElement(Thread, { runtime, chatId: 'c', back: () => {}, drafts: fakeDraft('') }),
  };
}

test('the layout follows the card: the first allow is primary, the first refusal is Deny, the rest wait', () => {
  const { allow, deny, more } = approvalLayout(RUN.choices);
  assert.equal(allow.key, 'once');
  assert.equal(deny.key, 'deny');
  assert.deepEqual(
    more.map((c: any) => c.key),
    ['session', 'denyAlways'],
  );
  assert.deepEqual(approvalLayout([]), { allow: null, deny: null, more: [] });
  assert.equal(isApproval(RUN), true);
  assert.equal(isApproval({ ...RUN, kind: 'plan' }), false);
  assert.equal(isApproval({ ...RUN, inApp: true }), false);
  assert.equal(isApproval({ ...RUN, url: 'https://x' }), false);
  assert.equal(isApproval({ ...RUN, questions: [{ id: 'q' }] }), false);
  assert.equal(isApproval({ ...RUN, schema: { properties: {} } }), false);
  assert.equal(isApproval({ ...RUN, choices: [] }), false);
  assert.equal(isApproval({ id: 1, rev: 1, title: 't' }), false);
});

test('an approval shows the exact command, Deny and Allow once, and the card’s other choices under More options', async () => {
  const t = thread([RUN]);
  const v = await mount(t.node);
  assert.match(v.host.textContent!, /Run this command\?/);
  assert.match(v.host.textContent!, /npm test -- auth/);
  assert.deepEqual(buttons(v.host), ['Deny', 'Allow once', 'More options']);
  assert.doesNotMatch(v.host.textContent!, /Always deny/);
  await click('More options');
  assert.deepEqual(buttons(v.host), ['Deny', 'Allow once', 'Allow for this session', 'Always deny', 'Deny with comment']);
  await click('Allow for this session');
  assert.deepEqual(t.calls.at(-1), ['card.answer', { chatId: 'c', cardId: 'a', rev: 1, key: 'session', values: undefined }]);
  // the answer is in: the card leaves a quiet line saying what was chosen, with the command
  assert.match(v.host.textContent!, /Allow for this session · answered on this iPhone/);
  assert.match(v.host.textContent!, /npm test -- auth/);
  assert.equal(v.host.querySelector('button[aria-label="Allow once"]'), null);
  await v.done();
});

test('Deny with comment refuses with the card’s Deny and asks the composer what to do instead', async () => {
  const t = thread([RUN]);
  const v = await mount(t.node);
  await click('More options');
  await click('Deny with comment');
  assert.equal(t.calls.at(-1)[1].key, 'deny');
  assert.equal((v.host.querySelector('input') as HTMLInputElement).placeholder, 'Tell it what to do instead');
  // a refusal is marked as one
  assert.match(v.host.textContent!, /✕Deny · answered on this iPhone/);
  await v.done();
});

test('a refused answer leaves the card answerable and Deny with comment does not take the composer', async () => {
  const t = thread([RUN], () => {
    throw new Error('Allow this from your Mac.');
  });
  const v = await mount(t.node);
  await click('More options');
  await click('Deny with comment');
  assert.match(v.host.textContent!, /Allow this from your Mac\./);
  assert.equal((v.host.querySelector('input') as HTMLInputElement).placeholder, 'Message this chat');
  assert.ok(buttons(v.host).includes('Allow once'));
  await v.done();
});

test('a tap while an answer is in flight sends nothing more', async () => {
  let release: (v: boolean) => void = () => {};
  const answers: string[] = [];
  const v = await mount(
    createElement(ApprovalCard, {
      card: RUN,
      comment: () => {},
      answer: (key: string) => (answers.push(key), new Promise<boolean>((r) => (release = r))),
    }),
  );
  await click('Allow once');
  const button = [...v.host.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Deny')!;
  await act(async () => button.click());
  assert.deepEqual(answers, ['once']);
  await act(async () => release(false));
  assert.equal(button.getAttribute('aria-disabled'), 'false', 'a refused answer gives the buttons back');
  await v.done();
});

test('while the Mac is away the buttons are off and the card says to answer once it is back', async () => {
  const state = { phase: 'offline', selectedPair: 'p', pairs: [{ pairId: 'p', name: 'Studio' }], presence: {} };
  const v = await mount(
    createElement(MacLinkProvider, { state }, createElement(ApprovalCard, { card: RUN, comment: () => {}, answer: async () => true })),
  );
  assert.match(v.host.textContent!, /Your computer is offline\. Answer here once it reconnects, or on the computer\./);
  const allow = [...v.host.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Allow once')!;
  assert.equal(allow.getAttribute('aria-disabled'), 'true');
  await v.done();
});

test('a card the machine itself brought is answered with the Mac away: its buttons are on and no offline line is said (#4717)', async () => {
  const state = { phase: 'offline', selectedPair: 'p', pairs: [{ pairId: 'p', name: 'Studio' }], presence: {} };
  const answered: string[] = [];
  const v = await mount(
    createElement(
      MacLinkProvider,
      { state },
      createElement(ApprovalCard, {
        card: { ...RUN, viaMachine: true },
        comment: () => {},
        answer: async (key: string) => (answered.push(key), true),
      }),
    ),
  );
  assert.doesNotMatch(v.host.textContent!, /Your computer is offline/);
  const allow = [...v.host.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Allow once')!;
  assert.equal(allow.getAttribute('aria-disabled'), 'false');
  await click('Allow once');
  assert.deepEqual(answered, ['once']);
  await v.done();
});

test('a card with only allows has no Deny and no More options; one with only a refusal offers just that', async () => {
  const only = await mount(
    createElement(ApprovalCard, {
      card: { id: 1, rev: 1, title: 'Go?', choices: [{ key: 'ok', label: 'Allow' }] },
      comment: () => {},
      answer: async () => true,
    }),
  );
  assert.deepEqual(buttons(only.host, 'Go?'), ['Allow']);
  assert.doesNotMatch(only.host.textContent!, /npm/);
  await only.done();
  const no = await mount(
    createElement(ApprovalCard, {
      card: { id: 2, rev: 1, title: 'Stop?', choices: [{ key: 'n', label: 'Deny', deny: true }] },
      comment: () => {},
      answer: async () => true,
    }),
  );
  assert.deepEqual(buttons(no.host, 'Stop?'), ['Deny', 'More options']);
  await act(async () => (no.host.querySelectorAll('button')[1] as HTMLElement).click());
  assert.deepEqual(buttons(no.host, 'Stop?'), ['Deny', 'Deny with comment']);
  await no.done();
});

test('an approval answered on the Mac says so, naming the question when there is no command', async () => {
  const v = await mount(createElement(ResolvedApproval, { card: { id: 1, rev: 1, title: 'Open the port?' }, by: 'mac' }));
  assert.match(v.host.textContent!, /✓Answered on your MacOpen the port\?/);
  assert.equal(v.host.querySelector('[aria-label]')!.getAttribute('aria-label'), 'Answered on your Mac: Open the port?');
  await v.done();
});

test('a sub-session opened from its parent sits over the parent in the stack', () => {
  const nav = { momo: false, settings: false, newChat: false, scheduled: false, answer: null, pairing: false, top: null };
  const keys = (n: object) => stackOf({ ...nav, ...n }).map((r: { key: string }) => r.key);
  assert.deepEqual(keys({ chat: 'child', trail: ['parent'] }), ['home', 'chat:parent', 'chat:child']);
  assert.deepEqual(keys({ chat: 'child', trail: ['parent'], top: 'review' }), ['home', 'chat:parent', 'chat:child', 'review:child']);
  assert.deepEqual(keys({ chat: 'c' }), ['home', 'chat:c']);
});

test('two taps before the card redraws send one answer; Deny answers with the card’s refusal', async () => {
  const answers: string[] = [];
  const v = await mount(
    createElement(ApprovalCard, { card: RUN, comment: () => {}, answer: async (key: string) => (answers.push(key), false) }),
  );
  const pill = (label: string) => [...v.host.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === label) as HTMLElement;
  await act(async () => {
    pill('Allow once').click();
    pill('Allow once').click();
  });
  assert.deepEqual(answers, ['once']);
  await act(async () => pill('Deny').click());
  assert.deepEqual(answers, ['once', 'deny']);
  await v.done();
  const bare = await mount(
    createElement(ApprovalCard, { card: { id: 3, rev: 1, title: 'Nothing to pick' }, comment: () => {}, answer: async () => true }),
  );
  assert.deepEqual(buttons(bare.host, 'Nothing to pick'), []);
  await bare.done();
});

test('the bar names a sub-session’s parent, else the agent and project', async () => {
  const trailPath = '../mobile/src/useChatTrail';
  const { chatHeading } = await import(trailPath);
  const chats = [
    { id: 'p', title: '', harness: 'claude', project: 'app' },
    { id: 'c', title: 'Child', parentId: 'p' },
    { id: 'x', title: 'Other' },
  ];
  assert.deepEqual(chatHeading(chats, 'c'), { title: 'Child', subtitle: 'Sub-session of Untitled chat' });
  assert.deepEqual(chatHeading(chats, 'p'), { title: undefined, subtitle: 'Claude Code · app' });
  assert.deepEqual(chatHeading(chats, 'x'), { title: 'Other', subtitle: undefined });
  assert.deepEqual(chatHeading(chats, null), { title: undefined, subtitle: undefined });
  assert.deepEqual(chatHeading(null, 'c'), { title: undefined, subtitle: undefined });
});
