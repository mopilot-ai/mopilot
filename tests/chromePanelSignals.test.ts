// The usage warnings main keeps for the Chrome side panel (electron/app/chromePanelSignals.cjs): Claude Code's per chat and per window, heard from every chat's events whether or not a panel shows it; Codex's read through the pool's per-login windows; none for a basic harness.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { ChatSignals, MAX_CHATS } = createRequire(import.meta.url)('../electron/app/chromePanelSignals.cjs');

const NOW = 1_700_000_000_000;
const reset = (ms: number) => Math.floor((NOW + ms) / 1000);
const chatOf = (key: string) => `chat-${key}`;
const rate = (key: string, info: object, over: object = {}) => ({
  key,
  kind: 'message',
  msg: { type: 'rate_limit_event', rate_limit_info: info, ...over },
});
const warn = (type = 'five_hour', ms = 3_600_000, utilization = 0.9) => ({
  status: 'allowed_warning',
  rateLimitType: type,
  utilization,
  resetsAt: reset(ms),
});
const allowed = (type: string) => ({ status: 'allowed', rateLimitType: type, utilization: 0.2 });
const windowOf = (usedPercent: number, windowDurationMins: number, ms = 3_600_000) => ({
  usedPercent,
  windowDurationMins,
  resetsAt: reset(ms),
});

function signals(codexLimits?: (chatId: string) => any) {
  const clock = { now: NOW };
  return { s: new ChatSignals({ now: () => clock.now, ...(codexLimits ? { codexLimits } : {}) }), clock };
}

test('a Claude Code warning is kept for the chat of the session that heard it, even though no panel watches the chat yet', () => {
  const { s } = signals();
  s.event('claude', rate('a', warn()), chatOf);
  assert.deepEqual(s.warningOf('chat-a', 'claude'), {
    kind: 'approaching',
    window: '5h',
    resetsAt: reset(3_600_000) * 1000,
    utilization: 0.9,
  });
  assert.equal(s.warningOf('chat-b', 'claude'), null);
});

test('a warning is kept per window: another window’s allowed event does not clear it, its own does, and a refusal of its own window is the limit itself', () => {
  const { s } = signals();
  s.event('claude', rate('a', warn('seven_day')), chatOf);
  // a standing weekly warning survives an allowed event for the five-hour window
  s.event('claude', rate('a', allowed('five_hour')), chatOf);
  assert.equal(s.warningOf('chat-a', 'claude')?.window, '7d');
  // and an event that names no window the banner knows (extra usage, none)
  s.event('claude', rate('a', { status: 'allowed', rateLimitType: 'overage' }), chatOf);
  s.event('claude', rate('a', { status: 'allowed' }), chatOf);
  assert.equal(s.warningOf('chat-a', 'claude')?.window, '7d');
  s.event('claude', rate('a', allowed('seven_day')), chatOf);
  assert.equal(s.warningOf('chat-a', 'claude'), null);
  assert.equal(s.claude.size, 0, 'no empty slot is kept');
  s.event('claude', rate('a', warn('five_hour')), chatOf);
  s.event('claude', rate('a', { status: 'rejected', rateLimitType: 'five_hour', resetsAt: reset(1000) }), chatOf);
  assert.equal(s.warningOf('chat-a', 'claude'), null);
});

test('two near windows are both kept; the one nearer its limit shows, and when it goes the other shows', () => {
  const { s } = signals();
  s.event('claude', rate('a', warn('five_hour', 3_600_000, 0.8)), chatOf);
  s.event('claude', rate('a', warn('seven_day', 86_400_000, 0.95)), chatOf);
  assert.equal(s.warningOf('chat-a', 'claude')?.window, '7d');
  s.event('claude', rate('a', allowed('seven_day')), chatOf);
  assert.equal(s.warningOf('chat-a', 'claude')?.window, '5h');
  // a window with no used fraction counts as the least used
  s.event('claude', rate('a', { ...warn('seven_day'), utilization: undefined }), chatOf);
  assert.equal(s.warningOf('chat-a', 'claude')?.window, '5h');
  s.event('claude', rate('b', { ...warn('five_hour'), utilization: undefined }), chatOf);
  s.event('claude', rate('b', { ...warn('seven_day'), utilization: 0.1 }), chatOf);
  assert.equal(s.warningOf('chat-b', 'claude')?.window, '7d');
});

test('two windows as close as each other: the one heard last shows, and hearing a window again makes it the latest', () => {
  const { s } = signals();
  s.event('claude', rate('a', warn('five_hour')), chatOf);
  s.event('claude', rate('a', warn('seven_day', 86_400_000)), chatOf);
  assert.equal(s.warningOf('chat-a', 'claude')?.window, '7d');
  s.event('claude', rate('a', warn('five_hour')), chatOf);
  assert.equal(s.warningOf('chat-a', 'claude')?.window, '5h');
});

test('a warning goes at its own window’s reset, and only then: an idle session closing or failing does not clear it', () => {
  const { s, clock } = signals();
  s.event('claude', rate('a', warn('five_hour', 1_000, 0.95)), chatOf);
  s.event('claude', rate('a', warn('seven_day', 86_400_000)), chatOf);
  for (const kind of ['closed', 'error']) {
    s.event('claude', { key: 'a', kind }, chatOf);
    assert.equal(s.warningOf('chat-a', 'claude')?.window, '5h', kind);
  }
  // the five-hour window resets: only the weekly one stands
  clock.now += 2_000;
  assert.equal(s.warningOf('chat-a', 'claude')?.window, '7d');
  assert.equal(s.claude.get('chat-a').windows.size, 1, 'the reset window is dropped for good, not only hidden');
  clock.now += 86_400_000;
  assert.equal(s.warningOf('chat-a', 'claude'), null);
  assert.equal(s.claude.size, 0);
});

