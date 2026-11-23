// The create form: prefilled and editable words, each result (created, existing, web fallback, refusal), kept input, retries and retired completions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { store, deferred, settle } from './support/pr-monitor-ui.ts';
import { render, typeInto } from './support/shell-panels-kit.ts';
import { createElement as h, act, StrictMode } from 'react';

const { PrCreateForm } = await import('../src/components/panels/PrCreateForm.tsx');
const url = 'https://github.com/o/r/pull/9';
const draft = (extra = {}) => ({
  status: 'draft',
  branch: 'feature',
  base: 'main',
  stacked: false,
  title: 'Add merge',
  body: 'Why it matters',
  commits: 1,
  ...extra,
});
const refused = (text: string) => ({ status: 'refused', reason: 'x', text });
async function mount(api: any, strict = false) {
  let closed = 0;
  store.calls.length = 0;
  const element = h(PrCreateForm, { chatId: 'chat', api, onClose: () => void closed++ });
  const r = await render(strict ? h(StrictMode, null, element) : element);
  await settle(act);
  const field = (label: string) => r.host.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
  const button = (text: string) => [...r.host.querySelectorAll('button')].find((b) => b.textContent === text)!;
  const submit = async () => {
    await act(async () => button('Create pull request').click());
    await settle(act);
  };
  return { ...r, closed: () => closed, field, button, submit, alert: () => r.host.querySelector('[role="alert"]')?.textContent };
}

test('the form opens prefilled from the branch, and what the user edits is what main is asked to create', async () => {
  const calls: any[] = [];
  const f = await mount({
    createDraft: async () => draft(),
    create: async (...args: any[]) => (calls.push(args), { status: 'created', url, bound: true }),
  });
  assert.equal(f.field('Pull request title').value, 'Add merge');
  assert.equal(f.field('Pull request description').value, 'Why it matters');
  assert.equal(f.field('Base branch').value, 'main');
  assert.equal(f.field('Base branch').title, 'feature merges into this branch');
  assert.equal(document.activeElement, f.field('Pull request title'));
  await act(async () => typeInto(f.field('Pull request title'), '  Add merging  '));
  await act(async () => typeInto(f.field('Pull request description'), 'Edited body'));
  await act(async () => typeInto(f.field('Base branch'), ' release '));
  await f.submit();
  assert.deepEqual(calls, [['chat', { title: 'Add merging', body: 'Edited body', base: 'release', branch: 'feature' }]]);
  assert.deepEqual(store.calls, [['toast', 'Pull request created; attached to this chat']]);
  assert.equal(f.closed(), 1);
  await f.unmount();
});

test('an empty title cannot be submitted, by the button or by Enter', async () => {
  const calls: any[] = [];
  const f = await mount({ createDraft: async () => draft({ title: '', stacked: true }), create: async (...a: any[]) => calls.push(a) });
  assert.equal(f.button('Create pull request').disabled, true);
  assert.match(f.field('Base branch').title, /stacked on/);
  await act(async () => f.host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  assert.equal(calls.length, 0);
  await f.unmount();
});

test('an existing pull request, and one made for a chat that changed meanwhile, say what happened', async () => {
  for (const [result, toast] of [
    [{ status: 'exists', url, bound: true }, 'Pull request already exists; attached to this chat'],
    [{ status: 'created', url, bound: false }, `Pull request created: ${url}`],
  ] as const) {
    const f = await mount({ createDraft: async () => draft(), create: async () => result });
    await f.submit();
    assert.deepEqual(store.calls, [['toast', toast]]);
    assert.equal(f.closed(), 1);
    await f.unmount();
  }
});

test('the web fallback says why GitHub’s form opened; a refusal keeps the input and can be retried', async () => {
  const answers: any[] = [
    refused('Couldn’t push feature: ! [rejected] (non-fast-forward)'),
    new Error('Another pull request action is still running for this chat.'),
    { status: 'web', why: 'a template is required' },
    { status: 'created', url, bound: true },
  ];
  const f = await mount({
    createDraft: async () => draft(),
    create: async () => {
      const next = answers.shift();
      if (next instanceof Error) throw next;
      return next;
    },
  });
  await act(async () => typeInto(f.field('Pull request title'), 'Kept title'));
  await f.submit();
  assert.equal(f.alert(), 'Couldn’t push feature: ! [rejected] (non-fast-forward)');
  assert.equal(f.field('Pull request title').value, 'Kept title');
  assert.equal(f.closed(), 0);
  await f.submit();
  assert.match(f.alert()!, /still running for this chat/);
  await f.submit();
  assert.equal(f.alert(), undefined);
  assert.match(f.host.querySelector('[role="status"]')!.textContent!, /GitHub’s form opened in your browser: a template is required/);
  assert.equal(f.closed(), 0);
  assert.deepEqual(store.calls, []);
  await f.submit();
  assert.equal(f.closed(), 1);
  await f.unmount();
});

test('a folder that cannot have a pull request shows why with Retry; Cancel and Escape close the form', async () => {
  const drafts: any[] = [refused('The folder is not on a branch.'), new Error('This chat is unavailable'), draft()];
  const f = await mount({
    createDraft: async () => {
      const next = drafts.shift();
      if (next instanceof Error) throw next;
      return next;
    },
  });
  assert.equal(f.alert(), 'The folder is not on a branch.');
  assert.equal(f.field('Pull request title'), null);
  assert.equal(f.button('Create pull request'), undefined);
  await act(async () => f.button('Retry').click());
  await settle(act);
  assert.equal(f.alert(), 'This chat is unavailable');
  await act(async () => f.button('Retry').click());
  await settle(act);
  assert.equal(f.alert(), undefined);
  assert.equal(f.field('Pull request title').value, 'Add merge');
  await act(async () => f.button('Cancel').click());
  assert.equal(f.closed(), 1);
  const key = (init: KeyboardEventInit) =>
    act(async () => f.field('Pull request title').dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init })));
  await key({ key: 'Enter' });
  await key({ key: 'Escape', isComposing: true });
  assert.equal(f.closed(), 1);
  await key({ key: 'Escape' });
  assert.equal(f.closed(), 2);
  await f.unmount();
});

