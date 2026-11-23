// Keyboard rename uses the selected chat and retains the user's name across refusal, failure and retry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { window as domWindow } from './support/dom.ts';
const window = domWindow as unknown as Window & typeof globalThis;
import { fakeStore, render } from './support/shell-panels-kit.ts';
import { deferred } from './support/async-scenarios.ts';
import { createElement, act } from 'react';
import { stubStore } from './support/stubs.ts';
const chats: any = { a: { name: 'Main' }, 'side:"\\': { name: 'Side' } };
const store = fakeStore({ threads: chats });
let refuse = false,
  fail = false,
  pending: Promise<unknown> | null = null;
const calls: any[] = [];
stubStore({
  ...store.exports,
  threadTitle: (t: any) => t.name,
  renameThread: async (id: string, name: string) => {
    calls.push([id, name]);
    await pending;
    if (fail) throw new Error('disk');
    if (!refuse) chats[id].name = name;
  },
});
const { ShortcutRename } = await import('../src/components/dialogs/ShortcutRename.tsx');
const open = (threadId: string) => window.dispatchEvent(new window.CustomEvent('rename-chat', { detail: { threadId } }));
test('a side chat can be renamed, with input retained through refused and rejected saves', async () => {
  const r = await render(createElement(ShortcutRename));
  assert.equal(r.host.textContent, '');
  await act(async () => {
    open('missing');
    window.dispatchEvent(new Event('rename-chat'));
    window.dispatchEvent(new CustomEvent('rename-chat', { detail: { threadId: 2 } }));
  });
  assert.equal(r.host.textContent, '');
  await act(async () => {
    open('side:"\\');
  });
  const input = () => r.host.querySelector('input')!;
  await act(async () => {
    input().focus();
  });
  const set = async (name: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input(), name);
      input().dispatchEvent(new window.Event('input', { bubbles: true }));
    });
  };
  const submit = async () => {
    await act(async () => {
      r.host.querySelector('form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    });
  };
  await set('  Renamed  ');
  refuse = true;
  await submit();
  assert.equal(input().value, '  Renamed  ');
  assert.ok(r.host.querySelector('[role="alert"]'));
  refuse = false;
  fail = true;
  await submit();
  assert.equal(input().value, '  Renamed  ');
  fail = false;
  const wait = deferred();
  pending = wait.promise;
  await submit();
  assert.equal(input().readOnly, true);
  await submit();
  await act(async () => {
    window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
  });
  assert.ok(input());
  await act(async () => {
    wait.resolve(undefined);
    await pending;
  });
  pending = null;
  assert.equal(r.host.textContent, '');
  assert.equal(chats['side:"\\'].name, 'Renamed');
  assert.equal(chats.a.name, 'Main');
  await act(async () => {
    open('a');
  });
  await set('');
  await submit();
  assert.ok(r.host.querySelector('input'));
  await act(async () => {
    window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
  });
  assert.equal(r.host.textContent, '');
  await r.unmount();
  open('a');
  assert.equal(calls.length, 3);
});

test('completion of a retired rename form leaves its replacement open', async () => {
  const r = await render(createElement(ShortcutRename));
  await act(async () => {
    open('a');
  });
  const wait = deferred();
  pending = wait.promise;
  await act(async () => {
    r.host.querySelector('form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  });
  await act(async () => {
    open('side:"\\');
  });
  await act(async () => {
    wait.resolve(undefined);
    await pending;
  });
  pending = null;
  assert.equal(r.host.querySelector('input')!.value, 'Renamed');
  await r.unmount();
});
