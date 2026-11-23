// The summary panel's environment: the chip naming where the chat runs, and its Remote Control switch for each harness and link state.
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { fakeStore, one, render } from './support/shell-panels-kit.ts';
import { createElement as h, act } from 'react';
import { stubStore } from './support/stubs.ts';

const store = fakeStore({ threads: { chat: { cwd: '/work/app' } } });
stubStore(store.exports);
// the switch's row and what pressing it does, as useRemoteControlRow gives them (tests/useRemoteControlRow.test.ts)
let row: any = {};
const sets: boolean[] = [];
const opened: string[] = [];
const base = {
  visible: true,
  on: false,
  disabled: false,
  note: null,
  url: null,
  confirmOn: false,
  set: (on: boolean) => void sets.push(on),
};
mock.module('../src/session/useRemoteControlRow.ts', { namedExports: { useRemoteControlRow: () => row } });
mock.module('../src/session/open.ts', { namedExports: { openLink: (u: string) => opened.push(u) } });
const { SummaryMachine, SummaryRemoteControl } = await import('../src/components/panels/SummaryEnvironment.tsx');

beforeEach(() => {
  store.set({ threads: { chat: { cwd: '/work/app' } } });
  row = { ...base };
  sets.length = 0;
  opened.length = 0;
});
const toggle = (host: HTMLElement) => one(host, '[role="switch"]') as HTMLButtonElement;

test('a local chat names this computer, with the laptop glyph and its name on hover', async () => {
  const r = await render(h(SummaryMachine, { machine: null, pending: false }));
  const chip = one(r.host, '.summary-machine');
  assert.equal(chip.textContent, 'This computer');
  assert.equal(chip.getAttribute('title'), 'This computer');
  assert.ok(chip.querySelector('svg.lucide-laptop'));
  await r.unmount();
});

test('the rail waits for the owner and uses the machine identity behind its repository actions', async () => {
  const machine = { id: 'ssh:me@box', name: 'box', away: false };
  const r = await render(h(SummaryMachine, { machine: null, pending: true }));
  assert.equal(r.host.textContent, '');
  await r.rerender(h(SummaryMachine, { machine, pending: false }));
  assert.equal(r.host.querySelector('.summary-label')!.textContent, 'box');
  assert.ok(r.host.querySelector('svg.lucide-server'), 'another machine shows the server glyph');
  await r.unmount();
});

test('the Remote Control row stands alone: one row, its switch, and no folder or machine', async () => {
  const r = await render(h(SummaryRemoteControl, { threadId: 'chat' }));
  assert.equal(r.host.querySelectorAll('.summary-row').length, 1);
  assert.match(one(r.host, '.summary-remote').textContent!, /^Remote Control$/);
  assert.ok(one(r.host, '[role="switch"]'));
  await r.unmount();
});

test('the switch links an unlinked chat and unlinks a linked one', async () => {
  const r = await render(h(SummaryRemoteControl, { threadId: 'chat' }));
  assert.equal(toggle(r.host).getAttribute('aria-checked'), 'false');
  await act(async () => toggle(r.host).click());
  assert.deepEqual(sets, [true]);
  row = { ...base, on: true, note: 'Linked to claude.ai' };
  await r.rerender(h(SummaryRemoteControl, { threadId: 'chat' }));
  assert.equal(toggle(r.host).getAttribute('aria-checked'), 'true');
  assert.match(r.host.textContent!, /Linked to claude\.ai/);
  await act(async () => toggle(r.host).click());
  assert.deepEqual(sets, [true, false]);
  await r.unmount();
});

test('a link that is up has an Open button for its page, and one still coming up has none', async () => {
  row = { ...base, on: true, note: 'Linked to claude.ai', url: 'https://claude.ai/code/s' };
  const r = await render(h(SummaryRemoteControl, { threadId: 'chat' }));
  await act(async () => (one(r.host, '.link-btn') as HTMLButtonElement).click());
  assert.deepEqual(opened, ['https://claude.ai/code/s']);
  row = { ...base, on: true, note: 'Connecting…' };
  await r.rerender(h(SummaryRemoteControl, { threadId: 'chat' }));
  assert.equal(r.host.querySelector('.link-btn'), null);
  assert.match(r.host.textContent!, /Connecting…/);
  await r.unmount();
});

