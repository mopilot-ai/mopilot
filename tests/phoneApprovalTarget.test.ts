// A browser approval says where its action goes: the Mac sends only the label it made (never the url), and the phone's card shows "To: <label>", or no line when there is none.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { act, createElement, createRoot, flush } from './support/phone/component-kit';

const require = createRequire(import.meta.url);
const { hostCard } = require('../electron/capabilities/browser/chromePanelHostCard.cjs');
const approvalPath = '../mobile/src/components/ApprovalCard';
const requestPath = '../mobile/src/components/RequestCard';
const { ApprovalCard } = await import(approvalPath);
const { RequestCard } = await import(requestPath);

const SITE = {
  kind: 'computerConfirm',
  verb: 'act on a high-risk site',
  origin: 'shop.example',
  summary: 'Click "Place order"',
  task: true,
};
// userinfo in a url can pass for another site: it must never reach a phone
const SPOOF = 'https://accounts.google.com@evil.example/pay?x=1';
const TARGET = { url: SPOOF, page: 'https://shop.example/cart', label: 'evil.example' };

test('the Mac sends the destination as its label alone', () => {
  const card = hostCard({ ...SITE, actionTarget: TARGET }, 'Claude Code');
  assert.equal(card.to, 'evil.example');
  assert.ok(!JSON.stringify(card).includes('accounts.google.com'), 'the url, with its userinfo, is not in the card');
  assert.ok(!JSON.stringify(card).includes(SPOOF));
});

test('a confirmation without a usable label has no destination', () => {
  assert.ok(!('to' in hostCard({ ...SITE }, 'Claude Code')), 'no actionTarget');
  assert.ok(!('to' in hostCard({ ...SITE, actionTarget: { url: SPOOF, page: 'p' } }, 'Claude Code')), 'no label');
  for (const label of [42, null, {}, ['evil.example'], '', '   ']) {
    const card = hostCard({ ...SITE, actionTarget: { ...TARGET, label } }, 'Claude Code');
    assert.ok(!('to' in card), `label ${JSON.stringify(label)} is not shown`);
    assert.ok(!JSON.stringify(card).includes(SPOOF), 'and the url still does not leak');
  }
});

async function mount(card: any, Card: any = ApprovalCard) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(Card, { card, comment: () => {}, answer: async () => true })));
  await flush();
  return {
    host,
    done: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}
const CARD = {
  id: 'a',
  rev: 1,
  title: 'Allow Claude Code to act on a high-risk site?',
  detail: 'Click "Place order"',
  choices: [
    { key: 'once', label: 'Allow once' },
    { key: 'deny', label: 'Deny', deny: true },
  ],
};
const spans = (host: HTMLElement) => [...host.querySelectorAll('span')].map((s) => s.textContent);

// the chat's own card, and the card in the Needs-you sheet (RequestCard, drawn bare): both are where someone answers
const RENDERERS: [string, any, any][] = [
  ['the chat card', ApprovalCard, {}],
  ['the Needs-you sheet card', RequestCard, { bare: true }],
];

for (const [where, Card] of RENDERERS) {
  test(`${where} shows "To: <label>" between the question and the command`, async () => {
    const v = await mount({ ...CARD, to: 'evil.example' }, Card);
    const shown = spans(v.host);
    const at = shown.indexOf('To: evil.example');
    assert.ok(at > shown.indexOf(CARD.title), 'after the question');
    assert.ok(at < shown.indexOf(CARD.detail), 'before the command');
    await v.done();
  });

  test(`${where} has no line without a label, or with one that is not a string`, async () => {
    for (const to of [undefined, null, '', '   ', 42, {}, ['evil.example']]) {
      const v = await mount({ ...CARD, to }, Card);
      assert.ok(!v.host.textContent!.includes('To:'), `to ${JSON.stringify(to)} draws nothing`);
      assert.ok(spans(v.host).includes(CARD.title), 'the card itself is still there');
      await v.done();
    }
  });
}

test('an answered card keeps its title and loses the destination line with its buttons', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      createElement(RequestCard, {
        card: { ...CARD, to: 'evil.example' },
        answer: async () => true,
        receipt: { by: 'phone', choice: 'Allow once' },
      }),
    ),
  );
  await flush();
  assert.ok(!host.textContent!.includes('To:'));
  await act(async () => root.unmount());
  host.remove();
});
