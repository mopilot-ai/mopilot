// The Email card's Send (src/components/momo/MomoDraftCard.tsx, useDraftSend.ts, draftSendCopy.ts, draftLastFrom.ts) in a MoMo chat, as the design has it: the account stated in the line above the card (the one account that can send, or the one last sent from; with several and none, asked in a small row until the option chips replace it), Edit and Send on the card, Send handing main the card's words and the account, then the card read only with a copy icon and nothing else, and below it, outside it, "Asked to send", "You chose Send" and the sent line. Where no account can send the card keeps Open in Mail. A short line for every way a send stops.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { window } from './support/dom.ts';
import { mockSource } from './support/stubs.ts';
import { installNativeStub } from './support/ports/native.ts';

const React = await import('react');
const { act, createElement } = React;
const { createRoot } = await import('react-dom/client');

const HOME = { id: 'home', label: 'Test mail (home)', account: 'home@mail.test', ok: true, why: null };
const WORK = { id: 'work', label: 'Test mail (work)', account: '', ok: true, why: null };
const f: any = {
  accounts: [HOME] as any[],
  accountsAnswer: null as any,
  state: { ok: true, send: null } as any,
  sendResult: null as any,
  sent: [] as any[],
  listeners: new Set<(e: any) => void>(),
  connectorListeners: new Set<() => void>(),
  accountReads: 0,
  throwAccounts: false,
  messages: [] as any[],
};
mockSource('src/session/clipboard.ts', { copyText: () => undefined });
// the draft's own question must never send the model a message: any send through the app's message path is recorded
mockSource('src/store/send.ts', { sendMessage: async (...a: any[]) => (f.messages.push(a), true) });
installNativeStub({
  momoDraft: {
    openInMail: async () => ({ ok: true }),
    accounts: async () => {
      f.accountReads++;
      if (f.throwAccounts) throw new Error('bridge closed');
      return f.accountsAnswer ?? { ok: true, accounts: f.accounts };
    },
    state: async () => f.state,
    send: async (input: any) => {
      f.sent.push(input);
      if (f.sendResult instanceof Error) throw f.sendResult;
      return f.sendResult;
    },
    onState: (cb: (e: any) => void) => (f.listeners.add(cb), () => f.listeners.delete(cb)),
  },
  momoConnectors: { onChanged: (cb: () => void) => (f.connectorListeners.add(cb), () => f.connectorListeners.delete(cb)) },
});
const { MomoDraftCard } = await import('../src/components/momo/MomoDraftCard.tsx');
const { lastFrom, rememberFrom } = await import('../src/components/momo/draftLastFrom.ts');

const DRAFT = { to: ['sam@example.com', 'lee@example.com'], subject: 'Re: lunch', body: 'Friday works.' };
const FROM = { id: 'home', label: HOME.label, account: HOME.account };
const flush = () =>
  act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });
