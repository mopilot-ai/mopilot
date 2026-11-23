// The login sheet above the composer for browser_request_credentials
// (src/components/thread/BrowserCredentialSheet.tsx): it shows the chat's open sheet with the exact
// origin and fields, and sends the typed values, a saved login, a take-over or a decline to main only.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { window, native, mockStore, render, settle } from './support/thread-kit.ts';

const chats: Record<string, string> = { 'native-1': 'chat' };
mockStore({ chatOf: (id: string) => chats[id] ?? id });

let list: any[] = [];
let push: ((l: any[]) => void) | null = null;
const answers: any[] = [];
const forgotten: string[] = [];
let offs = 0;
native.browser.credentialRequests = async () => list;
native.browser.onCredentialRequests = (cb: (l: any[]) => void) => {
  push = cb;
  return () => {
    offs++;
  };
};
native.browser.credentialAnswer = async (id: string, answer: any) => {
  answers.push([id, answer]);
  return true;
};
native.browser.credentialForget = async (id: string) => {
  forgotten.push(id);
  return true;
};

const { BrowserCredentialSheet, fillAnswer } = await import('../src/components/thread/BrowserCredentialSheet.tsx');
const { createElement } = await import('react');

afterEach(() => {
  list = [];
  push = null;
  answers.length = 0;
  forgotten.length = 0;
});

const sheet = (o: any = {}) => ({
  id: 'r1',
  chatId: 'native-1',
  tabId: 't1',
  origin: 'https://login.example.com',
  frameOrigin: '',
  reason: '',
  fields: [
    { kind: 'username', label: 'Email' },
    { kind: 'password', label: '' },
  ],
  saved: [],
  canSave: true,
  ...o,
});

async function type(el: Element | null, value: string) {
  assert.ok(el, 'no field');
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new window.Event('input', { bubbles: true }) as any);
  });
}
async function choose(el: Element | null, value: string) {
  assert.ok(el, 'no select');
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new window.Event('change', { bubbles: true }) as any);
  });
}
const button = (host: HTMLElement, label: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === label)!;
const click = (el: HTMLElement) => act(async () => el.click());

test('nothing shows without a sheet for this chat, or when an older main answers nothing', async () => {
  list = [sheet({ chatId: 'other' })];
  const r = await render(createElement(BrowserCredentialSheet, { threadId: 'chat' }));
  assert.equal(r.$('.credential-sheet'), null);
  const saved = native.browser.credentialRequests;
  native.browser.credentialRequests = async () => undefined;
  const r2 = await render(createElement(BrowserCredentialSheet, { threadId: 'chat' }));
  assert.equal(r2.$('.credential-sheet'), null);
  native.browser.credentialRequests = saved;
  // unmounting unsubscribes, and a late answer after unmounting is ignored
  const before = offs;
  let resolve: (l: any[]) => void = () => {};
  native.browser.credentialRequests = () => new Promise((r) => (resolve = r));
  const r3 = await render(createElement(BrowserCredentialSheet, { threadId: 'chat' }));
  await r3.unmount();
  resolve([sheet()]);
  await settle();
  assert.equal(offs, before + 1);
  native.browser.credentialRequests = saved;
});

