// The Mac's Host attention surfaces and the sidebar location that stays visible when unattended attention is off.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { FLAG_DEFS } from '../shared/flagDefs.mjs';
import { createElement as h, act } from 'react';
import './support/dom.ts';
import { render, one } from './support/shell-panels-kit.ts';
import { mockSource } from './support/stubs.ts';
import { fakeNative } from './support/ports/native.ts';
import { installNative } from '../src/lib/native.ts';

let flag = true;
let signInAsked = false;
mockSource('src/session/machineAuthBox.ts', { useAuthBoxShown: () => signInAsked });
mockSource('src/lib/flags.ts', { useFlag: () => flag, isEnabled: () => flag, harnessEnabled: () => true, useEnabledHarnesses: () => [] });
let machine: { id: string; name: string; away: boolean; row?: { linkDroppedAt?: number } } | null = {
  id: 'ssh:box',
  name: 'build-box',
  away: false,
};
mockSource('src/lib/chatMachine.ts', {
  useChatMachine: () => ({ machine, pending: false }),
  useLocalFolder: () => ({ cwd: '', machine, pending: false }),
  useFolderHere: () => '',
  useRemoteFolderValue: () => null,
});
const sent: any[] = [];
const opened: string[] = [];
mockSource('src/store/send.ts', { sendMessage: async (...a: unknown[]) => void sent.push(a) });
mockSource('src/store/chats.ts', { openMachines: () => void opened.push('connections:other') });

let listener: ((e: { chatId: string; attention: any }) => void) | null = null;
let initial: Record<string, any> = {};
installNative(
  fakeNative({
    host: {
      attentions: async () => initial,
      onAttention: (cb: any) => ((listener = cb), () => (listener = null)),
    },
  }),
);
const { useChatAttention, resetChatAttention } = await import('../src/lib/chatAttention.ts');
const { HostAttentionStrip, HostLineStrip } = await import('../src/components/composer/HostAttentionStrip.tsx');
const { ThreadMachineLine, useRowMachineLine } = await import('../src/components/sidebar/ThreadMachineLine.tsx');
const { CardClock } = await import('../src/components/thread/approvals/CardClock.tsx');

const tick = () => new Promise((r) => setImmediate(r));
beforeEach(() => {
  flag = true;
  signInAsked = false;
  machine = { id: 'ssh:box', name: 'build-box', away: false };
  initial = {};
  sent.length = 0;
  opened.length = 0;
  resetChatAttention();
});

function Probe() {
  return h('i', { 'data-out': JSON.stringify(useChatAttention('c1')) });
}
const out = (host: HTMLElement) => JSON.parse(one(host, 'i').getAttribute('data-out')!);

test('the store reads what waits, follows each change, and says nothing with the flag off or no chat', async () => {
  initial = { c1: { kind: 'paused', reason: 'approval_timeout' } };
  const r = await render(h(Probe));
  await act(tick);
  assert.deepEqual(out(r.host), { kind: 'paused', reason: 'approval_timeout' });
  await act(async () => listener!({ chatId: 'c1', attention: { kind: 'limit' } }));
  assert.deepEqual(out(r.host), { kind: 'limit' });
  await act(async () => listener!({ chatId: 'c1', attention: null }));
  assert.equal(out(r.host), null);
  await act(async () => listener!({ chatId: 'c1', attention: { kind: 'approval', since: 1 } }));
  flag = false;
  await r.rerender(h(Probe));
  assert.equal(out(r.host), null, 'flag off');
  await r.unmount();
});

test('an answer that is no list names no chat', async () => {
  (initial as any) = null;
  const r = await render(h(Probe));
  await act(tick);
  assert.equal(out(r.host), null);
  await r.unmount();
});

async function strip(attention: any) {
  initial = attention ? { chat: attention } : {};
  resetChatAttention();
  const r = await render(h(HostAttentionStrip, { threadId: 'chat' }));
  await act(tick);
  return r;
}

test('paused: the strip says the minutes the Host gave the card', async () => {
  const r = await strip({ kind: 'paused', reason: 'approval_timeout', pauseMinutes: 5 });
  assert.match(r.host.textContent!, /^Paused: no answer in 5 minResume$/);
  await r.unmount();
});

test('paused: the strip says so and Resume sends "Continue." as the person', async () => {
  const r = await strip({ kind: 'paused', reason: 'approval_timeout' });
  assert.match(r.host.textContent!, /^Paused: no answer in 30 minResume$/);
  await act(async () => (one(r.host, 'button', 'Resume') as HTMLButtonElement).click());
  assert.deepEqual(sent, [['chat', 'Continue.']]);
  await r.unmount();
});

test('credential: no strip while the failed turn asks for the sign-in; with no such turn the strip draws and opens the machine’s settings', async () => {
  signInAsked = true;
  let r = await strip({ kind: 'credential' });
  assert.equal(r.host.textContent, '');
  await r.unmount();
  signInAsked = false;
  r = await strip({ kind: 'credential' });
  assert.match(r.host.textContent!, /^build-box needs this Mac to sign in againSign in$/);
  await act(async () => (one(r.host, 'button', 'Sign in') as HTMLButtonElement).click());
  assert.deepEqual(opened, ['connections:other']);
  await r.unmount();
});

