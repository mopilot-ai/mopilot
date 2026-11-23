// A message a machine's Host refused, seen from a phone that goes through the Mac (#4787): the chat shows it as not sent with the Host's reason and Retry (sent again through the Mac) and Cancel, a chat that moved says so with Cancel only, a machine that is away or a sign-in the Mac waits for says so, and a message behind a running turn is still the plain "sends when this turn ends".
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot, flush, click } from './support/phone/component-kit';
import { scripted } from './support/phone/m3';

import { fakeDraft } from './support/phone/drafts';
const threadPath = '../mobile/src/screens/Thread';
const queuePath = '../mobile/src/components/MacQueue';
const presentationPath = '../mobile/src/presentation/macQueue';
const { Thread } = await import(threadPath);
const { WAITING_LINE } = await import(queuePath);
const { heldOf } = await import(presentationPath);

const mounted: any[] = [];
async function mount(node: any) {
  for (const old of mounted.splice(0)) await act(async () => old.root.unmount()), old.host.remove();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  await act(async () => root.render(node));
  await flush();
  return host;
}
after(async () => {
  for (const old of mounted.splice(0)) await act(async () => old.root.unmount()), old.host.remove();
});
const named = (host: HTMLElement, label: string) =>
  [...host.querySelectorAll('button')].filter((b) => b.getAttribute('aria-label') === label);
const item = (id: string, text: string, over: object = {}) => ({ id, text, mine: true, attached: 0, ...over });

function chat(turn: string, queue: object[], answers: (m: string, p: any) => unknown = () => undefined) {
  return scripted((m, p) =>
    m === 'chat.follow'
      ? { rev: 1, feedSeq: 0, session: { turn, cards: [], queue }, itemsShape: 'rows', items: [] }
      : (answers(m, p) as any),
  );
}
const view = (s: any) => createElement(Thread, { runtime: s.runtime, chatId: 'c', back: () => {}, drafts: fakeDraft('') });

test('A: the held rows carry what the Mac says about each message, and ignore what it does not', () => {
  const held = heldOf({
    queue: [
      item('r', 'refused', { refused: 'No such model.' }),
      item('b', 'bare', { refused: '' }),
      item('m', 'moved', { moved: true }),
      item('h', 'away', { waiting: 'host' }),
      item('x', 'odd', { waiting: 'sometime', refused: 5, moved: 'yes' }),
      item('p', 'plain'),
    ],
  });
  assert.deepEqual(
    held.map((h: any) => [h.id, h.refused, h.moved, h.waiting]),
    [
      ['r', 'No such model.', undefined, undefined],
      ['b', '', undefined, undefined],
      ['m', undefined, true, undefined],
      ['h', undefined, undefined, 'host'],
      ['x', undefined, undefined, undefined],
      ['p', undefined, undefined, undefined],
    ],
  );
});

test('A: a refused message shows as not sent with the Host’s reason; Retry sends it again through the Mac, Cancel takes it out of the Mac', async () => {
  const s = chat('idle', [item('q1', 'second words', { refused: 'The model is not available to this account.' })], (m) =>
    m === 'chat.queue.retry' ? { retried: true, status: 'sent' } : m === 'chat.queue.cancel' ? { removed: true } : undefined,
  );
  const host = await mount(view(s));
  assert.match(host.textContent!, /second words/);
  assert.match(host.textContent!, /Not sent: The model is not available to this account\./);
  assert.doesNotMatch(host.textContent!, new RegExp(WAITING_LINE));
  assert.equal(named(host, 'Edit this message').length, 0, 'its words stay until it is sent or cancelled');
  await click('Retry sending');
  assert.deepEqual(
    s.calls.filter(([m]: any) => m === 'chat.queue.retry'),
    [['chat.queue.retry', { chatId: 'c', id: 'q1' }]],
  );
  await click('Cancel this message');
  assert.deepEqual(
    s.calls.filter(([m]: any) => m === 'chat.queue.cancel'),
    [['chat.queue.cancel', { chatId: 'c', id: 'q1' }]],
  );
});

test('A: a refusal without a reason still says it was not sent, and a Retry the Host refuses again changes the row, not the top of the chat', async () => {
  const s = chat('idle', [item('q1', 'words', { refused: '' })], (m) =>
    m === 'chat.queue.retry' ? { retried: true, status: 'queued', error: 'Sign in to Codex on Box first.' } : undefined,
  );
  const host = await mount(view(s));
  assert.match(host.textContent!, /Not sent: the host did not accept it/i);
  await click('Retry sending');
  await flush();
  // the Host's new reason reaches the row with the Mac's next queue (the refusal projected again), never as a second line
  assert.doesNotMatch(host.textContent!, /Sign in to Codex on Box first\./);
  assert.match(host.textContent!, /Not sent: the host did not accept it/i);
});

test('I: a Mac from before the retry call is told to update, and a message that already left says nothing broke', async () => {
  const old = chat('idle', [item('q1', 'words', { refused: 'No.' })], (m) => {
    if (m === 'chat.queue.retry') throw new Error('Unknown request: chat.queue.retry');
    return undefined;
  });
  const host = await mount(view(old));
  await click('Retry sending');
  await flush();
  assert.match(host.textContent!, /Update MoPilot on your Mac to retry queued messages\./);
  const gone = chat('idle', [item('q1', 'words', { refused: 'No.' })], (m) => (m === 'chat.queue.retry' ? { retried: false } : undefined));
  const again = await mount(view(gone));
  await click('Retry sending');
  await flush();
  assert.doesNotMatch(again.textContent!, /Update MoPilot/);
});

test('B: a Retry that fails for another reason shows that reason, whatever was thrown', async () => {
  const words = chat('idle', [item('q1', 'words', { refused: 'No.' })], (m) => {
    if (m === 'chat.queue.retry') throw new Error('The Mac is busy.');
    return undefined;
  });
  const first = await mount(view(words));
  await click('Retry sending');
  await flush();
  assert.match(first.textContent!, /The Mac is busy\./);
  const odd = chat('idle', [item('q1', 'words', { refused: 'No.' })], (m) => {
    if (m === 'chat.queue.retry') throw 'gone away';
    return undefined;
  });
  const second = await mount(view(odd));
  await click('Retry sending');
  await flush();
  assert.match(second.textContent!, /gone away/);
});

test('A: a chat that moved to another machine says so and offers only Cancel; a machine that is away and a sign-in say what they wait for', async () => {
  const s = chat('idle', [
    item('m', 'moved words', { moved: true }),
    item('h', 'away words', { waiting: 'host' }),
    item('s', 'signin words', { waiting: 'orgSignin' }),
  ]);
  const host = await mount(view(s));
  const text = host.textContent!;
  assert.match(text, /Not sent: This chat moved to another machine\./);
  assert.match(text, /Waiting for the machine/);
  assert.match(text, /Sign in to your organization on your Mac/);
  // Retry only where sending it again can work: the moved one has none
  assert.equal(named(host, 'Retry sending').length, 0);
  assert.equal(named(host, 'Cancel this message').length, 3);
});

test('B: a message behind a running turn is the plain "sends when this turn ends", with no state of its own', async () => {
  const s = chat('running', [item('q1', 'later')]);
  const host = await mount(view(s));
  assert.match(host.textContent!, new RegExp(WAITING_LINE));
  assert.equal(named(host, 'Retry sending').length, 0);
  assert.equal(named(host, 'Edit this message').length, 1);
});
