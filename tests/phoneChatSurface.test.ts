// Where a chat works and what only the Mac can finish: the header's "Working in <site or app>", the Mac's own waiting cards with nothing to press, the cards the Mac re-sends as a hand-off begins or ends, and a choice that must be held.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot, flush } from './support/phone/component-kit';

import { fakeDraft } from './support/phone/drafts';
const surfacePath = '../mobile/src/remote/useSurface';
const threadPath = '../mobile/src/presentation/thread';
const cardsPath = '../mobile/src/components/ChatCards';
const approvalPath = '../mobile/src/components/ApprovalCard';
const threadScreenPath = '../mobile/src/screens/Thread';
const requestPath = '../mobile/src/components/RequestCard';
const uiPath = '../mobile/src/components/ui';
const { surfaceLine, useSurface } = await import(surfacePath);
const { snapshot, update } = await import(threadPath);
const { ChatCards } = await import(cardsPath);
const { ApprovalCard } = await import(approvalPath);
const { Thread } = await import(threadScreenPath);
const { withOutbox } = await import('./support/phone/outbox-kit');
const { RequestCard } = await import(requestPath);
const { HOLD_MS } = await import(uiPath);

async function mount(node: any) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(node));
  await flush();
  return {
    host,
    root,
    done: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

test('the surface line names the site, else the page, else the app; nothing before the chat has worked anywhere', () => {
  assert.equal(surfaceLine({ kind: 'iab', title: 'Shop', origin: 'https://shop.example.com' }), 'Working in shop.example.com');
  assert.equal(surfaceLine({ kind: 'chrome', title: 'Inbox' }), 'Working in Inbox');
  assert.equal(surfaceLine({ kind: 'chrome', origin: 'not a url' }), 'Working in not a url');
  assert.equal(
    surfaceLine({ kind: 'iab', origin: 'file:///tmp/page.html' }),
    'Working in file:///tmp/page.html',
    'a page with no host is named as it is',
  );
  assert.equal(surfaceLine({ kind: 'desktop', app: { name: 'Notes', bundleId: 'com.apple.Notes' } }), 'Working in Notes');
  assert.equal(surfaceLine({ kind: 'desktop', title: 'Untitled' }), null, 'a desktop app is named by its app, not a window title');
  for (const nothing of [{}, null, 'x', { kind: 'iab' }, { kind: 'iab', title: '  ' }]) assert.equal(surfaceLine(nothing), null);
});

function Probe({ request, running, steps, out }: any) {
  out.line = useSurface(request, 'c', running, steps);
  return null;
}

test('the line is read while a turn runs, again as steps land, and is gone when it ends; a late or failed read changes nothing', async () => {
  const out: { line: string | null } = { line: 'unset' };
  const reads: string[] = [];
  let answer: (v: unknown) => void = () => undefined;
  const request = (method: string, params: any) => {
    reads.push(`${method}:${params.chatId}`);
    return new Promise((resolve) => (answer = resolve));
  };
  const v = await mount(createElement(Probe, { request, running: false, steps: 0, out }));
  assert.equal(out.line, null);
  assert.deepEqual(reads, [], 'a chat that is not working asks nothing');
  await act(async () => v.root.render(createElement(Probe, { request, running: true, steps: 1, out })));
  assert.deepEqual(reads, ['surface.current:c']);
  await act(async () => answer({ kind: 'iab', origin: 'https://a.test' }));
  assert.equal(out.line, 'Working in a.test');
  // a new step reads again; the older answer, arriving late, is not shown
  await act(async () => v.root.render(createElement(Probe, { request, running: true, steps: 2, out })));
  const first = answer;
  await act(async () => v.root.render(createElement(Probe, { request, running: true, steps: 3, out })));
  await act(async () => first({ kind: 'iab', origin: 'https://stale.test' }));
  assert.equal(out.line, 'Working in a.test');
  await act(async () => answer({ kind: 'iab', origin: 'https://b.test' }));
  assert.equal(out.line, 'Working in b.test');
  // the turn ends: the line goes, and an answer that comes after is dropped
  await act(async () => v.root.render(createElement(Probe, { request, running: false, steps: 3, out })));
  assert.equal(out.line, null);
  await act(async () => answer({ kind: 'iab', origin: 'https://c.test' }));
  assert.equal(out.line, null);
  await v.done();
  const failing = { line: 'unset' as string | null };
  const f = await mount(
    createElement(Probe, { request: () => Promise.reject(new Error('Update your computer.')), running: true, steps: 1, out: failing }),
  );
  await flush();
  assert.equal(failing.line, null, 'a Mac without surface.current leaves the header as it was');
  await f.done();
});

test('cards.changed replaces the cards as a snapshot does, and an older or malformed one changes nothing', () => {
  const base = snapshot({
    items: [],
    session: { turn: 'idle', cards: [{ id: 'a', rev: 1, title: 'Old' }] },
    rev: 5,
    itemsShape: 'rows',
    feedSeq: 0,
  });
  const wait = { id: 'w', rev: 1, title: 'Sign in', where: 'mac-only', waitingCopy: 'Waiting for you on your Mac: sign in to shop.test' };
  const next = update(base, { ev: 'cards.changed', chatId: 'c', rev: 6, cards: [wait] });
  assert.deepEqual(next.session.cards, [wait]);
  assert.equal(next.rev, 6);
  assert.equal(
    update(next, { ev: 'cards.changed', rev: 6, cards: [] }).session.cards.length,
    0,
    'the same revision applies: the hand-off ended',
  );
  assert.equal(update(next, { ev: 'cards.changed', rev: 5, cards: [] }), next, 'older than what the phone has');
  assert.equal(update(next, { ev: 'cards.changed', rev: 7, cards: 'x' }), next);
  assert.equal(update(next, { ev: 'cards.changed', cards: [] }), next);
});

const cardsOf = (shown: any[]) => ({
  shown,
  settled: {},
  receipts: {},
  closedPlans: [],
  isOpenPlan: () => false,
  openPlan: () => undefined,
  answerCard: async () => true,
  comment: () => undefined,
});

test('a card only the Mac finishes shows the Mac’s words and nothing to press', async () => {
  const v = await mount(
    createElement(
      'div',
      null,
      createElement(ChatCards, {
        cards: cardsOf([
          {
            id: 'p',
            rev: 1,
            title: 'Confirm',
            where: 'mac-only',
            waitingCopy: 'Waiting for you on your Mac: confirm the payment on shop.test',
            choices: [{ key: 'ok', label: 'Pay' }],
          },
          { id: 'q', rev: 1, title: 'Complete the check', where: 'mac-only' },
        ]),
      }),
    ),
  );
  assert.match(v.host.textContent!, /Waiting for you on your Mac: confirm the payment on shop\.test/);
  assert.match(v.host.textContent!, /Complete the check/, 'with no copy of its own it says its title');
  assert.equal(v.host.querySelectorAll('button').length, 0, 'not even the choices the card carries');
  await v.done();
});

test('a choice that must be held answers only to a long press, and says so', async () => {
  const picked: string[] = [];
  const take = async (key: string) => {
    picked.push(key);
    return true;
  };
  const card = {
    id: 'a',
    rev: 1,
    title: 'Allow this purchase?',
    choices: [
      { key: 'no', label: 'Deny', deny: true },
      { key: 'yes', label: 'Allow', hold: true },
      { key: 'once', label: 'Allow once', hold: true },
    ],
  };
  const v = await mount(createElement(ApprovalCard, { card, answer: take, comment: () => {} }));
  const allow = v.host.querySelector('button[aria-label="Allow"]') as any;
  assert.equal(allow.getAttribute('aria-description'), 'Press and hold to confirm');
  assert.match(allow.textContent, /Hold to confirm/);
  await act(async () => allow.click());
  assert.deepEqual(picked, [], 'a tap does nothing');
  assert.equal(allow.__press.delayLongPress, HOLD_MS);
  // a screen reader's double tap is a plain press, so the held choice is offered to it as the long press action
  assert.deepEqual(allow.__press.accessibilityActions, [{ name: 'longpress' }]);
  await act(async () => allow.__press.onAccessibilityAction());
  await flush();
  assert.deepEqual(picked, ['yes']);
  await act(async () => allow.__press.onLongPress());
  await flush();
  assert.deepEqual(picked, ['yes', 'yes']);
  // the plain Deny is an ordinary tap
  const deny = v.host.querySelector('button[aria-label="Deny"]') as any;
  assert.doesNotMatch(deny.textContent, /Hold/);
  await v.done();
  const more = await mount(createElement(ApprovalCard, { card: { ...card, id: 'b' }, answer: take, comment: () => {} }));
  await act(async () => (more.host.querySelector('button[aria-label="More options"]') as HTMLElement).click());
  const once = more.host.querySelector('button[aria-label="Allow once"]') as any;
  assert.match(once.textContent, /Hold to confirm/);
  await act(async () => once.__press.onLongPress());
  await flush();
  assert.deepEqual(picked, ['yes', 'yes', 'once']);
  await more.done();
});

test('the quick review and a plain request card hold a choice too, in the main button and among the others', async () => {
  const picked: string[] = [];
  const answer = async (key: string) => {
    picked.push(key);
    return true;
  };
  const card = {
    id: 'p',
    rev: 1,
    title: 'Allow this purchase?',
    choices: [
      { key: 'yes', label: 'Allow', hold: true },
      { key: 'no', label: 'Deny', deny: true },
      { key: 'once', label: 'Allow once', hold: true },
    ],
  };
  const v = await mount(createElement(RequestCard, { card, answer }));
  for (const [label, key] of [
    ['Allow', 'yes'],
    ['Allow once', 'once'],
  ]) {
    const button = v.host.querySelector(`button[aria-label="${label}"]`) as any;
    assert.equal(button.getAttribute('aria-description'), 'Press and hold to confirm');
    assert.match(button.textContent, /Hold to confirm/);
    await act(async () => button.click());
    assert.equal(picked.includes(key), false, 'a tap does nothing');
    assert.deepEqual(button.__press.accessibilityActions, [{ name: 'longpress' }]);
    await act(async () => button.__press.onLongPress());
    await flush();
    assert.ok(picked.includes(key));
  }
  const deny = v.host.querySelector('button[aria-label="Deny"]') as any;
  assert.doesNotMatch(deny.textContent, /Hold/);
  assert.equal(deny.__press.onLongPress, undefined, 'an ordinary choice is an ordinary press');
  await v.done();
});

test('a card only the Mac finishes shows the same in the request card, which the quick review draws', async () => {
  const card = {
    id: 'p',
    rev: 1,
    title: 'Confirm',
    where: 'mac-only',
    waitingCopy: 'Waiting for you on your Mac: confirm the payment',
    choices: [{ key: 'ok', label: 'Pay' }],
  };
  const v = await mount(createElement(RequestCard, { card, answer: async () => true }));
  assert.match(v.host.textContent!, /Waiting for you on your Mac: confirm the payment/);
  assert.equal(v.host.querySelectorAll('button').length, 0, 'not even the choice the card carries');
  await v.done();
});

test('the chat header says where a running turn works, and goes back to its agent line when the turn ends', async () => {
  let listener: (e: any) => void = () => {};
  const runtime: any = {
    snapshot: () => ({ selectedPair: 'p', generation: 1 }),
    onEvent: (f: any) => ((listener = f), () => {}),
    request: async (method: string) =>
      method === 'chat.follow'
        ? { rev: 1, feedSeq: 0, session: { turn: 'running', cards: [] }, itemsShape: 'rows', items: [{ role: 'user', text: 'Go' }] }
        : method === 'surface.current'
          ? { kind: 'iab', title: 'Shop', origin: 'https://shop.example.com' }
          : {},
  };
  withOutbox(runtime);
  const v = await mount(createElement(Thread, { runtime, chatId: 'c', back: () => {}, subtitle: 'Codex', drafts: fakeDraft('') }));
  await flush();
  assert.match(v.host.textContent!, /Working in shop\.example\.com/);
  assert.doesNotMatch(v.host.textContent!, /Codex/);
  await act(async () => listener({ kind: 'event', chatId: 'c', ev: 'session.patch', rev: 2, patch: { turn: 'completed' } }));
  await flush();
  assert.doesNotMatch(v.host.textContent!, /Working in/);
  assert.match(v.host.textContent!, /Codex/);
  await v.done();
});
