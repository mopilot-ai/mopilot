// The real parent picker: search, pending/empty/error states, retries and retired read/write completions.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { popoverStubs } from './support/stubs.ts';
import { render, settle, typeInto } from './support/shell-panels-kit.ts';
import { deferred } from './support/async-scenarios.ts';
import { createElement as h, act, StrictMode } from 'react';

mock.module('../src/components/ui/Popover.tsx', { namedExports: popoverStubs() });
const { PrStackPicker } = await import('../src/components/thread/PrStackPicker.tsx');
const url = 'https://github.com/o/r/pull/1';
const parents = [
  { url: 'https://github.com/o/r/pull/2', title: 'Parent change', headRefName: 'feature/parent', baseRefName: 'main' },
  { url: 'https://github.com/o/r/pull/3', title: 'Other change', headRefName: 'other', baseRefName: 'main' },
];
const api: any = { stackCandidates: async () => parents, stack: async () => {} };
const button = (host: HTMLElement, label: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === label)!;
async function mount(custom = api, strict = false) {
  let closed = 0;
  const element = h(PrStackPicker, {
    chatId: 'chat',
    url,
    api: custom,
    anchor: null,
    onClose: () => {
      closed++;
    },
  });
  const r = await render(strict ? h(StrictMode, null, element) : element);
  return { ...r, closed: () => closed };
}

test('picker focuses search, filters by title/branch/number and changes the exact tracked PR', async () => {
  const calls: any[] = [];
  const r = await mount({
    ...api,
    stack: async (...args: any[]) => {
      calls.push(args);
    },
  });
  try {
    const input = r.host.querySelector<HTMLInputElement>('input')!;
    assert.equal(document.activeElement, input);
    assert.equal(r.host.querySelectorAll('[aria-label="Parent pull requests"] > button').length, 2);
    assert.match(r.host.textContent!, /#2 · feature\/parent/);
    await act(async () => typeInto(input, ' FEATURE/PARENT '));
    assert.equal(r.host.querySelectorAll('[aria-label="Parent pull requests"] > button').length, 1);
    await act(async () => typeInto(input, 'missing'));
    assert.match(r.host.textContent!, /No matching pull requests/);
    await act(async () => typeInto(input, 'pull/3'));
    await act(async () => r.host.querySelector<HTMLButtonElement>('[aria-label="Parent pull requests"] > button')!.click());
    assert.deepEqual(calls, [['chat', url, parents[1].url]]);
    assert.equal(r.closed(), 1);
    await act(async () => button(r.host, 'Cancel').click());
    assert.equal(r.closed(), 2);
  } finally {
    await r.unmount();
  }
});

test('loading and empty choices are explicit, failure has Retry and search survives reload', async () => {
  const read = deferred<any>();
  let count = 0;
  const r = await mount({ ...api, stackCandidates: () => (++count === 1 ? read.promise : Promise.resolve([])) });
  try {
    assert.match(r.host.querySelector('[role="status"]')!.textContent!, /Loading/);
    const input = r.host.querySelector<HTMLInputElement>('input')!;
    await act(async () => typeInto(input, 'kept'));
    await act(async () => read.reject(new Error('offline')));
    assert.match(r.host.querySelector('[role="alert"]')!.textContent!, /offline/);
    await act(async () => button(r.host, 'Retry').click());
    assert.equal(input.value, 'kept');
    assert.match(r.host.textContent!, /No eligible parent PRs/);
    assert.equal(r.host.querySelector('[role="alert"]'), null);
  } finally {
    await r.unmount();
  }
});

test('duplicate picks coalesce, errors keep the query and options available for retry', async () => {
  const write = deferred<any>();
  let calls = 0;
  const r = await mount({
    ...api,
    stack: () => {
      calls++;
      return calls === 1 ? write.promise : Promise.resolve();
    },
  });
  try {
    const input = r.host.querySelector<HTMLInputElement>('input')!;
    await act(async () => typeInto(input, 'Parent'));
    await act(async () => {
      const pick = r.host.querySelector<HTMLButtonElement>('[aria-label="Parent pull requests"] > button')!;
      pick.click();
      pick.click();
    });
    assert.equal(calls, 1);
    assert.match(r.host.querySelector('[role="status"]')!.textContent!, /Updating PR base/);
    assert.equal(r.host.querySelector<HTMLButtonElement>('[aria-label="Parent pull requests"] > button')!.disabled, true);
    await act(async () => write.reject(new Error('permission denied')));
    assert.match(r.host.querySelector('[role="alert"]')!.textContent!, /permission denied/);
    assert.equal(r.closed(), 0);
    assert.equal(input.value, 'Parent');
    assert.equal(r.host.querySelector<HTMLButtonElement>('[aria-label="Parent pull requests"] > button')!.disabled, false);
    await act(async () => r.host.querySelector<HTMLButtonElement>('[aria-label="Parent pull requests"] > button')!.click());
    assert.equal(r.closed(), 1);
  } finally {
    await r.unmount();
  }
});

test('retired reads and writes cannot publish, close a replacement picker or change its busy state', async () => {
  for (const failure of [false, true]) {
    for (const write of [false, true]) {
      const pending = deferred<any>();
      const r = await mount({ ...api, ...(write ? { stack: () => pending.promise } : { stackCandidates: () => pending.promise }) });
      if (write) await act(async () => r.host.querySelector<HTMLButtonElement>('[aria-label="Parent pull requests"] > button')!.click());
      await r.unmount();
      await act(async () => {
        if (failure) pending.reject(new Error('retired'));
        else pending.resolve(parents);
      });
      assert.equal(r.closed(), 0);
    }
  }
  const old = deferred<any>();
  let reads = 0;
  const r = await mount({ ...api, stackCandidates: () => (++reads === 1 ? old.promise : Promise.resolve(parents)) }, true);
  try {
    assert.ok(reads >= 2);
    await act(async () => old.resolve([]));
    await settle(act);
    assert.equal(r.host.querySelectorAll('[aria-label="Parent pull requests"] > button').length, 2);
  } finally {
    await r.unmount();
  }
});
