// A chat that stopped on its harness's usage limit reaches the side panel's read as `limit` ({ key, window, resetsAt }), on every harness: Claude Code's rejected rate limit,
// Codex's usageLimitExceeded turn error, a basic (ACP) harness's rate-limit error. The panel's usage banner reads it (it used to read a field main never sent).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { setup, codex } from './support/controller/fixture.ts';

const require = createRequire(import.meta.url);
const { createChromePanel, projectsFileOf } = require('../electron/app/chromePanel.cjs');
const { ChatSignals } = require('../electron/app/chromePanelSignals.cjs');

const KEY = 'acp:test:th-1';
const soon = () => Math.floor(Date.now() / 1000) + 3600;
const rejected = (type = 'five_hour') => ({
  key: 'th-1',
  kind: 'message',
  msg: { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: type, utilization: 1, resetsAt: soon() } },
});

/** A panel over a chat on `kind` whose history is `turns`. */
function wired(t: any, kind: string, identity?: any, turns: any[] = []) {
  const h = setup();
  t.after(() => fs.rmSync(h.chats.dir, { recursive: true, force: true }));
  h.chats.records.set('th-1', { id: 'th-1', segments: [{ kind, nativeId: 'th-1' }], meta: {} } as any);
  const live: any = { chats: h.chats, controller: h.c, identity, peerRuntime: { readHistory: async () => ({ turns }) } };
  const panel = createChromePanel({
    live,
    sources: {},
    home: h.chats.dir,
    projectsFile: projectsFileOf(h.chats.dir),
    prefs: () => ({}),
    usable: async () => true,
    starter: {},
    send: async () => {},
    open: () => {},
  });
  const read = () =>
    new Promise<any>(
      (resolve) => void panel.handle({ id: 1, method: 'read', params: { chatId: 'th-1' } }, (r: any) => resolve(r.result ?? r)),
    );
  return { h, read };
}

const pool = (windows: any) => ({ driver: (harness: string) => (harness === 'codex' ? { chatLimits: () => windows } : null) });

test('a Claude Code chat that stopped on a rejected request reads the limit with its window and reset; sending again clears it', async (t) => {
  const { h, read } = wired(t, 'claude');
  assert.equal((await read()).limit, undefined);
  h.c.send('th-1', { text: 'go' }, 1);
  h.c.onClaudeEvent(rejected('seven_day'));
  // a running turn is not stopped on a limit yet
  assert.equal((await read()).limit, undefined);
  h.c.onLimit('th-1');
  h.c.onClaudeEvent({ key: 'th-1', kind: 'message', msg: { type: 'result', subtype: 'success' } });
  h.c.end('th-1', { outcome: 'failed' });
  const r = await read();
  assert.equal(r.state, 'idle');
  assert.deepEqual([r.limit.window, r.limit.resetsAt > Date.now()], ['7d', true]);
  assert.match(r.limit.key, /^limit-\d+$/);
  // the same read again is the same episode
  assert.equal((await read()).limit.key, r.limit.key);
  // the user sends again: the chat is no longer stopped
  await h.c.send('th-1', { text: 'again' }, 2);
  assert.equal((await read()).limit, undefined);
});

test('a Codex chat that ended on usageLimitExceeded reads the used-up window of the login serving it', async (t) => {
  const used = {
    primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: soon() },
    secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: soon() },
  };
  const { h, read } = wired(t, 'codex', pool(used));
  h.c.send('th-1', { text: 'go' }, 1);
  h.c.onCodexMessage(codex('turn/started', { threadId: 'th-1', turn: { id: 'T' } }));
  h.c.onCodexMessage(
    codex('turn/completed', { threadId: 'th-1', turn: { id: 'T', status: 'failed', error: { codexErrorInfo: 'usageLimitExceeded' } } }),
  );
  const r = await read();
  assert.equal(r.state, 'idle');
  assert.equal(r.limit.window, '5h');
  assert.ok(r.limit.resetsAt > Date.now());
});

test('a Codex chat whose pool names no used-up window still reads the limit, with no window', async (t) => {
  const { h, read } = wired(t, 'codex');
  h.c.send('th-1', { text: 'go' }, 1);
  h.c.onCodexMessage(codex('turn/started', { threadId: 'th-1', turn: { id: 'T' } }));
  h.c.onCodexMessage(
    codex('turn/completed', { threadId: 'th-1', turn: { id: 'T', status: 'failed', error: { codexErrorInfo: 'usageLimitExceeded' } } }),
  );
  const r = await read();
  assert.deepEqual([r.limit.window, r.limit.resetsAt], [null, null]);
  // another failure is not a limit
  h.c.send('th-1', { text: 'again' }, 2);
  h.c.onCodexMessage(codex('turn/started', { threadId: 'th-1', turn: { id: 'U' } }));
  h.c.onCodexMessage(
    codex('turn/completed', { threadId: 'th-1', turn: { id: 'U', status: 'failed', error: { codexErrorInfo: 'other' } } }),
  );
  assert.equal((await read()).limit, undefined);
});

