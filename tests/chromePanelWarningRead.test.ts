// A usage warning a harness gave reaches the side panel's read of the chat (electron/app/chromePanel.cjs read -> limitWarning), heard from the controller's live events whether or not a panel watched the chat, for the harness the chat runs on now (#3046, B9).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { setup } from './support/controller/fixture.ts';

const require = createRequire(import.meta.url);
const { createChromePanel, projectsFileOf } = require('../electron/app/chromePanel.cjs');

const soon = () => Math.floor(Date.now() / 1000) + 3600;
const claudeWarning = (type = 'five_hour') => ({
  key: 'th-1',
  kind: 'message',
  msg: {
    type: 'rate_limit_event',
    rate_limit_info: { status: 'allowed_warning', rateLimitType: type, utilization: 0.9, resetsAt: soon() },
  },
});

/** A panel over a chat on `kind` whose history is empty; `kind` can change under it (a chat that switched harness). */
function wired(t: any, kind: string, identity?: any) {
  const h = setup();
  t.after(() => fs.rmSync(h.chats.dir, { recursive: true, force: true }));
  const record: any = { id: 'th-1', segments: [{ kind, nativeId: 'th-1' }], meta: {} };
  h.chats.records.set('th-1', record);
  const live: any = { chats: h.chats, controller: h.c, identity, peerRuntime: { readHistory: async () => ({ turns: [] }) } };
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
  const switchTo = (next: string) => record.segments.push({ kind: next, nativeId: 'th-2' });
  return { h, read, switchTo };
}

test('a Claude Code chat reads the warning its session heard before any panel read it; a quiet chat reads none', async (t) => {
  const { h, read } = wired(t, 'claude');
  assert.equal((await read()).limitWarning, undefined);
  h.c.onClaudeEvent(claudeWarning('seven_day'));
  const r = await read();
  assert.deepEqual([r.limitWarning.kind, r.limitWarning.window, r.limitWarning.utilization], ['approaching', '7d', 0.9]);
  assert.ok(r.limitWarning.resetsAt > Date.now());
  const allowed = (rateLimitType: string) =>
    h.c.onClaudeEvent({
      key: 'th-1',
      kind: 'message',
      msg: { type: 'rate_limit_event', rate_limit_info: { status: 'allowed', rateLimitType } },
    });
  // the five-hour window is fine again: the standing weekly warning stays
  allowed('five_hour');
  assert.equal((await read()).limitWarning.window, '7d');
  // the weekly window is: it goes
  allowed('seven_day');
  assert.equal((await read()).limitWarning, undefined);
});

/** The pool's side of a Codex chat's read: the windows of the login serving the thread, by the thread's native key. */
const pool = (byThread: Record<string, any>, seen: string[] = []) => ({
  driver: (harness: string) => (harness === 'codex' ? { chatLimits: (key: string) => (seen.push(key), byThread[key] ?? null) } : null),
});
const window = (usedPercent: number) => ({ usedPercent, windowDurationMins: 300, resetsAt: soon() });

test('a Codex chat reads the windows of the login that serves it; a Claude warning is not its own, and a basic harness chat has none', async (t) => {
  const seen: string[] = [];
  const { h, read, switchTo } = wired(t, 'codex', pool({ 'th-1': { primary: window(90) } }, seen));
  h.c.onClaudeEvent(claudeWarning());
  const r = await read();
  assert.equal(r.limitWarning.window, '5h');
  assert.deepEqual(seen, ['th-1'], 'asked for the chat’s own thread');
  // the chat moves to Claude Code: its session's warning (heard above) shows instead of Codex's
  switchTo('claude');
  assert.equal((await read()).limitWarning.window, '5h', 'now the Claude warning');
  // then to a basic harness, which has no such signal
  switchTo('acp:test');
  assert.equal((await read()).limitWarning, undefined);
});

test('a Codex chat whose login the pool cannot tell, or whose pool is not there, reads no warning rather than a wrong one', async (t) => {
  const { read } = wired(t, 'codex', pool({ other: { primary: window(90) } }));
  assert.equal((await read()).limitWarning, undefined);
  // no identity service at all, or a driver with no reader
  assert.equal((await wired(t, 'codex').read()).limitWarning, undefined);
  assert.equal((await wired(t, 'codex', { driver: () => ({}) }).read()).limitWarning, undefined);
});

test('a failure asking the pool is noted and the chat reads no warning', async (t) => {
  const throwing = {
    driver: () => ({
      chatLimits: () => {
        throw new Error('pool gone');
      },
    }),
  };
  const { read } = wired(t, 'codex', throwing);
  assert.equal((await read()).limitWarning, undefined);
});

test('a failure reading an event for the warnings never reaches the controller, and the next event is heard', async (t) => {
  const { h, read } = wired(t, 'claude');
  const chatOf = h.c.chatOf;
  h.c.chatOf = () => {
    throw new Error('no such session');
  };
  assert.doesNotThrow(() => h.c.onLiveEvent('claude', claudeWarning()));
  h.c.chatOf = chatOf;
  h.c.onClaudeEvent(claudeWarning());
  assert.equal((await read()).limitWarning.window, '5h');
});
