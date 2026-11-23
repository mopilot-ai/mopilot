// A draft MoMo wrote, as an Email card in the chat (src/components/momo/MomoDraftCard.tsx) where no mail account can send (a card with no chat or note, or a build with no mail connector): a plain line above in MoMo's words, the card titled Email with a copy icon and ×, To, subject and words, Edit on the left and Open in Mail on the right, with a short line for a link that is too long, no mail app or a refusal, and no Send and no From.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { window } from './support/dom.ts';
import { mockSource } from './support/stubs.ts';
import { installNativeStub } from './support/ports/native.ts';

const React = await import('react');
const { act, createElement } = React;
const { createRoot } = await import('react-dom/client');

const f: any = { copied: [] as string[], opened: [] as any[], copyOk: true, open: async () => ({ ok: true }) };
mockSource('src/session/clipboard.ts', {
  copyText: (text: string, done: () => void, failed?: () => void) => {
    f.copied.push(text);
    if (f.copyOk) done();
    else failed?.();
  },
});
installNativeStub({
  momoDraft: {
    openInMail: async (d: any) => (f.opened.push(d), f.open()),
  },
});
const { MomoDraftCard } = await import('../src/components/momo/MomoDraftCard.tsx');

const DRAFT = { to: ['sam@example.com', 'lee@example.com'], subject: 'Re: lunch', body: 'Friday works.\nNoon?' };
const flush = () =>
  act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  });
const roots: any[] = [];
async function mount(draft = DRAFT) {
  const host = window.document.createElement('div');
  window.document.body.appendChild(host as any);
  const root = createRoot(host as any);
  roots.push(root);
  await act(async () => root.render(createElement(MomoDraftCard, { draft })));
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
  return {
    host,
    button,
    click,
    type,
    text: () => host.textContent ?? '',
    lead: () => host.querySelector('[data-kind="momoDraft"] > p')?.textContent,
    rows: () => [...host.querySelectorAll('dl > div')].map((r) => r.textContent),
    buttons: () => [...host.querySelectorAll('button')].map((b) => name(b)),
    note: () => host.querySelector('[role="status"], [role="alert"]')?.textContent,
  };
}
afterEach(async () => {
  for (const r of roots.splice(0)) await act(async () => r.unmount());
  f.copied = [];
  f.opened = [];
  f.copyOk = true;
  f.open = async () => ({ ok: true });
});

test('the card is an Email card: a line above in MoMo’s words, a copy icon and ×, To, subject and words, Edit and Open in Mail, nothing that sends', async () => {
  const v = await mount();
  assert.equal(v.lead(), 'Draft email to sam@example.com, lee@example.com with subject Re: lunch.');
  assert.ok(v.host.querySelector('[role="group"][aria-label="Email"]'));
  assert.equal(v.host.querySelector('h3')!.textContent, 'Email');
  assert.deepEqual(v.rows(), ['Tosam@example.com, lee@example.com', 'SubjectRe: lunch', 'Friday works.\nNoon?']);
  assert.deepEqual(v.buttons(), ['Copy', 'Dismiss', 'Edit', 'Open in Mail']);
  assert.ok(v.host.querySelector('[data-kind="momoDraft"]'));
  assert.equal(v.host.querySelector('select'), null);
});

test('no recipient reads No recipient, no subject reads No subject, and the line above leaves out what is not there', async () => {
  const one = await mount({ to: ['sam@example.com'], subject: 'S', body: 'b' });
  assert.equal(one.lead(), 'Draft email to sam@example.com with subject S.');
  const none = await mount({ to: [], subject: '', body: 'b' });
  assert.match(none.text(), /No recipient/);
  assert.match(none.text(), /No subject/);
  assert.equal(none.lead(), 'Draft email.');
});

test('× takes the card away', async () => {
  const v = await mount();
  await v.click('Dismiss');
  assert.equal(v.host.querySelector('[data-kind="momoDraft"]'), null);
});

test('Copy (the icon) puts the body on the clipboard and says so; a copy that failed says nothing here (the app toasts it)', async () => {
  const v = await mount();
  await v.click('Copy');
  assert.deepEqual(f.copied, ['Friday works.\nNoon?']);
  assert.equal(v.note(), 'Copied');
  f.copyOk = false;
  const w = await mount();
  await w.click('Copy');
  assert.equal(w.host.querySelector('[role="status"], [role="alert"]'), null);
});

