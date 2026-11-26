// Claude renderer chat unit cases for events.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  called,
  fx,
  claude,
  claudeThreadId,
  flush,
  onEvent,
  onItems,
  baseNative,
  userMsg,
  reply,
  result,
  evStarted,
  UUID,
} from './fixture.ts';

export function registerEvents() {
  test('Claude activity from main uses the native session even when the local turn has a different automatic id', () => {
    const id = claudeThreadId('automatic');
    fx.state.threads[id] = { id, updatedAt: 1, preview: '' };
    fx.state.runtime[id] = { turns: [], activeTurnId: 'auto-local' };
    onEvent({ kind: 'message', key: id, msg: reply('background result'), activityAt: 2 });
    assert.deepEqual(called('touchChat'), [[id, undefined, 2]]);
    assert.equal(fx.state.threads[id].recencyAt, 2);
    fx.state.segments[id] = [
      { harness: 'claude', nativeId: id },
      { harness: 'codex', nativeId: 'replacement' },
    ];
    onEvent({ kind: 'message', key: id, msg: reply('retired result'), activityAt: 3 });
    assert.equal(fx.state.threads[id].recencyAt, 2);
  });

  test('events about logins, limits, goals, approvals and toasts', () => {
    const chat = claudeThreadId('ev-1');
    onEvent({ kind: 'toast', text: 'hello', level: 'info' });
    assert.deepEqual(called('toast').at(-1), ['hello', 'info']);
    onEvent({ kind: 'accountSwitched', key: chat, to: 'work', note: { text: 'Moved to work', id: 'n1' } });
    // the login comes with main's chats:changed broadcast, never as this window's own change (#2538)
    assert.equal(fx.state.claudeChats[chat], undefined);
    assert.deepEqual(called('accountNote'), [[chat, 'Moved to work', 'n1']]);
    onEvent({ kind: 'limitUnresolved', key: chat, reason: 'limit' });
    onEvent({ kind: 'limitUnresolved', key: chat, reason: 'expired' });
    assert.deepEqual(called('suggestOtherHarness'), [[chat, 'claude', false]]);
    fx.state.threads[chat] = { name: 'Goal chat' };
    onEvent({ kind: 'goalNotice', chatId: chat, body: 'Done', status: 'complete' });
    assert.deepEqual(called('notify'), [['goal', chat, { title: 'Goal chat', body: 'Done', status: 'complete' }]]);
    for (const kind of ['elicitation', 'permission', 'permissionCancelled', 'mystery']) onEvent({ kind, key: chat });
    onEvent({ kind: 'chatStarted', chatId: claudeThreadId('sched-1'), key: claudeThreadId('sched-1'), cwd: '/repo/.claude/worktrees/x' });
    onEvent({ kind: 'chatStarted', chatId: claudeThreadId('sched-2'), key: claudeThreadId('sched-2'), cwd: '/w', worktreeOf: '/main' });
    assert.deepEqual(called('unhideFolder'), [['/repo'], ['/w']]);
    assert.deepEqual(fx.state.worktreeOf, { [claudeThreadId('sched-2')]: '/main' });
    assert.equal(fx.state.runtime[claudeThreadId('sched-1')].loaded, true);
  });

  test('a durable fork main made opens with the conversation copied to disk, not as an empty new chat', async () => {
    const fork = claudeThreadId(UUID);
    onEvent({ kind: 'chatStarted', chatId: fork, key: fork, cwd: '/repo/.claude/worktrees/f', worktreeOf: '/repo', history: true });
    assert.equal(called('upsertThread').at(-1)?.[0].cwd, '/repo/.claude/worktrees/f');
    assert.deepEqual(fx.state.worktreeOf, { [fork]: '/repo' });
    assert.notEqual(fx.state.runtime[fork]?.loaded, true, 'its history is still to be read');
    baseNative({ messages: async () => [userMsg(UUID, 'inherited', 60_000), reply('kept'), result()] });
    assert.equal((await claude.loadClaudeTurns(fork, fork, '/repo/.claude/worktrees/f')).length, 1, 'not fresh: the copy is read');
    await claude.openClaudeThread(fork);
    assert.equal(fx.state.runtime[fork].loaded, true);
    assert.deepEqual(
      fx.state.runtime[fork].turns.map((t: any) => t.id),
      [`h-${UUID}`],
    );
  });

  test('messages: plan usage readings, the fast-mode state, results and a stale login', async (t) => {
    const chat = claudeThreadId('msg-1');
    fx.state.claudeAccounts = {
      active: 'default',
      accounts: [
        { id: 'default', loggedIn: true },
        { id: 'work', loggedIn: true },
      ],
    };
    fx.state.threads[chat] = { id: chat, status: { type: 'idle' } };
    const msg = (m: any, key = chat) => onEvent({ kind: 'message', key, chatId: chat, msg: m });
    msg({
      type: 'rate_limit_event',
      rate_limit_info: {
        status: 'allowed',
        unifiedWindows: {
          five_hour: { utilization: 0.25, resetsAt: 9 },
          seven_day_opus: { utilization: 0.5 },
          other_window: { utilization: 0.1 },
          bad: { utilization: 'x' },
          none: null,
        },
      },
    });
    assert.deepEqual(
      fx.state.claudeUsage.default.windows.map((w: any) => [w.label, w.usedPercent, w.resetsAt]),
      [
        ['5h', 25, 9],
        ['Weekly Opus', 50, null],
        ['other_window', 10, null],
      ],
    );
    msg({ type: 'rate_limit_event', rate_limit_info: { utilization: 0.9, rateLimitType: 'seven_day', resetsAt: 7 } });
    assert.deepEqual(fx.state.claudeUsage.default.windows.find((w: any) => w.label === 'Weekly').usedPercent, 90);
    msg({ type: 'rate_limit_event', rate_limit_info: { utilization: 0.3, rateLimitType: 'custom' } });
    msg({ type: 'rate_limit_event', rate_limit_info: { utilization: 0.3 } });
    assert.ok(fx.state.claudeUsage.default.windows.some((w: any) => w.label === 'custom'));
    assert.ok(fx.state.claudeUsage.default.windows.some((w: any) => w.label === 'Limit'));
    msg({ type: 'rate_limit_event' });
    // a session that didn't ask for fast mode reports nothing about it
    msg({ type: 'system', subtype: 'init', fast_mode_disabled_reason: 'free' });
    assert.equal(fx.state.claude.status.fastBlocked, undefined);
    assert.deepEqual(fx.state.threads[chat].status, { type: 'active', activeFlags: [] });
    // one that did: the reason, or on, or nothing new
    onEvent(evStarted(chat, { want: { model: 'opus', effort: null, permission: 'default', fast: true, account: 'work' } }));
    msg({ type: 'system', subtype: 'init', fast_mode_disabled_reason: 'extra_usage_disabled' });
    assert.equal(fx.state.claude.status.fastBlocked, 'extra_usage_disabled');
    msg({ type: 'system', subtype: 'init', fast_mode_disabled_reason: 'not-a-known-reason' });
    assert.equal(fx.state.claude.status.fastBlocked, 'extra_usage_disabled');
    msg({ type: 'system', subtype: 'init', fast_mode_state: 'on' });
    assert.equal(fx.state.claude.status.fastBlocked, null);
    msg({ type: 'system', subtype: 'init' });
    assert.equal(fx.state.claude.status.fastBlocked, null);
    // a reading from a live session goes to the login it runs on
    msg({ type: 'rate_limit_event', rate_limit_info: { utilization: 0.4 } });
    assert.equal(fx.state.claudeUsage.work.windows[0].usedPercent, 40);
    // a login folded into another of the same server account (#1312): the reading is that account's
    fx.state.claudeAccounts = { ...fx.state.claudeAccounts, same: { folded: 'work' } };
    onEvent({ kind: 'message', key: chat, account: 'folded', msg: { type: 'rate_limit_event', rate_limit_info: { utilization: 0.45 } } });
    assert.equal(fx.state.claudeUsage.work.windows[0].usedPercent, 45);
    assert.equal(fx.state.claudeUsage.folded, undefined);
    // a process on a key or MoPilot credits: its reading is not the login's
    onEvent({
      kind: 'message',
      key: chat,
      login: false,
      account: 'work',
      msg: { type: 'rate_limit_event', rate_limit_info: { utilization: 0.9 } },
    });
    assert.equal(fx.state.claudeUsage.work.windows[0].usedPercent, 45);
    // a chat not in the list
    msg({ type: 'system', subtype: 'init' }, claudeThreadId('msg-unknown'));
    // the result: idle, checkpoints read shortly after
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let reads = 0;
    baseNative({ checkpoints: async () => (reads++, { a: 'b' }) });
    msg(result());
    assert.deepEqual(fx.state.threads[chat].status, { type: 'idle' });
    t.mock.timers.tick(300);
    await flush();
    assert.equal(reads, 1);
    msg(result(), claudeThreadId('msg-unknown'));
    // a stale login: the active one shows signed out; any login is marked out
    // an invalid key is the key's failure: the login stays signed in
    onEvent({
      kind: 'message',
      key: claudeThreadId('msg-2'),
      login: false,
      msg: { type: 'assistant', error: 'authentication_failed', message: { content: [] } },
    } as any);
    assert.notEqual(fx.state.claude.status.state, 'signin');
    msg({ type: 'assistant', error: 'authentication_failed', message: { content: [] } }, claudeThreadId('msg-2'));
    assert.equal(fx.state.claude.status.state, 'signin');
    fx.state.claude.status.state = 'ready';
    msg({ type: 'assistant', error: 'other', message: { content: [{ type: 'text', text: 'Invalid API key' }] } });
    assert.equal(fx.state.claude.status.state, 'ready', 'a chat on another login leaves the status alone');
    assert.equal(fx.state.claudeAccounts.accounts.find((a: any) => a.id === 'work').loggedIn, false);
    msg({ type: 'assistant', error: 'rate_limit', message: { content: [{ type: 'text', text: 'slow down' }] } });
    msg({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } });
    t.mock.timers.reset();
  });
  test('a late result keeps its native Claude source after canonical-chat mapping', () => {
    const old = claudeThreadId('old-usage-source');
    fx.state.segments['canonical-usage'] = [
      { harness: 'claude', nativeId: old },
      { harness: 'codex', nativeId: 'new-code' },
    ];
    onItems({
      chatId: 'canonical-usage',
      key: old,
      method: 'thread/tokenUsage/updated',
      params: { threadId: 'canonical-usage', tokenUsage: {} },
    });
    const report = called('applyNotification')
      .filter(([method]) => method === 'thread/tokenUsage/updated')
      .at(-1)![1];
    assert.equal(report.threadId, 'canonical-usage');
    assert.deepEqual(report.tokenUsageSource, { harness: 'claude', nativeId: old });
  });
}