test('a basic (ACP) chat that ended on a rate-limit error reads the limit with no window; a refusal does not', async (t) => {
  const { h, read } = wired(t, 'acp:test');
  h.c.send('th-1', { text: 'go' }, 1);
  h.c.onAcpEvent({ key: KEY, kind: 'turnStart', turnId: 'at-1' });
  h.c.onAcpEvent({ key: KEY, kind: 'turnEnd', turnId: 'at-1', stopReason: 'error', error: 'Rate limit exceeded' });
  const r = await read();
  assert.deepEqual([r.limit.window, r.limit.resetsAt], [null, null]);
  h.c.send('th-1', { text: 'again' }, 2);
  h.c.onAcpEvent({ key: KEY, kind: 'turnStart', turnId: 'at-2' });
  h.c.onAcpEvent({ key: KEY, kind: 'turnEnd', turnId: 'at-2', stopReason: 'refusal' });
  assert.equal((await read()).limit, undefined);
});

test('after a restart a limit note that ends the chat says it stopped on a limit, keyed by the note', async (t) => {
  const note = { type: 'statusNote', id: 'limit-1', kind: 'limit', text: 'Claude AI usage limit reached' };
  const turns = [{ id: 'h-1', items: [{ type: 'userMessage', id: 'u', content: [{ type: 'text', text: 'go' }] }, note] }];
  const { read } = wired(t, 'claude', undefined, turns);
  const r = await read();
  assert.deepEqual([r.limit.window, r.limit.resetsAt], [null, null]);
  assert.ok(r.limit.key.includes('limit-1'));
  // a chat whose last row is not that note is not stopped
  const later = [...turns, { id: 'h-2', items: [{ type: 'agentMessage', id: 'a', text: 'back' }] }];
  assert.equal((await wired(t, 'claude', undefined, later).read()).limit, undefined);
});

test('signals: the first report of a limit is the episode, repeats keep its key, the next turn that ends clears it', () => {
  let now = 1000;
  const s = new ChatSignals({ now: () => now });
  assert.equal(s.limitOf('c', 'claude', undefined), null);
  s.limitHit('c');
  const key = s.limitOf('c', 'claude', undefined).key;
  now = 2000;
  s.limitHit('c');
  assert.equal(s.limitOf('c', 'claude', undefined).key, key, 'a repeated report keeps the episode');
  // the turn's own end keeps it; a later turn's end clears it
  s.turnEnded('c');
  assert.equal(s.limitOf('c', 'claude', undefined).key, key);
  s.turnEnded('c');
  assert.equal(s.limitOf('c', 'claude', undefined), null);
  s.turnEnded('c');
  // after the turn ended, a new report is a new episode
  s.limitHit('c');
  s.turnEnded('c');
  now = 3000;
  s.limitHit('c');
  assert.notEqual(s.limitOf('c', 'claude', undefined).key, key);
  s.limitCleared('c');
  assert.equal(s.limitOf('c', 'claude', undefined), null);
});

test('signals: a marked chat of an unknown harness or a basic one names no window; a limit note without an id still keys the episode', () => {
  const s = new ChatSignals();
  s.limitHit('c');
  for (const family of [null, undefined, 'acp'] as const)
    assert.deepEqual({ ...s.limitOf('c', family, undefined), key: '' }, { key: '', window: null, resetsAt: null });
  const quiet = new ChatSignals();
  assert.deepEqual(quiet.limitOf('c', 'claude', { limit: true }), { key: 'limit-note', window: null, resetsAt: null });
  assert.equal(quiet.limitOf('c', 'claude', { id: 'x' }), null);
});

test('signals: a rejected request is the window the limit names; a later allowed one, a past reset and a chat without one say none; the memory is bounded', () => {
  const chatOf = (key: string) => key;
  const s = new ChatSignals();
  const hear = (key: string, info: any) =>
    s.event('claude', { key, kind: 'message', msg: { type: 'rate_limit_event', rate_limit_info: info } }, chatOf);
  hear('c', { status: 'rejected', rateLimitType: 'five_hour', resetsAt: soon() });
  s.limitHit('c');
  assert.equal(s.limitOf('c', 'claude', undefined).window, '5h');
  // extra usage has no window words, and its reset is not named
  hear('c', { status: 'rejected', rateLimitType: 'overage', resetsAt: soon() });
  assert.deepEqual([s.limitOf('c', 'claude', undefined).window, s.limitOf('c', 'claude', undefined).resetsAt], [null, null]);
  // a window whose reset has passed is not named
  hear('c', { status: 'rejected', rateLimitType: 'five_hour', resetsAt: 1 });
  assert.equal(s.limitOf('c', 'claude', undefined).resetsAt, null);
  hear('c', { status: 'allowed', rateLimitType: 'five_hour' });
  assert.deepEqual([s.limitOf('c', 'claude', undefined).window, s.limitOf('c', 'claude', undefined).resetsAt], [null, null]);
  // the app held the reset until it passed
  let now = 0;
  const timed = new ChatSignals({ now: () => now });
  timed.event(
    'claude',
    {
      key: 'd',
      kind: 'message',
      msg: { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'seven_day', resetsAt: 100 } },
    },
    chatOf,
  );
  timed.limitHit('d');
  assert.equal(timed.limitOf('d', 'claude', undefined).resetsAt, 100_000);
  now = 200_000;
  assert.equal(timed.limitOf('d', 'claude', undefined).resetsAt, null);
  // bounded
  const many = new ChatSignals();
  for (let i = 0; i < 205; i++) {
    many.event(
      'claude',
      {
        key: `k${i}`,
        kind: 'message',
        msg: { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: soon() } },
      },
      chatOf,
    );
    many.limitHit(`k${i}`);
  }
  assert.equal(many.rejected.size, 200);
  assert.equal(many.limited.size, 200);
  assert.equal(many.limitOf('k0', 'claude', undefined), null);
});
