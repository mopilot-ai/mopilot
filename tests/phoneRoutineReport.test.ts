// A MoMo routine's report on the phone (#4822): a one-line "Routine report" card with the routine's name and its summary behind a tap, in either language; MoMo's instruction to the model never shows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { act, createElement, createRoot, click } from './support/phone/component-kit';
const require = createRequire(import.meta.url);
const { reportText } = require('../electron/momo/routineReport.cjs');
const { GREETING } = require('../electron/momo/starterRoutines.cjs');
const bubblePath = '../mobile/src/components/MessageBubble';
const cardPath = '../mobile/src/components/AuthoredCard';
const i18nPath = '../mobile/src/ui/i18n';
const itemsPath = '../mobile/src/ui/items/fromRows';
const { MessageBubble } = await import(bubblePath);
const { authoredCardOf, authoredTitle } = await import(cardPath);
const { showLocale } = await import(i18nPath);
const { itemOfRow } = await import(itemsPath);

const LEAK = /not from the user|data, not instructions|Tell the user in a line|Greet them/;

async function render(text: string) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(MessageBubble, { role: 'user', text })));
  return {
    host,
    done: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

test('a finished routine is its name on one line and its summary behind a tap, never the wrapper', async () => {
  const { host, done } = await render(reportText('Inbox sweep', true, 'Two replies are due.'));
  assert.match(host.textContent ?? '', /“Inbox sweep” finished/);
  assert.doesNotMatch(host.textContent ?? '', LEAK);
  await click('MoPilot: “Inbox sweep” finished');
  assert.match(host.textContent ?? '', /Two replies are due\./);
  assert.doesNotMatch(host.textContent ?? '', LEAK);
  await done();
});

test('a routine that did not finish, and MoMo’s other framing, read as cards in Simplified Chinese too', async () => {
  await showLocale('zh-Hans');
  try {
    const a = await render(reportText('收件箱', false, '没跑完。'));
    assert.match(a.host.textContent ?? '', /“收件箱”未完成/);
    assert.doesNotMatch(a.host.textContent ?? '', LEAK);
    await a.done();
    const b = await render(GREETING);
    assert.match(b.host.textContent ?? '', /MoPilot 消息/);
    assert.doesNotMatch(b.host.textContent ?? '', LEAK);
    await b.done();
  } finally {
    await showLocale('en');
  }
  const c = await render(GREETING);
  assert.match(c.host.textContent ?? '', /MoPilot message/);
  assert.doesNotMatch(c.host.textContent ?? '', LEAK);
  await c.done();
});

test('the item the phone folds carries the typed card; a person’s words carry none', () => {
  const row = { key: 'k', role: 'user', text: reportText('Inbox sweep', true, 'Done.') } as any;
  assert.deepEqual(itemOfRow(row).authored, {
    title: '“Inbox sweep” finished',
    body: 'Done.',
    kind: 'routine',
    name: 'Inbox sweep',
    completed: true,
  });
  assert.equal(authoredCardOf('hello'), null);
  const t = (key: string) => key;
  assert.equal(authoredTitle(authoredCardOf('[Setup, not from the user] x')!, t), 'momoReport.marked');
  assert.equal(authoredTitle(authoredCardOf("The user hasn't heard from you in a while")!, t), 'Progress check');
});