test('while reading and while creating the form says so, and a double submit sends once', async () => {
  const reading = deferred<any>();
  const creating = deferred<any>();
  let creates = 0;
  const f = await mount({ createDraft: () => reading.promise, create: () => (creates++, creating.promise) });
  assert.equal(f.host.querySelector('[role="status"]')!.textContent, 'Reading the branch…');
  assert.equal(f.button('Retry'), undefined);
  reading.resolve(draft());
  await settle(act);
  const form = f.host.querySelector('form')!;
  await act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  assert.equal(creates, 1);
  assert.equal(form.getAttribute('aria-busy'), 'true');
  assert.equal(f.button('Creating…').disabled, true);
  assert.equal(f.field('Pull request title').readOnly, true);
  creating.resolve(refused('no'));
  await settle(act);
  assert.equal(form.getAttribute('aria-busy'), 'false');
  await f.unmount();
});

test('results that land after the form closed change nothing on screen; Strict Mode reads once per mount and the newest wins', async () => {
  for (const settleWith of ['draft', 'draftError', 'refused', 'web', 'throw', 'created'] as const) {
    const reading = deferred<any>();
    const creating = deferred<any>();
    const early = settleWith === 'draft' || settleWith === 'draftError';
    const f = await mount({ createDraft: () => (early ? reading.promise : draft()), create: () => creating.promise });
    if (!early) await act(async () => f.button('Create pull request').click());
    await f.unmount();
    if (settleWith === 'draft') reading.resolve(draft());
    if (settleWith === 'draftError') reading.reject(new Error('late'));
    if (settleWith === 'refused') creating.resolve(refused('late'));
    if (settleWith === 'web') creating.resolve({ status: 'web', why: 'late' });
    if (settleWith === 'throw') creating.reject(new Error('late'));
    if (settleWith === 'created') creating.resolve({ status: 'created', url, bound: true });
    await settle(act);
    // the pull request was still created: its toast is the only trace, and the closed form is not closed twice
    assert.deepEqual(store.calls, settleWith === 'created' ? [['toast', 'Pull request created; attached to this chat']] : []);
    assert.equal(f.closed(), 0);
  }
  let reads = 0;
  const first = deferred<any>();
  const f = await mount(
    {
      createDraft: () => (++reads === 1 ? first.promise : Promise.resolve(draft({ title: 'Newest' }))),
      create: async () => refused('no'),
    },
    true,
  );
  assert.equal(reads, 2);
  first.resolve(draft({ title: 'Stale' }));
  await settle(act);
  assert.equal(f.field('Pull request title').value, 'Newest');
  await f.unmount();
});