const roots: any[] = [];
async function mount(props: any = { chatId: 'momo-main', noteId: 'd1' }, draft = DRAFT) {
  const host = window.document.createElement('div');
  window.document.body.appendChild(host as any);
  const root = createRoot(host as any);
  roots.push(root);
  await act(async () => root.render(createElement(MomoDraftCard, { draft, ...props })));
  await flush();
  const name = (b: any) => b.getAttribute('aria-label') ?? b.textContent;
  const button = (label: string) => [...host.querySelectorAll('button')].find((b) => name(b) === label) as HTMLButtonElement | undefined;
  const click = async (label: string) => {
    const b = button(label);
    assert.ok(b, `a ${label} button`);
    await act(async () => b.click());
    await flush();
  };
  const type = async (sel: string, value: string) => {
    const el: any = host.querySelector(sel);
    const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    await act(async () => {
      Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
      el.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
  };
  const chips = () => [...host.querySelectorAll('[data-option-chips] button')].map((b: any) => b.textContent);
  const tap = async (label: string) => {
    const b = [...host.querySelectorAll('[data-option-chips] button')].find((x: any) => x.textContent === label) as any;
    assert.ok(b, `a ${label} chip`);
    await act(async () => b.click());
    await flush();
  };
  const ask = () => host.querySelectorAll('[data-kind="momoDraft"] > p')[1]?.textContent;
  const card = () => host.querySelector('[role="group"][aria-label="Email"]') as unknown as HTMLElement;
  return {
    host,
    button,
    click,
    type,
    chips,
    tap,
    ask,
    card,
    text: () => host.textContent ?? '',
    lead: () => host.querySelector('[data-kind="momoDraft"] > p')?.textContent,
    buttons: () => [...host.querySelectorAll('button')].map((b) => name(b)),
    cardButtons: () => [...card().querySelectorAll('button')].map((b) => name(b)),
    list: () => host.querySelector('[aria-label="Send status"]') as HTMLElement | null,
    lines: () => [...host.querySelectorAll('[aria-label="Send status"] li')].map((li) => li.textContent),
    alert: () => host.querySelector('[role="alert"]')?.textContent,
  };
}
const push = (e: any) => act(async () => void f.listeners.forEach((cb) => cb(e)));
const connectorsChanged = async () => {
  await act(async () => void f.connectorListeners.forEach((cb) => cb()));
  await flush();
};
afterEach(async () => {
  for (const r of roots.splice(0)) await act(async () => r.unmount());
  window.localStorage.clear();
  Object.assign(f, {
    accounts: [HOME],
    accountsAnswer: null,
    state: { ok: true, send: null },
    sendResult: null,
    sent: [],
    accountReads: 0,
    throwAccounts: false,
    messages: [],
  });
});

test('with one account that can send, the line above states it, and the card has Edit and Send, a copy icon and ×', async () => {
  const v = await mount();
  assert.equal(v.lead(), 'Draft email to sam@example.com, lee@example.com with subject Re: lunch, from home@mail.test.');
  assert.deepEqual(v.cardButtons(), ['Copy', 'Dismiss', 'Edit', 'Send']);
  assert.deepEqual(v.chips(), [], 'no question when one account can send');
  assert.equal(v.button('Open in Mail'), undefined, 'Open in Mail only where nothing can send');
});

test('a card with no chat or note, or with no account that can send, keeps Open in Mail and has no Send', async () => {
  const bare = await mount({});
  assert.deepEqual(bare.cardButtons(), ['Copy', 'Dismiss', 'Edit', 'Open in Mail']);
  assert.equal(f.accountReads, 0);
  f.accounts = [];
  const none = await mount();
  assert.deepEqual(none.cardButtons(), ['Copy', 'Dismiss', 'Edit', 'Open in Mail']);
  assert.deepEqual(none.chips(), []);
  assert.equal(none.lead(), 'Draft email to sam@example.com, lee@example.com with subject Re: lunch.');
  // accounts that are all paused or read only can not send either
  f.accounts = [
    { ...HOME, ok: false, why: 'paused' },
    { ...WORK, ok: false, why: 'read_only' },
  ];
  const off = await mount();
  assert.equal(off.button('Send'), undefined);
  assert.ok(off.button('Open in Mail'));
  // an answer that is not a list, and a bridge that throws, leave no account
  f.accountsAnswer = { ok: false, error: 'MoMo is not available' };
  assert.equal((await mount()).button('Send'), undefined);
  f.throwAccounts = true;
  assert.equal((await mount()).button('Send'), undefined);
});

test('with several accounts and none the default, MoMo asks in a plain line with one chip per account, and Send waits; a tap fills From, sends no message to the model, and becomes the default', async () => {
  f.accounts = [HOME, WORK];
  const v = await mount();
  assert.equal(v.lead(), 'Draft email to sam@example.com, lee@example.com with subject Re: lunch.');
  assert.equal(v.ask(), 'Which account should I send it from?');
  assert.deepEqual(v.chips(), ['home@mail.test', 'Test mail (work)']);
  assert.equal(v.host.querySelector('select'), null, 'no native select');
  assert.equal(v.button('Send')!.disabled, true);
  assert.ok(!v.card().contains(v.host.querySelector('[data-option-chips]') as any), 'the chips are not inside the card');
  await v.tap('Test mail (work)');
  // answered: the chips and the question are gone and the line above the card names the account
  assert.deepEqual(v.chips(), []);
  assert.equal(v.ask(), undefined);
  assert.match(v.lead()!, /, from Test mail \(work\)\.$/);
  assert.equal(v.button('Send')!.disabled, false);
  // the tap changed the card's own state only: no message went to the model, and nothing was sent as mail
  assert.deepEqual(f.messages, []);
  assert.deepEqual(f.sent, []);
  f.sendResult = { ok: true, send: { state: 'sent', from: { ...FROM, id: 'work' }, at: 5 } };
  await v.click('Send');
  assert.equal(f.sent[0].from, 'work');
  assert.equal(lastFrom(), 'work');
  // the next card sends from it without asking
  f.sent = [];
  const next = await mount();
  assert.deepEqual(next.chips(), []);
  assert.match(next.lead()!, /, from Test mail \(work\)\.$/);
  assert.equal(next.button('Send')!.disabled, false);
  // a remembered account that can no longer send is asked again, offering only the accounts that can send
  f.accounts = [HOME, { ...WORK, ok: false, why: 'paused' }];
  f.accounts.push({ id: 'third', label: 'Third', account: '', ok: true, why: null });
  f.accounts.push({ id: 'ro', label: 'Read mail', account: '', ok: false, why: 'read_only' });
  const again = await mount();
  assert.deepEqual(again.chips(), ['home@mail.test', 'Third']);
});

test('the chips wait while the card is being edited', async () => {
  f.accounts = [HOME, WORK];
  const v = await mount();
  await v.click('Edit');
  assert.ok([...v.host.querySelectorAll('[data-option-chips] button')].every((b: any) => b.disabled));
  await v.click('Cancel');
  assert.ok([...v.host.querySelectorAll('[data-option-chips] button')].every((b: any) => !b.disabled));
});

test('the account last sent from is remembered in this window; storage that fails is no memory and no error', () => {
  assert.equal(lastFrom(), '');
  rememberFrom('home');
  assert.equal(lastFrom(), 'home');
  const real = window.localStorage;
  const broken = {
    getItem: () => {
      throw new Error('blocked');
    },
    setItem: () => {
      throw new Error('blocked');
    },
  };
  Object.defineProperty(globalThis, 'localStorage', { value: broken, configurable: true });
  try {
    assert.equal(lastFrom(), '');
    rememberFrom('work');
  } finally {
    Object.defineProperty(globalThis, 'localStorage', { value: real, configurable: true });
  }
});

test('Send hands main the note, the account and the card’s words; the card then has only the copy icon, with the lines below it, outside it', async () => {
  const send = { state: 'sent', from: FROM, at: 5 };
  f.sendResult = { ok: true, send };
  const v = await mount();
  await v.click('Send');
  assert.deepEqual(f.sent, [{ chatId: 'momo-main', noteId: 'd1', from: 'home', ...DRAFT }]);
  assert.deepEqual(v.lines(), ['Asked to send', 'You chose Send', 'Sent from home@mail.test']);
  assert.ok(!v.card().contains(v.list()), 'the lines are below the card, not in it');
  assert.deepEqual(v.cardButtons(), ['Copy'], 'no Edit, Send or × once sent');
  assert.deepEqual(v.chips(), []);
  assert.match(v.lead()!, /, from home@mail\.test\.$/);
  assert.doesNotMatch(v.text(), /undo/i);
});

test('main’s broadcasts move the card through its steps, also in another window; another note’s are ignored', async () => {
  const v = await mount();
  await push({ chatId: 'momo-main', noteId: 'other', send: { state: 'sent', from: FROM, at: 1 } });
  assert.deepEqual(v.lines(), []);
  await push({ chatId: 'momo-main', noteId: 'd1', send: { state: 'asked', from: FROM, at: 1 } });
  assert.deepEqual(v.lines(), ['Asked to send']);
  await push({ chatId: 'momo-main', noteId: 'd1', send: { state: 'chose', from: FROM, at: 1 } });
  assert.deepEqual(v.lines(), ['Asked to send', 'You chose Send']);
  await push({ chatId: 'momo-main', noteId: 'd1', send: null });
  assert.deepEqual(v.cardButtons(), ['Copy', 'Dismiss', 'Edit', 'Send'], 'a refusal puts the draft back in the person’s hands');
  await push({ chatId: 'momo-main', noteId: 'd1', send: { state: 'unsure', from: { ...FROM, account: '' }, at: 1 } });
  assert.deepEqual(v.lines(), ['Not sure this was sent. Check Sent mail in Test mail (home).']);
  assert.equal(v.host.querySelector('[data-unsure]') !== null, true);
});

test('a card opened after the send read it from main, and one for a MoMo that is off reads none', async () => {
  f.state = { ok: true, send: { state: 'sent', from: FROM, at: 5 } };
  const done = await mount();
  assert.deepEqual(done.lines(), ['Asked to send', 'You chose Send', 'Sent from home@mail.test']);
  assert.deepEqual(done.cardButtons(), ['Copy']);
  f.state = { ok: false, error: 'MoMo is not available' };
  assert.deepEqual((await mount()).lines(), []);
});

test('a connector changing reads the accounts again', async () => {
  const v = await mount();
  const before = f.accountReads;
  f.accounts = [WORK];
  await connectorsChanged();
  assert.equal(f.accountReads, before + 1);
  assert.match(v.lead()!, /, from Test mail \(work\)\.$/);
});

test('every way a send stops is one short line, the draft stays, and Send can be tried again', async () => {
  const why = async (result: any) => {
    f.sendResult = result;
    const v = await mount();
    await v.click('Send');
    assert.deepEqual(v.lines(), []);
    assert.equal(v.button('Send')!.disabled, false);
    return v.alert();
  };
  assert.equal(await why({ ok: false, reason: 'declined' }), 'Not sent.');
  assert.equal(await why({ ok: false, reason: 'no_recipient' }), 'Add who it is for first.');
  assert.equal(await why({ ok: false, reason: 'not_connected' }), 'home@mail.test is not connected. Pick another.');
  assert.equal(await why({ ok: false, reason: 'reconnect' }), 'Sign in to home@mail.test again in Settings.');
  assert.equal(await why({ ok: false, reason: 'paused' }), 'home@mail.test is paused in Settings.');
  assert.equal(await why({ ok: false, reason: 'read_only' }), 'home@mail.test can only read mail.');
  assert.equal(await why({ ok: false, reason: 'not_allowed' }), 'MoMo is not available.');
  assert.equal(await why({ ok: false, reason: 'failed' }), 'Couldn’t send. Try again.');
  assert.equal(await why({ ok: false, reason: 'no_account' }), 'Connect a mail account in Settings to send.');
  assert.equal(
    await why({ ok: false, reason: 'too_long', why: 'The body is longer than 6000 characters.' }),
    'The body is longer than 6000 characters.',
  );
  assert.equal(await why({ ok: false, reason: 'no_draft' }), 'Couldn’t send.');
  assert.match(String(await why(new Error('bridge closed'))), /bridge closed/);
  assert.equal(lastFrom(), '', 'a send that did not go is not remembered');
});

test('a refusal reads the accounts again (the account may be the reason), except a send already in flight', async () => {
  f.sendResult = { ok: false, reason: 'paused' };
  const v = await mount();
  const before = f.accountReads;
  await v.click('Send');
  assert.equal(f.accountReads, before + 1);
  f.sendResult = { ok: false, reason: 'busy' };
  await v.click('Send');
  assert.equal(f.accountReads, before + 1);
  assert.equal(v.alert(), 'Couldn’t send.');
});

test('a second window already sent it: the answer carries the send and the card shows it', async () => {
  f.sendResult = { ok: false, reason: 'already', send: { state: 'sent', from: FROM, at: 5 } };
  const v = await mount();
  await v.click('Send');
  assert.deepEqual(v.lines(), ['Asked to send', 'You chose Send', 'Sent from home@mail.test']);
  assert.equal(v.alert(), undefined);
});

test('Edit changes who it is for too; Send uses the edited words and the line above follows them', async () => {
  f.sendResult = { ok: true, send: { state: 'sent', from: FROM, at: 5 } };
  const v = await mount();
  await v.click('Edit');
  assert.deepEqual(v.cardButtons(), ['Copy', 'Dismiss', 'Cancel', 'Done']);
  await v.type('input[aria-label="To"]', 'kim@example.com, ');
  await v.type('input[aria-label="Subject"]', 'Re: Friday');
  await v.click('Done');
  assert.equal(v.lead(), 'Draft email to kim@example.com with subject Re: Friday, from home@mail.test.');
  await v.click('Send');
  assert.deepEqual(f.sent[0], {
    chatId: 'momo-main',
    noteId: 'd1',
    from: 'home',
    to: ['kim@example.com'],
    subject: 'Re: Friday',
    body: DRAFT.body,
  });
});

test('with no recipient Send still asks main, which says who it is for first', async () => {
  f.sendResult = { ok: false, reason: 'no_recipient' };
  const v = await mount({ chatId: 'momo-main', noteId: 'd1' }, { to: [], subject: '', body: 'hi' });
  assert.equal(v.button('Send')!.disabled, false);
  await v.click('Send');
  assert.equal(v.alert(), 'Add who it is for first.');
});

test('an account the person picked that stops working is never swapped for another: Send waits until they pick again', async () => {
  f.accounts = [HOME, WORK];
  const v = await mount();
  await v.tap('Test mail (work)');
  // work is paused in Settings: the card does not fall back to home behind the person’s back
  f.accounts = [HOME, { ...WORK, ok: false, why: 'paused' }];
  await connectorsChanged();
  assert.equal(v.button('Send')!.disabled, true);
  assert.equal(v.ask(), 'That account can’t send now. Pick another.');
  assert.deepEqual(v.chips(), ['home@mail.test']);
  assert.doesNotMatch(v.lead()!, /from/);
  f.sendResult = { ok: true, send: { state: 'sent', from: FROM, at: 5 } };
  await v.tap('home@mail.test');
  await v.click('Send');
  assert.equal(f.sent.at(-1).from, 'home');
});

test('× takes the card away; a picked account gone altogether is the same as a stopped one', async () => {
  f.accounts = [HOME, WORK];
  const v = await mount();
  await v.tap('Test mail (work)');
  f.accounts = [HOME, { id: 'third', label: 'Third', account: '', ok: true, why: null }];
  await connectorsChanged();
  assert.match(v.ask()!, /can’t send now/);
  await v.click('Dismiss');
  assert.equal(v.host.querySelector('[data-kind="momoDraft"]'), null);
});