test('a switch that cannot be pressed stays off and sets nothing, with its reason beside it', async () => {
  row = { ...base, disabled: true, note: 'Not available for this chat' };
  const r = await render(h(SummaryRemoteControl, { threadId: 'chat' }));
  assert.equal(toggle(r.host).disabled, true);
  assert.match(r.host.textContent!, /Not available for this chat/);
  await act(async () => toggle(r.host).click());
  assert.deepEqual(sets, []);
  await r.unmount();
});

test('a switch that reaches past this chat asks before it turns on, and turning it off needs no question', async () => {
  row = { ...base, confirmOn: true };
  const r = await render(h(SummaryRemoteControl, { threadId: 'chat' }));
  const dialog = () => r.host.querySelector('[role="alertdialog"]');
  assert.equal(dialog(), null);
  await act(async () => toggle(r.host).click());
  assert.match(dialog()!.textContent!, /Allow devices to control this computer\?/);
  assert.deepEqual(sets, []);
  // Cancel and Escape leave it off
  await act(async () => (r.host.querySelector('.acct-dialog-actions .btn:not(.primary)') as HTMLElement).click());
  assert.equal(dialog(), null);
  await act(async () => toggle(r.host).click());
  await act(async () => void dialog()!.parentElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  assert.equal(dialog(), null);
  assert.deepEqual(sets, []);
  // Allow turns it on
  await act(async () => toggle(r.host).click());
  await act(async () => (r.host.querySelector('.acct-dialog-actions .btn.primary') as HTMLElement).click());
  assert.equal(dialog(), null);
  assert.deepEqual(sets, [true]);
  // off is pressed directly
  row = { ...base, on: true, confirmOn: true };
  await r.rerender(h(SummaryRemoteControl, { threadId: 'chat' }));
  await act(async () => toggle(r.host).click());
  assert.equal(dialog(), null);
  assert.deepEqual(sets, [true, false]);
  await r.unmount();
});

test('an account that becomes unavailable retires its pending confirmation', async () => {
  row = { ...base, confirmOn: true };
  const r = await render(h(SummaryRemoteControl, { threadId: 'chat' }));
  await act(() => toggle(r.host).click());
  assert.ok(r.host.querySelector('[role="alertdialog"]'));
  row = { ...row, disabled: true, note: 'Sign in again' };
  await r.rerender(h(SummaryRemoteControl, { threadId: 'chat' }));
  row = { ...base, confirmOn: true };
  await r.rerender(h(SummaryRemoteControl, { threadId: 'chat' }));
  assert.equal(r.host.querySelector('[role="alertdialog"]'), null);
  assert.deepEqual(sets, []);
  await r.unmount();
});

test('a chat without native Remote Control has no disabled switch in the rail', async () => {
  row = { ...base, visible: false, disabled: true };
  const r = await render(h(SummaryRemoteControl, { threadId: 'chat' }));
  assert.equal(r.host.querySelector('[role="switch"]'), null);
  await r.unmount();
});

test('a switch with devices to manage offers Manage while it is on, and only then', async () => {
  const managed: number[] = [];
  row = { ...base, on: true, note: 'Connected · this computer', manage: () => void managed.push(1) };
  const r = await render(h(SummaryRemoteControl, { threadId: 'chat' }));
  const manage = () => [...r.host.querySelectorAll('button')].find((b) => b.textContent === 'Manage');
  await act(async () => manage()!.click());
  assert.deepEqual(managed, [1]);
  row = { ...base, on: false, manage: () => void managed.push(2) };
  await r.rerender(h(SummaryRemoteControl, { threadId: 'chat' }));
  assert.equal(manage(), undefined);
  row = { ...base, on: true };
  await r.rerender(h(SummaryRemoteControl, { threadId: 'chat' }));
  assert.equal(manage(), undefined);
  await r.unmount();
});