test('the sheet names the exact origin, the frame and the fields; Fill sends the typed values to main only', async () => {
  list = [sheet({ frameOrigin: 'https://idp.example', reason: 'Sign in to open the dashboard' })];
  const r = await render(createElement(BrowserCredentialSheet, { threadId: 'chat' }));
  const form = r.$('form.credential-sheet')!;
  assert.equal(form.getAttribute('aria-label'), 'Sign in to login.example.com');
  assert.equal(r.$('.credential-title')!.textContent, 'Sign in to login.example.com');
  assert.equal(r.$('.credential-origin')!.textContent, 'https://login.example.com · fields from https://idp.example');
  assert.equal(r.$('.credential-reason')!.textContent, 'Sign in to open the dashboard');
  const labels = r.$$('.credential-field span').map((s) => s.textContent);
  assert.deepEqual(labels, ['Email', 'Password']);
  const pw = r.$('input[type="password"]') as HTMLInputElement;
  assert.equal(pw.getAttribute('autocomplete'), 'current-password');
  // Fill waits for a value; the form's own submit does nothing while empty
  assert.equal(button(r.host, 'Fill').disabled, true);
  await act(async () => form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }) as any));
  assert.deepEqual(answers, []);
  await type(r.$('input[aria-label="Username or email"]'), 'ada@example.com');
  await type(pw, 'hunter2');
  await click(r.$('.credential-save input') as HTMLElement);
  await click(button(r.host, 'Fill'));
  assert.deepEqual(answers, [
    ['r1', { action: 'fill', values: { username: 'ada@example.com', password: 'hunter2' }, savedId: null, save: true }],
  ]);
  // sent once: the fields are cleared and the buttons wait for main
  assert.equal(pw.value, '');
  assert.equal(button(r.host, 'Fill').disabled, true);
  assert.equal(button(r.host, 'Decline').disabled, true);
  await act(async () => form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }) as any));
  assert.equal(answers.length, 1);
  // main closes the sheet
  await act(async () => push!([]));
  assert.equal(r.$('.credential-sheet'), null);
});

test('Decline and "I\'ll sign in myself" send no values', async () => {
  list = [sheet({ chatId: 'chat', canSave: false })];
  const r = await render(createElement(BrowserCredentialSheet, { threadId: 'chat' }));
  assert.equal(r.$('.credential-save'), null, 'no OS key: nothing to save into');
  assert.equal(r.$('.credential-reason'), null);
  assert.equal(r.$('.credential-origin')!.textContent, 'https://login.example.com');
  await click(button(r.host, 'Decline'));
  await act(async () => push!([sheet({ id: 'r2', chatId: 'chat' })]));
  await click(button(r.host, "I'll sign in myself"));
  assert.deepEqual(answers, [
    ['r1', { action: 'decline' }],
    ['r2', { action: 'takeover' }],
  ]);
});

test('a saved login hides the username and password; a code is still typed; Forget removes it', async () => {
  list = [
    sheet({
      fields: [
        { kind: 'username', label: '' },
        { kind: 'password', label: '' },
        { kind: 'otp', label: '' },
      ],
      saved: [
        { id: 's1', username: 'ada@example.com' },
        { id: 's2', username: '' },
      ],
    }),
  ];
  const r = await render(createElement(BrowserCredentialSheet, { threadId: 'chat' }));
  const options = r.$$('.credential-saved option').map((o) => o.textContent);
  assert.deepEqual(options, ['Type a login', 'ada@example.com', 'Saved login']);
  await choose(r.$('select[aria-label="Saved login"]'), 's1');
  assert.deepEqual(
    r.$$('.credential-field input').map((i) => i.getAttribute('aria-label')),
    ['One-time code'],
  );
  assert.equal(r.$('.credential-save'), null);
  assert.equal(button(r.host, 'Fill').disabled, false);
  await click(button(r.host, 'Forget'));
  assert.deepEqual(forgotten, ['s1']);
  assert.equal((r.$('select') as HTMLSelectElement).value, '');
  await choose(r.$('select[aria-label="Saved login"]'), 's2');
  await type(r.$('input[aria-label="One-time code"]'), '123456');
  await click(button(r.host, 'Fill'));
  assert.deepEqual(answers, [['r1', { action: 'fill', values: { otp: '123456' }, savedId: 's2', save: false }]]);
});

test('fillAnswer picks the shown fields only', () => {
  const fields: any = [
    { kind: 'username', label: '' },
    { kind: 'otp', label: '' },
  ];
  assert.deepEqual(fillAnswer(fields, { username: 'u', otp: '', password: 'x' }, '', false), {
    action: 'fill',
    values: { username: 'u' },
    savedId: null,
    save: false,
  });
  assert.deepEqual(fillAnswer(fields, { username: 'u', otp: '1' }, 's', true), {
    action: 'fill',
    values: { otp: '1' },
    savedId: 's',
    save: false,
  });
});
