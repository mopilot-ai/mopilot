// The Chrome side panel's Retry under the last reply (electron/chrome-extension/src/panelRetry.mjs, panelThread.mjs, and its send in sidePanel.mjs): which message it sends again, when it is off, and that a Retry never touches what is in the message box.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tick } from './support/extension-background/fixture.ts';
import { el, panelPage } from './support/side-panel-page.ts';

const { retryTarget, mayRetry, RetrySlot } = await import('../electron/chrome-extension/src/panelRetry.mjs');
const { PanelThread } = await import('../electron/chrome-extension/src/panelThread.mjs');
const { startSidePanel } = await import('../electron/chrome-extension/src/sidePanel.mjs');

const user = (text: string, more: object = {}) => ({ role: 'user', text, ...more });
const reply = (text: string) => ({ role: 'assistant', text });

test('Retry is for the last reply and the message it answers, and for nothing a resend would get wrong', () => {
  assert.equal(retryTarget([]), null);
  assert.deepEqual(retryTarget([user('Q'), reply('A')]), { index: 1, text: 'Q' });
  // steps and notes between them don't matter; the last reply and the last message before it do
  assert.deepEqual(retryTarget([user('Q1'), reply('A1'), user('Q2'), { role: 'step', text: 'Used x' }, reply('A2a'), reply('A2b')]), {
    index: 5,
    text: 'Q2',
  });
  // no reply yet, a reply with no message before it, a message after the reply (the newer turn's)
  assert.equal(retryTarget([user('Q')]), null);
  assert.equal(retryTarget([reply('A')]), null);
  assert.equal(retryTarget([user('Q'), reply('A'), user('Next')]), null);
  // a message main clipped would go out shorter than it was written; an empty one has nothing to send
  assert.equal(retryTarget([user('Q…', { truncated: true }), reply('A')]), null);
  assert.equal(retryTarget([user('  '), reply('A')]), null);
});

test('Retry sends only while the chat is idle and no message like it is waiting to be written', () => {
  assert.equal(mayRetry('idle', [], 'Q'), true);
  assert.equal(mayRetry('idle', ['other'], 'Q'), true);
  assert.equal(mayRetry('running', [], 'Q'), false);
  assert.equal(mayRetry('waiting', [], 'Q'), false);
  assert.equal(mayRetry('idle', ['Q'], 'Q'), false);
});

test('the one Retry button follows the newest reply and leaves with it', () => {
  const doc = { createElement: el };
  const slot = new RetrySlot(doc);
  const [a, b] = [el(), el()];
  assert.deepEqual(
    [slot.button.className, slot.button.attrs['aria-label'], slot.button.title],
    ['message-copy message-retry', 'Retry', 'Send your last message again'],
  );
  slot.place(a, 'Q1', false);
  assert.deepEqual(a.children, [slot.button]);
  assert.deepEqual([slot.button.dataset.panelRetry, slot.button.disabled], ['Q1', false]);
  // the same reply again: not added twice; a turn running turns it off
  slot.place(a, 'Q1', true);
  assert.deepEqual([a.children.length, slot.button.disabled], [1, true]);
  slot.place(b, 'Q2', false);
  assert.deepEqual([a.children.length, b.children, slot.button.dataset.panelRetry], [0, [slot.button], 'Q2']);
  slot.place(null, undefined, false);
  assert.deepEqual([b.children.length, slot.button.dataset.panelRetry], [0, '']);
});

/** A thread on a fake document, its reads answered by the test. */
function thread() {
  const els: Record<string, any> = {};
  const document = {
    getElementById: (id: string) => (els[id] ??= el()),
    createElement: (tag: string) => el(tag),
    createTextNode: (text: string) => ({ textContent: text }),
  };
  const retries: string[] = [];
  const t = new PanelThread({
    document,
    request: async () => ({}),
    onError: () => undefined,
    onOpen: () => undefined,
    onRetry: (text: string) => retries.push(text),
  });
  const bearer = () => els.rows.children.filter((c: any) => c.children.includes(t.retry.button));
  return { t, els, retries, bearer };
}

test('a finished chat has Retry beside Copy under its last reply only, off while a turn runs', () => {
  const { t, retries, bearer } = thread();
  t.render([user('Q1'), reply('A1'), user('Q2'), reply('A2')], false);
  const [last] = bearer();
  assert.equal(last.textContent, 'A2');
  // beside Copy: after it, in the reply
  assert.deepEqual(
    last.children.slice(-2).map((c: any) => c.className),
    ['message-copy', 'message-copy message-retry'],
  );
  assert.equal(bearer().length, 1);
  assert.equal(t.retry.button.dataset.panelRetry, 'Q2');
  assert.equal(t.retry.button.disabled, false);
  t.retry.button.listeners.click();
  assert.deepEqual(retries, ['Q2']);
  // a turn runs: off, and a click that gets through does nothing
  t.turn('running');
  assert.equal(t.retry.button.disabled, true);
  t.retry.button.listeners.click();
  t.turn('waiting');
  assert.equal(t.retry.button.disabled, true);
  t.turn('idle');
  assert.equal(t.retry.button.disabled, false);
  assert.deepEqual(retries, ['Q2']);
  // a message sent and not written yet follows the last reply: no Retry for the earlier turn, and none a second time
  t.sending('Q3');
  assert.equal(bearer().length, 0);
  t.render([user('Q1'), reply('A1'), user('Q2'), reply('A2')], false);
  assert.equal(t.retry.host, null);
});

