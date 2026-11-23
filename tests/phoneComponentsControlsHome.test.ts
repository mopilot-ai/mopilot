// Pinning and the scheduled list on the phone's home screen, and the way into a chat's settings: offered only where the Mac has them, with working, error and Mac-too-old states.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot, flush, click } from './support/phone/component-kit';
import { scripted } from './support/phone/m3';
const modulePath = '../mobile/src/MobileApp';
/** Scheduled is in the drawer behind Chats. */
const openScheduled = async () => {
  await click('Open menu');
  await click('Scheduled');
};
const { MobileApp } = await import(modulePath);

const ONLINE = {
  phase: 'online',
  generation: 1,
  user: { id: 'u' },
  pairs: [{ pairId: 'p', macId: 'm', name: 'Mac' }],
  selectedPair: 'p',
  safetyNumber: null,
  pendingPair: false,
  error: null,
};
const PIN = ['chats.pin', 'scheduled.list', 'options.get', 'options.set', 'chat.switch'];

/** A phone on a Mac that offers `methods`, listing `chats`; `over` replaces a method's answer. */
function phone(methods: string[], chats: any[], over: (m: string, p: any) => unknown = () => undefined) {
  const listed = { chats };
  const made = scripted((m, p) => {
    const given = over(m, p);
    if (given !== undefined) return given;
    if (m === 'machine.hello') return { capabilities: { methods, permissionCeiling: 'auto-review' } };
    if (m === 'chats.recent') return listed;
    if (m === 'chats.pin') {
      const row = listed.chats.find((c) => c.id === p.chatId);
      if (row) row.pinned = p.pinned;
      return { pinned: p.pinned };
    }
    if (m === 'options.get')
      return {
        models: [{ id: 'm1', label: 'M1', efforts: [], defaultEffort: null }],
        model: 'm1',
        effort: null,
        harness: 'Claude Code',
        harnessId: 'claude',
        switching: false,
        permission: { value: 'default', rows: [{ id: 'default', label: 'Ask', detail: 'd' }] },
      };
    return undefined;
  }, ONLINE);
  made.runtime.start = async () => {};
  return made;
}
const mounted: any[] = [];
async function mount(runtime: any, props: Record<string, unknown> = {}) {
  for (const old of mounted.splice(0)) await act(async () => old.root.unmount()), old.host.remove();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  await act(async () => root.render(createElement(MobileApp, { runtime, ...props })));
  await flush();
  return { host, root };
}
const has = (host: HTMLElement, re: RegExp) => assert.match(host.textContent!, re);
const lacks = (host: HTMLElement, re: RegExp) => assert.doesNotMatch(host.textContent!, re);
const label = (host: HTMLElement, l: string) => host.querySelector(`button[aria-label="${l}"]`) as HTMLButtonElement | null;
const CHATS = () => [
  { id: 'claude:1', title: 'First', harness: 'claude', pinned: false },
  { id: 'codex:2', title: 'Second', harness: 'codex', pinned: true, account: 'me@x.com' },
];

test('a pinned chat stays in its place in the list, says so to a screen reader, and is listed under Pinned in the drawer', async () => {
  const { runtime } = phone(PIN, CHATS());
  const { host } = await mount(runtime);
  has(host, /Secondme@x\.com/);
  assert.equal(label(host, 'Open chat Second')!.getAttribute('aria-valuetext'), 'Idle, Codex, Account me@x.com, Pinned');
  assert.doesNotMatch(label(host, 'Open chat First')!.getAttribute('aria-valuetext')!, /Pinned/);
  lacks(host, /Pinned/);
  await click('Open menu');
  has(host, /Pinned○SecondRecents○First/);
});

test('the scheduled list opens from the home screen, reads the Mac’s tasks and goes back', async () => {
  const now = Date.now();
  const { runtime, calls } = phone(PIN, CHATS(), (m) =>
    m === 'scheduled.list'
      ? {
          tasks: [
            { id: 't1', name: 'Nightly tests', next: now + 90 * 60_000 },
            { id: 't2', name: 'Paused one', next: null },
          ],
        }
      : undefined,
  );
  const { host } = await mount(runtime);
  assert.equal(host.querySelector('[data-stack]')?.getAttribute('data-stack'), 'home');
  await openScheduled();
  // a pushed screen over the list
  assert.equal(host.querySelector('[data-stack]')?.getAttribute('data-stack'), 'home scheduled');
  assert.ok(calls.some((c) => c[0] === 'scheduled.list'));
  has(host, /Nightly tests/);
  has(host, /In 1 h 30 min|In 1 h 29 min/);
  has(host, /Paused one/);
  has(host, /No upcoming run/);
  has(host, /Change schedules on your computer/);
  await click('Back');
  assert.equal(host.querySelector('[data-stack]')?.getAttribute('data-stack'), 'home');
});

test('an empty list, an older Mac and a failed read each say what is true', async () => {
  const empty = phone(PIN, CHATS(), (m) => (m === 'scheduled.list' ? { tasks: [] } : undefined));
  const a = await mount(empty.runtime);
  await openScheduled();
  has(a.host, /Nothing is scheduled on this computer/);
  const old = phone(['chats.pin'], CHATS());
  const b = await mount(old.runtime);
  await openScheduled();
  has(b.host, /Update MoPilot on your computer to see scheduled tasks from your phone/);
  assert.ok(!old.calls.some((c) => c[0] === 'scheduled.list'));
  let fail = true;
  const broken = phone(PIN, CHATS(), (m) => {
    if (m !== 'scheduled.list') return undefined;
    if (fail) throw new Error('Computer is offline');
    return { tasks: [] };
  });
  const c = await mount(broken.runtime);
  await openScheduled();
  has(c.host, /offline or asleep/);
  fail = false;
  await click('Retry');
  has(c.host, /Nothing is scheduled on this computer/);
  lacks(c.host, /offline or asleep/);
});

test('the model pill opens the chat’s settings over its messages, and another chat starts at its own messages', async () => {
  const { runtime, calls } = phone(PIN, CHATS());
  const { host } = await mount(runtime);
  await act(async () => label(host, 'Open chat First')!.click());
  await flush();
  await click('Model, M1');
  has(host, /Select model/);
  assert.deepEqual(calls.find((c) => c[0] === 'options.get')![1], { chatId: 'claude:1' });
  await click('Dismiss');
  lacks(host, /Select model/);
  has(host, /Message this chat|No messages yet/);
  await click('Back to chats');
  assert.ok(label(host, 'Open chat Second'), 'back at the list');
  // another chat starts at its messages, not at the settings of the one left
  await act(async () => label(host, 'Open chat Second')!.click());
  await flush();
  lacks(host, /Select model/);
  has(host, /Message this chat|No messages yet/);
});

test('a tapped notification takes the person out of the scheduled list and into its chat', async () => {
  let ui: any = { step: 'granted', busy: false, target: null, prefs: {} };
  const listeners = new Set<() => void>();
  const push: any = {
    ui: () => ui,
    subscribe: (f: () => void) => (listeners.add(f), () => listeners.delete(f)),
    start: async () => {},
    stop: () => {},
    consumeTarget: () => {},
    setOpenChat: () => {},
    signOut: async () => {},
  };
  const { runtime } = phone(PIN, CHATS());
  const { host } = await mount(runtime, { push });
  await openScheduled();
  has(host, /Change schedules on your computer/);
  ui = { ...ui, target: { pairId: 'p', chatId: 'claude:1' } };
  await act(async () => listeners.forEach((f) => f()));
  await flush();
  lacks(host, /Change schedules on your computer/);
  has(host, /Message this chat|No messages yet/);
});