test('another login’s process takes the chat’s earlier warnings with it; a process that names no login, or the same one, does not', () => {
  const { s } = signals();
  const as = (account: string | undefined, info: object) => ({ ...rate('a', info), ...(account ? { account } : {}) });
  s.event('claude', as('login-1', warn('seven_day')), chatOf);
  s.event('claude', as('login-1', warn('five_hour')), chatOf);
  assert.equal(s.claude.get('chat-a').windows.size, 2);
  s.event('claude', as(undefined, allowed('five_hour')), chatOf);
  assert.deepEqual([...s.claude.get('chat-a').windows.keys()], ['7d'], 'no login named: the slot stays and the event applies to it');
  // the chat's login changed: the weekly warning was the first login's
  s.event('claude', as('login-2', warn('five_hour')), chatOf);
  assert.deepEqual([...s.claude.get('chat-a').windows.keys()], ['5h']);
  assert.equal(s.claude.get('chat-a').account, 'login-2');
  // a first event with no login named, in a chat whose slot names none
  s.event('claude', as(undefined, warn('seven_day')), chatOf);
  assert.equal(s.claude.get('chat-a').account, 'login-2', 'the login stays what was named last');
  s.event('claude', rate('z', warn()), chatOf);
  assert.equal(s.claude.get('chat-z').account, null);
});

test('a key run, a sub-agent and other events change nothing', () => {
  const { s } = signals();
  s.event('claude', rate('b', warn(), { parent_tool_use_id: 'agent' }), chatOf);
  s.event('claude', { ...rate('c', warn()), login: false }, chatOf);
  s.event('claude', { key: 'd', kind: 'message', msg: { type: 'assistant' } }, chatOf);
  s.event('claude', { key: 'd', kind: 'message' }, chatOf);
  s.event('claude', { key: 'd', kind: 'stderr' }, chatOf);
  s.event('claude', { kind: 'message', msg: rate('x', warn()).msg }, chatOf);
  s.event('claude', null, chatOf);
  for (const id of ['b', 'c', 'd', 'x']) assert.equal(s.warningOf(`chat-${id}`, 'claude'), null);
  assert.equal(s.claude.size, 0);
});

test('the kept Claude warnings are bounded and shed those whose window reset', () => {
  const { s, clock } = signals();
  s.event('claude', rate('old', warn('five_hour', 1000)), chatOf);
  clock.now += 2000;
  s.event('claude', rate('new', warn()), chatOf);
  assert.equal(s.claude.has('chat-old'), false);
  for (let i = 0; i < MAX_CHATS + 5; i++) s.event('claude', rate(`k${i}`, warn()), chatOf);
  assert.equal(s.claude.size, MAX_CHATS);
  assert.equal(s.warningOf(`chat-k${MAX_CHATS + 4}`, 'claude')?.window, '5h');
  assert.equal(s.claude.has('chat-k0'), false);
});

test('Codex: the windows come from the pool for the chat’s own login, read at each question; none when the pool cannot say', () => {
  const asked: string[] = [];
  const windows: Record<string, any> = {
    pinned: { primary: windowOf(90, 300), secondary: windowOf(10, 10080) },
    quiet: { primary: windowOf(10, 300), secondary: null },
  };
  const { s } = signals((chatId) => (asked.push(chatId), windows[chatId] ?? null));
  assert.equal(s.warningOf('pinned', 'codex')?.window, '5h');
  assert.equal(s.warningOf('quiet', 'codex'), null);
  assert.equal(s.warningOf('unknown', 'codex'), null, 'a chat whose login cannot be told shows no warning, not another login’s');
  assert.deepEqual(asked, ['pinned', 'quiet', 'unknown']);
  // the pool's reading moves on: the next question sees it
  windows.pinned = { primary: windowOf(20, 300), secondary: windowOf(80, 10080) };
  assert.equal(s.warningOf('pinned', 'codex')?.window, '7d');
  // Codex events are the pool's to read, not this service's
  s.event('codex', { method: 'account/rateLimits/updated', params: { rateLimits: { primary: windowOf(99, 300) } } }, chatOf);
  assert.equal(s.warningOf('quiet', 'codex'), null);
});

test('a chat shows the warning of the harness it runs on now, a basic (ACP) harness has none, and an unknown family hears and warns of nothing', () => {
  const { s } = signals(() => ({ primary: windowOf(90, 300) }));
  s.event('claude', rate('a', warn('seven_day')), chatOf);
  assert.equal(s.warningOf('chat-a', 'claude')?.window, '7d');
  assert.equal(s.warningOf('chat-a', 'codex')?.window, '5h');
  assert.equal(s.warningOf('chat-a', 'acp'), null);
  assert.equal(s.warningOf('chat-a', null), null);
  assert.equal(s.warningOf('chat-a', undefined), null);
  s.event('acp', { key: 'a', kind: 'update' }, chatOf);
  s.event('future' as any, rate('a', warn()), chatOf);
  assert.equal(s.warningOf('chat-a', 'future' as any), null);
});

test('with no clock or pool given it reads the real clock and no Codex windows', () => {
  const s = new ChatSignals();
  s.event(
    'claude',
    rate('a', { status: 'allowed_warning', rateLimitType: 'five_hour', resetsAt: Math.floor(Date.now() / 1000) + 600 }),
    chatOf,
  );
  assert.equal(s.warningOf('chat-a', 'claude')?.window, '5h');
  assert.equal(s.warningOf('chat-a', 'codex'), null);
});