test('a copy of the message already waiting is not sent again, and the reply that is not the last has no Retry', () => {
  const { t, retries, bearer } = thread();
  t.render([user('Q'), reply('A')], false);
  t.sent = ['Q'];
  t.retry.button.listeners.click();
  assert.deepEqual(retries, []);
  t.sent = [];
  // the next reply takes the button from the one before
  const first = bearer()[0];
  t.render([user('Q'), reply('A'), user('Q2'), reply('A2')], false);
  assert.equal(first.children.includes(t.retry.button), false);
  assert.equal(bearer()[0].textContent, 'A2');
  assert.deepEqual(t.retry.button.dataset.panelRetry, 'Q2');
});

test('a chat whose last message is clipped or unanswered has no Retry at all', () => {
  const { t, bearer } = thread();
  t.render([user('Q…', { truncated: true }), reply('A')], false);
  assert.equal(bearer().length, 0);
  t.render([user('Q')], false);
  assert.equal(bearer().length, 0);
});

/** The panel on a chat with one finished turn; the test sees each send and chooses how it answers. */
async function chat(o: { sendAnswer?: () => any } = {}) {
  let rows: any[] = [];
  let state = 'idle';
  const p = panelPage({
    reply: (m: any) => {
      if (m.type !== 'panel') return { status: 'connected' };
      if (m.method === 'harnesses') return { status: 'connected', result: { harnesses: [{ id: 'claude', label: 'Claude Code' }] } };
      if (m.method === 'start') return { status: 'connected', result: { chatId: 'c1' } };
      if (m.method === 'send') return o.sendAnswer?.() ?? { status: 'connected', result: {} };
      return { status: 'connected', result: { rows, state } };
    },
  });
  await startSidePanel(p.g).ready;
  await tick();
  p.els.text.value = 'First question';
  p.els.composer.listeners.submit({ preventDefault: () => undefined });
  await tick();
  await tick();
  rows = [user('First question'), reply('The answer')];
  p.chrome.runtime.onMessage.fire({ type: 'panelEvent', event: { kind: 'turn', chatId: 'c1', state: 'idle' } });
  await tick();
  await tick();
  const sends = () => p.sent().filter((m: any) => m.method === 'send');
  const rowTexts = () => p.els.rows.children.map((r: any) => r.textContent);
  return { p, sends, rowTexts };
}

test('Retry sends the last message again through the panel’s send, leaving the box, and goes off at once', async () => {
  const { p, sends } = await chat();
  // a draft being written, files and all, is not what Retry sends or clears
  p.els.text.value = 'my draft';
  const button = p.els.rows.children.find((r: any) => r.className === 'reply').children.at(-1);
  assert.equal(button.className, 'message-copy message-retry');
  button.listeners.click();
  // shown at once, once more, with the turn running: Retry is off and a second click is no second send
  assert.deepEqual(
    p.els.rows.children.map((r: any) => r.textContent),
    ['First question', 'The answer', 'First question'],
  );
  assert.equal(button.disabled, true);
  button.listeners.click();
  await tick();
  await tick();
  assert.equal(sends().length, 1);
  assert.deepEqual(sends().at(-1).params.text, 'First question');
  assert.equal(sends().at(-1).params.chatId, 'c1');
  assert.equal(p.els.text.value, 'my draft');
  assert.equal(p.els.error.hidden, true);
});

test('a Retry that fails is kept in the error block, not the box; the message goes back out of the rows', async () => {
  const { p, rowTexts } = await chat({ sendAnswer: () => ({ status: 'connected', error: "That chat isn't in MoPilot." }) });
  p.els.text.value = 'my draft';
  p.els.rows.children
    .find((r: any) => r.className === 'reply')
    .children.at(-1)
    .listeners.click();
  await tick();
  await tick();
  assert.deepEqual(rowTexts(), ['First question', 'The answer']);
  assert.equal(p.els.text.value, 'my draft');
  // the reason, and the message kept apart from the box
  const kept = p.els.error.children.find((c: any) => c.className === 'message-recovery');
  assert.match(kept.textContent, /Message needs review/);
  assert.match(kept.textContent, /Message: First question/);
});

test('a Retry whose delivery is unconfirmed leaves the box alone and says so', async () => {
  const { p } = await chat({
    sendAnswer: () => ({ status: 'connected', error: 'Delivery is unconfirmed.', code: 'delivery_unconfirmed' }),
  });
  p.els.text.value = 'my draft';
  p.els.rows.children
    .find((r: any) => r.className === 'reply')
    .children.at(-1)
    .listeners.click();
  await tick();
  await tick();
  assert.equal(p.els.text.value, 'my draft');
  assert.match(p.els.error.children.find((c: any) => c.className === 'message-recovery').textContent, /Delivery is unconfirmed/);
});