test('Open in Mail asks main with the draft’s words; a refusal or a thrown error is a short line, and the draft stays', async () => {
  const v = await mount();
  await v.click('Open in Mail');
  assert.deepEqual(f.opened, [DRAFT]);
  assert.equal(v.host.querySelector('[role="alert"]'), null);
  f.open = async () => ({ ok: false, error: 'Couldn’t open a mail app.' });
  await v.click('Open in Mail');
  assert.equal(v.host.querySelector('[role="alert"]')!.textContent, 'Couldn’t open a mail app.');
  f.open = async () => {
    throw new Error('bridge closed');
  };
  await v.click('Open in Mail');
  assert.match(v.host.querySelector('[role="alert"]')!.textContent!, /bridge closed/);
  assert.match(v.text(), /Friday works\./);
  assert.equal(v.button('Open in Mail')!.disabled, false, 'it can be tried again');
});

test('a draft too long for a mail link has Open in Mail off and says Copy it instead; Copy still works', async () => {
  const v = await mount({ to: [], subject: '', body: 'word '.repeat(600) });
  assert.equal(v.button('Open in Mail')!.disabled, true);
  assert.match(v.text(), /Too long to open in Mail\. Copy it instead\./);
  await v.click('Copy');
  assert.equal(f.copied.length, 1);
  assert.deepEqual(f.opened, []);
});

test('Edit changes who it is for, the subject and the words on this card only; Done keeps them, and Open in Mail and Copy use them', async () => {
  const v = await mount();
  await v.click('Edit');
  assert.deepEqual(v.buttons(), ['Copy', 'Dismiss', 'Cancel', 'Done']);
  await v.type('input[aria-label="To"]', 'kim@example.com');
  await v.type('input[aria-label="Subject"]', 'Re: Friday lunch');
  await v.type('textarea[aria-label="Draft text"]', 'Noon works for me.');
  await v.click('Done');
  assert.equal(v.lead(), 'Draft email to kim@example.com with subject Re: Friday lunch.');
  assert.deepEqual(v.buttons(), ['Copy', 'Dismiss', 'Edit', 'Open in Mail']);
  await v.click('Open in Mail');
  assert.deepEqual(f.opened.at(-1), { to: ['kim@example.com'], subject: 'Re: Friday lunch', body: 'Noon works for me.' });
  await v.click('Copy');
  assert.equal(f.copied.at(-1), 'Noon works for me.');
});

test('Cancel puts the words back; an empty, too long or badly addressed edit is refused where it stands', async () => {
  const v = await mount();
  await v.click('Edit');
  await v.type('textarea[aria-label="Draft text"]', 'changed');
  await v.type('input[aria-label="To"]', 'x@example.com');
  await v.click('Cancel');
  assert.match(v.text(), /Friday works\./);
  assert.doesNotMatch(v.text(), /changed/);
  assert.match(v.text(), /sam@example\.com, lee@example\.com/);
  await v.click('Edit');
  assert.equal((v.host.querySelector('input[aria-label="To"]') as unknown as HTMLInputElement).value, 'sam@example.com, lee@example.com');
  await v.type('textarea[aria-label="Draft text"]', '   ');
  await v.click('Done');
  assert.match(v.host.querySelector('[role="alert"]')!.textContent!, /needs a body/);
  assert.deepEqual(v.buttons(), ['Copy', 'Dismiss', 'Cancel', 'Done'], 'still editing');
  await v.type('textarea[aria-label="Draft text"]', 'ok');
  await v.type('input[aria-label="Subject"]', 'x'.repeat(300));
  await v.click('Done');
  assert.match(v.host.querySelector('[role="alert"]')!.textContent!, /subject is longer/);
  await v.type('input[aria-label="Subject"]', 'fine');
  await v.type('input[aria-label="To"]', 'nope');
  await v.click('Done');
  assert.match(v.host.querySelector('[role="alert"]')!.textContent!, /not an email address/);
  await v.click('Cancel');
  assert.equal(v.host.querySelector('[role="alert"]'), null);
});
