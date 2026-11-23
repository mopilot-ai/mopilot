// Source entry validates complete links, preserves retryable input and routes every addition to its own chat.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { fakeStore, one, render, typeInto } from './support/shell-panels-kit.ts';
import { createElement as h, act } from 'react';
import { stubStore } from './support/stubs.ts';

const store = fakeStore({ runtime: {} });
const deliveries: [string, string][] = [];
let refused = false;
stubStore({
  ...store.exports,
  giveBackToComposer: (id: string, text: string) => {
    if (refused) throw Error('draft unavailable');
    deliveries.push([id, text]);
  },
});
const { SummarySources, monogram } = await import('../src/components/panels/SummarySources.tsx');
beforeEach(() => {
  store.set({ runtime: {} });
  deliveries.length = 0;
  refused = false;
});
const input = (host: HTMLElement) => one(host, '[aria-label="Source URL"]') as HTMLInputElement;
const open = (host: HTMLElement) => act(() => one(host, '[title="Add source"]').click());
const type = (host: HTMLElement, text: string) => act(() => typeInto(input(host), text));
const submit = (host: HTMLElement) => act(() => one(host, 'form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
async function key(host: HTMLElement, name: string, isComposing = false) {
  const event = new KeyboardEvent('keydown', { key: name, isComposing, bubbles: true, cancelable: true });
  await act(() => input(host).dispatchEvent(event));
  return event;
}

test('a chat with no turns offers source entry without inserting or sending a placeholder', async () => {
  const { host, unmount } = await render(h(SummarySources, { threadId: 'origin' }));
  assert.equal(host.textContent, 'Sources');
  assert.equal(host.querySelector('.summary-row'), null);
  await open(host);
  assert.equal(document.activeElement, input(host));
  assert.equal(input(host).value, '');
  assert.equal(one(host, 'button[type="submit"]').hasAttribute('disabled'), true);
  assert.match(host.textContent!, /Add a link to your next message/);
  assert.deepEqual(deliveries, []);
  await type(host, '   ');
  assert.equal(one(host, 'button[type="submit"]').hasAttribute('disabled'), true);
  await submit(host);
  assert.equal(input(host).getAttribute('aria-invalid'), 'true');
  assert.ok(host.querySelector('[role="alert"]'));
  await unmount();
});

test('invalid links retain their text and editing recovers from validation errors', async () => {
  const { host, unmount } = await render(h(SummarySources, { threadId: 'origin' }));
  await open(host);
  for (const text of [
    'https://',
    'http://[bad',
    'not a url',
    'ftp://example.com/file',
    'javascript://example.com',
    'file:///tmp/file',
    'mailto:help@example.com',
    'https://user@example.com',
    'https://:secret@example.com',
  ]) {
    await type(host, text);
    assert.equal(host.querySelector('[role="alert"]'), null);
    await submit(host);
    assert.equal(input(host).value, text);
    assert.match(one(host, '[role="alert"]').textContent!, /valid http:\/\/ or https:\/\//);
    assert.equal(document.getElementById(input(host).getAttribute('aria-errormessage')!), host.querySelector('[role="alert"]'));
  }
  assert.deepEqual(deliveries, []);
  await type(host, 'https://example.com/guide?q=a%20b#part');
  await submit(host);
  assert.deepEqual(deliveries, [['origin', 'https://example.com/guide?q=a%20b#part']]);
  assert.equal(host.querySelector('form'), null);
  await unmount();
});

test('several complete links, including bare hosts and HTTP, reach only the originating chat in order', async () => {
  const { host, unmount } = await render(h(SummarySources, { threadId: 'origin:with/opaque-id' }));
  for (const text of [' docs.example.com/guide ', 'http://localhost:3000/docs', 'example.com:8443/next', 'https://example.com/last']) {
    await open(host);
    await type(host, text);
    await act(() => one(host, 'button[type="submit"]').click());
    assert.equal(host.querySelector('form'), null);
  }
  assert.deepEqual(deliveries, [
    ['origin:with/opaque-id', 'https://docs.example.com/guide'],
    ['origin:with/opaque-id', 'http://localhost:3000/docs'],
    ['origin:with/opaque-id', 'https://example.com:8443/next'],
    ['origin:with/opaque-id', 'https://example.com/last'],
  ]);
  await unmount();
});

test('a bare address with a URL in its query is normalized without losing its query or fragment', async () => {
  const { host, unmount } = await render(h(SummarySources, { threadId: 'origin' }));
  await open(host);
  await type(host, 'example.com/?next=https://docs.example.com/guide#section');
  await submit(host);
  assert.deepEqual(deliveries, [['origin', 'https://example.com/?next=https://docs.example.com/guide#section']]);
  await unmount();
});

test('valid HTTP scheme formatting is normalized without inventing a different host', async () => {
  const { host, unmount } = await render(h(SummarySources, { threadId: 'origin' }));
  for (const text of ['http:/example.com/guide', 'https:example.org/guide', 'http:localhost:3000/guide']) {
    await open(host);
    await type(host, text);
    await submit(host);
  }
  assert.deepEqual(deliveries, [
    ['origin', 'http://example.com/guide'],
    ['origin', 'https://example.org/guide'],
    ['origin', 'http://localhost:3000/guide'],
  ]);
  await unmount();
});

test('a delivery failure keeps the entered link and supports successful retry', async () => {
  const { host, unmount } = await render(h(SummarySources, { threadId: 'origin' }));
  await open(host);
  await type(host, 'example.com/retry');
  refused = true;
  await submit(host);
  assert.equal(input(host).value, 'example.com/retry');
  assert.match(one(host, '[role="alert"]').textContent!, /Could not add the link/);
  refused = false;
  await submit(host);
  assert.deepEqual(deliveries, [['origin', 'https://example.com/retry']]);
  assert.equal(host.querySelector('form'), null);
  await unmount();
});

test('Cancel and Escape restore the add button; composition and other keys leave entry intact', async () => {
  const { host, unmount } = await render(h(SummarySources, { threadId: 'origin' }));
  let escaped = 0;
  const onKey = (event: Event) => {
    if ((event as KeyboardEvent).key === 'Escape') escaped++;
  };
  window.addEventListener('keydown', onKey);
  try {
    await open(host);
    await type(host, 'example.com/cancel');
    await key(host, 'a');
    assert.equal((await key(host, 'Escape', true)).defaultPrevented, false);
    assert.equal((await key(host, 'Enter', true)).defaultPrevented, true);
    assert.equal((await key(host, 'Enter')).defaultPrevented, false);
    assert.equal(input(host).value, 'example.com/cancel');
    const before = escaped;
    assert.equal((await key(host, 'Escape')).defaultPrevented, true);
    assert.equal(escaped, before, 'the form handles Escape before window shortcuts');
    assert.equal(host.querySelector('form'), null);
    assert.equal(document.activeElement, one(host, '[title="Add source"]'));
    await open(host);
    assert.equal(input(host).value, '');
    await act(() => one(host, 'button[type="button"]').click());
    assert.equal(host.querySelector('form'), null);
    assert.equal(document.activeElement, one(host, '[title="Add source"]'));
    assert.deepEqual(deliveries, []);
  } finally {
    window.removeEventListener('keydown', onKey);
    await unmount();
  }
});

test('switching chats retires entry, errors and expansion before another chat can add a link', async () => {
  store.set({
    runtime: { origin: { turns: [{ items: [{ type: 'agentMessage', text: 'https://example.com/guide' }] }] } },
  });
  const view = await render(h(SummarySources, { threadId: 'origin' }));
  await act(() => one(view.host, '.summary-row.muted').click());
  await open(view.host);
  await type(view.host, 'https://');
  await submit(view.host);
  await view.rerender(h(SummarySources, { threadId: 'other' }));
  assert.equal(view.host.querySelector('form'), null);
  assert.equal(view.host.querySelector('[role="alert"]'), null);
  await open(view.host);
  assert.equal(input(view.host).value, '');
  await type(view.host, 'example.org/other');
  await submit(view.host);
  assert.deepEqual(deliveries, [['other', 'https://example.org/other']]);
  await view.rerender(h(SummarySources, { threadId: 'origin' }));
  assert.equal(one(view.host, '.summary-label').textContent, 'example.com');
  assert.equal(view.host.querySelector('form'), null);
  await view.unmount();
});

test("links come from a user's text, replies and commands, without the brackets or punctuation around them", async () => {
  store.set({
    runtime: {
      origin: {
        turns: [
          {
            items: [
              {
                type: 'userMessage',
                content: [
                  { type: 'text', text: 'see (https://a.test/x).' },
                  { type: 'image', url: 'https://img.test/p.png' },
                ],
              },
              { type: 'userMessage' },
              { type: 'agentMessage' },
              { type: 'agentMessage', text: 'Done: [https://b.test/y]!' },
              { type: 'commandExecution' },
              { type: 'commandExecution', command: "curl 'https://c.test/z'" },
            ],
          },
        ],
      },
    },
  });
  const view = await render(h(SummarySources, { threadId: 'origin' }));
  assert.deepEqual(
    [...view.host.querySelectorAll('.summary-label')].map((e) => e.textContent).filter((t) => !t!.startsWith('Show all')),
    ['a.test', 'b.test', 'c.test'],
  );
  await view.unmount();
});

test("a host's tile shows its first letter or digit past www., and a mark when it has none", () => {
  assert.equal(monogram('www.github.com'), 'G');
  assert.equal(monogram('8.8.8.8'), '8');
  assert.equal(monogram('[::1]'), '1');
  assert.equal(monogram('--'), '?');
});

test('the heading counts every link, and each host row leads with its letter tile', async () => {
  store.set({
    runtime: {
      origin: { turns: [{ items: [{ type: 'agentMessage', text: 'https://www.alpha.dev/a https://alpha.dev/b https://beta.dev/c' }] }] },
    },
  });
  const view = await render(h(SummarySources, { threadId: 'origin' }));
  assert.equal(one(view.host, '.summary-count').textContent, '3');
  assert.deepEqual(
    [...view.host.querySelectorAll('.summary-monogram')].map((m) => m.textContent),
    ['A', 'A', 'B'],
  );
  assert.equal(one(view.host, '.summary-row.muted').getAttribute('aria-expanded'), 'false');
  assert.equal(one(view.host, '.summary-row.muted').textContent, 'Show all 3 links');
  await act(() => one(view.host, '.summary-row.muted').click());
  assert.equal(one(view.host, '.summary-row.muted').getAttribute('aria-expanded'), 'true');
  assert.ok(one(view.host, '.summary-row.muted svg').classList.contains('flipped'));
  await view.unmount();
});