test('limit: the Mac’s action opens the machine’s settings; an approval, a machine that is up and a chat on this Mac show no strip', async () => {
  let r = await strip({ kind: 'limit' });
  assert.match(r.host.textContent!, /^Limit reachedRaise limit$/);
  opened.length = 0;
  await act(async () => (one(r.host, 'button', 'Raise limit') as HTMLButtonElement).click());
  assert.deepEqual(opened, ['connections:other']);
  await r.unmount();
  r = await strip({ kind: 'approval', since: 1 });
  assert.equal(r.host.textContent, '');
  await r.unmount();
  r = await strip(null);
  assert.equal(r.host.textContent, '');
  await r.unmount();
  machine = null;
  r = await strip({ kind: 'paused' });
  assert.equal(r.host.textContent, '');
  await r.unmount();
});

test('an offline machine reads as it does today, with no action', async () => {
  machine = { id: 'ssh:box', name: 'build-box', away: true };
  const r = await strip(null);
  assert.equal(r.host.textContent, 'build-box is offline');
  assert.equal(r.host.querySelector('button'), null);
  await r.unmount();
});

function RowProbe() {
  const line = useRowMachineLine('chat');
  return h('div', { 'data-machine': line?.id }, line?.word ? h(ThreadMachineLine, { word: line.word }) : null);
}

test('the row uses only the attention word; clearing attention or turning the flag off keeps its location', async () => {
  initial = { chat: { kind: 'approval', since: 1 } };
  const r = await render(h(RowProbe));
  await act(tick);
  assert.equal(r.host.textContent, 'Needs you');
  assert.equal(r.host.firstElementChild?.getAttribute('data-machine'), 'ssh:box');
  await act(async () => listener!({ chatId: 'elsewhere', attention: { kind: 'paused' } }));
  assert.equal(r.host.textContent, 'Needs you');
  await act(async () => listener!({ chatId: 'chat', attention: null }));
  assert.equal(r.host.textContent, '');
  machine = { id: 'ssh:box', name: 'build-box', away: true };
  await r.rerender(h(RowProbe));
  assert.equal(r.host.textContent, 'Offline');
  flag = false;
  await r.rerender(h(RowProbe));
  assert.equal(r.host.textContent, '');
  assert.equal(r.host.firstElementChild?.getAttribute('data-machine'), 'ssh:box');
  machine = null;
  await r.rerender(h(RowProbe));
  assert.equal(r.host.firstElementChild?.hasAttribute('data-machine'), false);
  await r.unmount();
});

test('the card clock: nothing before the reminder, then the Host’s minutes; nothing without an approval clock', async () => {
  const at = (ago: number) => {
    initial = { chat: { kind: 'approval', since: Date.now() - ago } };
    resetChatAttention();
  };
  at(60_000);
  let r = await render(h(CardClock, { threadId: 'chat' }));
  await act(tick);
  assert.equal(r.host.textContent, '');
  await r.unmount();
  at(11 * 60_000);
  r = await render(h(CardClock, { threadId: 'chat' }));
  await act(tick);
  assert.match(r.host.textContent!, /^Pauses in (19|20) min$/);
  await r.unmount();
  initial = { chat: { kind: 'paused' } };
  resetChatAttention();
  r = await render(h(CardClock, { threadId: 'chat' }));
  await act(tick);
  assert.equal(r.host.textContent, '');
  await r.unmount();
  r = await render(h(CardClock, { threadId: undefined }));
  assert.equal(r.host.textContent, '');
  await r.unmount();
});

test('the composer line is the attention strip with the flag and the offline strip without it', async () => {
  initial = { chat: { kind: 'paused', reason: 'approval_timeout' } };
  let r = await render(h(HostLineStrip, { threadId: 'chat' }));
  await act(tick);
  assert.match(r.host.textContent ?? '', /Resume/);
  flag = false;
  r = await render(h(HostLineStrip, { threadId: 'chat' }));
  await act(tick);
  assert.doesNotMatch(r.host.textContent ?? '', /Resume/);
});

test('host.unattended ships on: the attention surfaces show without anyone switching a flag', () => {
  const def = FLAG_DEFS.find((d: { key: string }) => d.key === 'host.unattended');
  assert.equal(def?.default, true);
  assert.equal(def?.mode, 'toggle');
});

test('a machine whose link dropped under 90 s ago says Reconnecting, not offline and not nothing (chat C22)', async () => {
  machine = { id: 'ssh:box', name: 'build-box', away: false, row: { linkDroppedAt: Date.now() - 20_000 } };
  const r = await strip(null);
  assert.equal(r.host.textContent, 'Reconnecting to build-box…');
  assert.equal(r.host.querySelector('button'), null, 'nothing to press: it comes back by itself');
  await r.unmount();
  machine = { id: 'ssh:box', name: 'build-box', away: false, row: { linkDroppedAt: Date.now() - 91_000 } };
  const late = await strip(null);
  assert.equal(late.host.textContent, '', 'a drop older than the window is the registry to call: nothing here');
  await late.unmount();
});
