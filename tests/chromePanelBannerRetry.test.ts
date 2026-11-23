// Retry on the side panel's error banner (B6): offered only for a failure of the transport, and it reuses the send and first-read paths (nothing is sent twice).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { panelPage } from './support/side-panel-page.ts';
import { fakeTimers, tick } from './support/extension-background/fixture.ts';

const { PanelLink, CONNECTION_LOST, REQUEST_MS } = await import('../electron/chrome-extension/src/panelLink.mjs');
const { startSidePanel } = await import('../electron/chrome-extension/src/sidePanel.mjs');

const lost = { status: 'connected', error: "MoPilot isn't connected.", code: CONNECTION_LOST };

/** A panel that answers 'send', 'start' and 'read' as the test says (anything else as the fake page does). */
async function setup(answer: Record<string, (n: number) => any>) {
  const p = panelPage();
  const calls: Record<string, number> = {};
  const base = p.chrome.reply;
  p.chrome.reply = (m: any) => {
    if (m.type === 'panel' && answer[m.method]) {
      calls[m.method] = (calls[m.method] ?? 0) + 1;
      return answer[m.method](calls[m.method]);
    }
    return base(m);
  };
  await startSidePanel(p.g).ready;
  await tick();
  const submit = () => p.els.composer.listeners.submit({ preventDefault() {} });
  const type = (text: string) => {
    p.els.text.value = text;
    p.els.text.listeners.input();
  };
  const retry = () => p.els.error.children[0]?.children.find((c: any) => c.className === 'banner-retry');
  return { p, calls, submit, type, retry };
}

test('a follow-up the transport lost goes back to the box with Retry, and Retry sends it once', async () => {
  const f = await setup({
    start: () => ({ status: 'connected', result: { chatId: 'chat-9' } }),
    send: (n) => (n === 1 ? lost : { status: 'connected', result: {} }),
  });
  f.type('First question');
  await f.submit();
  await tick();
  f.type('Follow up');
  await f.submit();
  await tick();
  assert.equal(f.p.els.text.value, 'Follow up', 'the text is back in the box');
  assert.match(f.p.els.error.textContent, /isn't connected/);
  assert.ok(f.retry(), 'a lost connection is one Retry can run again');
  const link = f.retry();
  link.listeners.click();
  link.listeners.click();
  await tick();
  assert.equal(f.calls.send, 2, 'the follow-up was sent again once: two pressed Retry still sent one');
  assert.equal(f.p.els.text.value, '', 'it went, so the box is empty');
  assert.equal(f.p.els.error.hidden, true);
});

test('Retry on a new chat that could not start tries to start it again, once', async () => {
  const f = await setup({ start: (n) => (n === 1 ? lost : { status: 'connected', result: { chatId: 'chat-9' } }) });
  f.type('A new question');
  await f.submit();
  await tick();
  assert.equal(f.p.els.text.value, 'A new question');
  f.retry().listeners.click();
  await tick();
  assert.equal(f.calls.start, 2);
  assert.equal(f.p.els.text.value, '');
  assert.equal(f.p.els.error.hidden, true);
});

test('no Retry for a refusal, nor for a send whose delivery is unconfirmed', async () => {
  const f = await setup({
    start: () => ({ status: 'connected', result: { chatId: 'chat-9' } }),
    send: (n) =>
      n === 1
        ? { status: 'connected', error: 'Another chat is working in this tab.' }
        : { status: 'connected', error: 'Delivery is unconfirmed. Check the chat before sending again.', code: 'delivery_unconfirmed' },
  });
  f.type('First question');
  await f.submit();
  await tick();
  f.type('Refused');
  await f.submit();
  await tick();
  assert.match(f.p.els.error.textContent, /Another chat is working/);
  assert.equal(f.retry(), undefined, 'a refusal would only be refused again');
  f.type('Unconfirmed');
  await f.submit();
  await tick();
  assert.match(f.p.els.error.textContent, /Delivery is unconfirmed/);
  assert.equal(f.retry(), undefined, 'main may already have the message: a resend could send it twice');
});

test('a failed first read offers Retry on the banner as well as Try again, and both read the chat again', async () => {
  const f = await setup({
    start: () => ({ status: 'connected', result: { chatId: 'chat-9' } }),
    read: (n) => (n === 1 ? lost : { status: 'connected', result: { rows: [], state: 'idle' } }),
  });
  f.type('Open it');
  await f.submit();
  await tick();
  assert.equal(f.p.els['load-error'].hidden, false, 'the thread offers Try again');
  assert.ok(f.retry(), 'and so does the banner');
  f.retry().listeners.click();
  await tick();
  assert.equal(f.calls.read, 2);
  assert.equal(f.p.els['load-error'].hidden, true);
  assert.equal(f.p.els.loading.hidden, true, 'the rows are in');
  assert.equal(f.p.els.error.hidden, true);
});

test('a read that fails with the chat already on screen retries without bringing the spinner back; a refusal offers no Retry', async () => {
  let fail = false;
  const f = await setup({
    start: () => ({ status: 'connected', result: { chatId: 'chat-9' } }),
    read: () => (fail ? lost : { status: 'connected', result: { rows: [], state: 'idle' } }),
  });
  f.type('Open it');
  await f.submit();
  await tick();
  fail = true;
  f.p.els['load-again'].listeners.click();
  await tick();
  assert.ok(f.retry());
  fail = false;
  f.retry().listeners.click();
  await tick();
  assert.equal(f.p.els.error.hidden, true);
  assert.equal(f.p.els.loading.hidden, true);
  f.p.els['load-again'].listeners.click();
  assert.equal(f.p.els.loading.hidden, true, 'a chat that is loaded shows no spinner for a Try again');
});

test('the link marks what it lost, and only what main has not answered, as a transport failure', async () => {
  const timers: any = fakeTimers();
  let up = false;
  const link = new PanelLink({ send: () => undefined, connected: () => up, timers });
  const code = async (p: Promise<unknown>) =>
    (
      await p.then(
        () => ({}),
        (e: any) => e,
      )
    ).code;
  assert.equal(await code(link.request('read')), CONNECTION_LOST, 'not connected');
  up = true;
  const read = link.request('read');
  timers.timeouts.find((t: any) => t.ms === REQUEST_MS)?.f();
  assert.equal(await code(read), CONNECTION_LOST, 'no answer to a read');
  const dropped = link.request('read');
  link.drop();
  assert.equal(await code(dropped), CONNECTION_LOST, 'the connection went with a read waiting');
  // a send main may already hold is never one Retry may run again
  const sent = link.request('send');
  link.drop();
  assert.equal(await code(sent), 'delivery_unconfirmed');
});
