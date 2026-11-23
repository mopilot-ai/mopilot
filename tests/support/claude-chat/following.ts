// Claude renderer chat unit cases for following.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  called,
  fx,
  storeSet,
  intervals,
  claude,
  claudeThreadId,
  flush,
  log,
  onEvent,
  baseNative,
  userMsg,
  reply,
  result,
  UUID,
  evStarting,
} from './fixture.ts';

export function registerFollowing() {
  test('only local root conversation activity clears an external writer notice', () => {
    const chat = claudeThreadId('notice-owner');
    fx.state.threads[chat] = { id: chat };
    fx.state.elsewhere[chat] = { app: 'other', running: true, hard: false };
    for (const msg of [
      { type: 'rate_limit_event', rate_limit_info: {} },
      { type: 'system', subtype: 'status', status: null },
      { type: 'assistant', parent_tool_use_id: 'agent', message: { content: [{ type: 'text', text: 'background agent' }] } },
    ])
      onEvent({ kind: 'message', key: chat, msg });
    assert.equal(called('setElsewhere').length, 0, 'telemetry and subagents do not own the root transcript');
    onEvent({ kind: 'message', key: chat, msg: { type: 'assistant', message: { content: [{ type: 'text', text: 'local' }] } } });
    assert.deepEqual(called('setElsewhere'), [[chat, null]]);
    // A retired segment's messages cannot clear the current session's warning.
    fx.state.segments[chat] = [{ harness: 'claude', nativeId: claudeThreadId('replacement') }];
    onEvent({ kind: 'message', key: chat, msg: reply('old session') });
    assert.equal(called('setElsewhere').length, 1);
    onEvent(evStarting(chat, 'local-start', { key: claudeThreadId('replacement') }));
    assert.deepEqual(called('setElsewhere').at(-1), [chat, null]);
  });

  test('a result on a chat this window started on screen begins following its transcript', async () => {
    const chat = claudeThreadId('follow-res');
    fx.state.threads[chat] = { id: chat };
    fx.state.route = { name: 'thread', id: chat };
    onEvent({ kind: 'message', key: chat, chatId: chat, msg: result() });
    await flush();
    assert.deepEqual(
      log.filter((x) => x[0] === 'watch'),
      [['watch', 'follow-res']],
    );
    // a temporary chat on screen is not followed; nor is one off screen
    const tmp = claudeThreadId('follow-tmp');
    fx.state.threads[tmp] = { id: tmp, ephemeral: true };
    fx.state.paneTabs = [{ threadId: tmp }, { kind: 'terminal' }];
    onEvent({ kind: 'message', key: tmp, chatId: tmp, msg: result() });
    const off = claudeThreadId('follow-off');
    fx.state.threads[off] = { id: off };
    onEvent({ kind: 'message', key: off, chatId: off, msg: result() });
    // a later segment's result doesn't follow the chat
    const seg = claudeThreadId('follow-seg');
    fx.state.segments[chat] = [
      { harness: 'claude', nativeId: chat },
      { harness: 'claude', nativeId: seg },
    ];
    onEvent({ kind: 'message', key: seg, chatId: chat, msg: result() });
    await flush();
    assert.equal(log.filter((x) => x[0] === 'watch').length, 1);
  });

  test("following another app's session: re-read on its writes, shown as running, closed when quiet", async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const chat = claudeThreadId('other-app');
    fx.state.threads[chat] = { id: chat, cwd: '/w', updatedAt: 0 };
    // follow it by opening it
    baseNative({ messages: async () => [userMsg(UUID, 'working…')] });
    await claude.openClaudeThread(chat);
    await flush();
    assert.equal(fx.state.runtime[chat].turns[0].status, 'inProgress');
    // re-reading an unchanged transcript is not activity: the sidebar order stays put
    onEvent({ kind: 'transcript', key: chat });
    await flush();
    assert.deepEqual(called('setElsewhere').at(-1), [chat, { app: 'other', running: true, hard: false }]);
    assert.equal(fx.state.threads[chat].updatedAt, 0);
    assert.equal(fx.state.threads[chat].recencyAt, undefined);
    // its transcript changed (another item): activity, so the chat moves up
    baseNative({ messages: async () => [userMsg(UUID, 'working…'), userMsg('22345678-1234-1234-1234-123456789abc', 'more')] });
    onEvent({ kind: 'transcript', key: chat });
    await flush();
    assert.ok(fx.state.threads[chat].updatedAt > 0);
    assert.equal(fx.state.threads[chat].recencyAt, fx.state.threads[chat].updatedAt);
    fx.state.elsewhere[chat] = { app: 'terminal', running: true };
    onEvent({ kind: 'transcript', key: chat });
    await flush();
    assert.deepEqual(called('setElsewhere').at(-1), [chat, { app: 'terminal', running: true, hard: false }]);
    // it finished: the next read closes the turn and frees the chat
    baseNative({ messages: async () => [userMsg(UUID, 'done?', 60_000), reply('done'), result()] });
    t.mock.timers.tick(31_000);
    await flush();
    assert.equal(fx.state.runtime[chat].turns[0].status, 'completed');
    assert.deepEqual(called('otherAppDone'), [[chat]]);
    // not running and nothing elsewhere: no change
    fx.state.elsewhere[chat] = { app: 'terminal', running: false };
    onEvent({ kind: 'transcript', key: chat });
    await flush();
    assert.equal(called('otherAppDone').length, 1);
    // a transcript that can't be read is skipped
    baseNative({
      messages: async () => {
        throw new Error('locked');
      },
    });
    onEvent({ kind: 'transcript', key: chat });
    await flush();
    // an unfollowed chat's transcript event is ignored
    onEvent({ kind: 'transcript', key: claudeThreadId('never-followed') });
    // the chat gone from the thread list: no timestamp to touch
    baseNative({ messages: async () => [userMsg(UUID, 'x', 60_000), reply('y'), result()] });
    delete fx.state.threads[chat];
    delete fx.state.runtime[chat];
    onEvent({ kind: 'transcript', key: chat });
    await flush();
    assert.equal(fx.state.threads[chat], undefined);
    t.mock.timers.reset();
  });

  test("re-showing a chat after its own turn is not activity; another app's turn and a running turn's output are", async () => {
    const chat = claudeThreadId('reshow');
    const NEXT = '22345678-1234-1234-1234-123456789abc';
    fx.state.threads[chat] = { id: chat, updatedAt: 0 };
    // the turn ran here: its live id, and a note only the live copy shows
    const items = [
      { type: 'statusNote', id: 'n' },
      { type: 'userMessage', id: 'u' },
      { type: 'agentMessage', id: 'a' },
    ];
    fx.state.runtime[chat] = { loaded: true, turns: [{ id: `ct-${UUID}`, status: 'completed', items }] };
    baseNative({ messages: async () => [userMsg(UUID, 'hi', 60_000), reply('done'), result()] });
    storeSet({ route: { name: 'thread', id: chat } });
    await flush();
    assert.equal(fx.state.runtime[chat].turns[0].id, `h-${UUID}`, 're-read on coming back');
    assert.equal(fx.state.threads[chat].recencyAt, undefined, 'the sidebar order stays put');
    // another app started a turn in it: activity
    baseNative({ messages: async () => [userMsg(UUID, 'hi', 60_000), reply('done'), result(), userMsg(NEXT, 'more')] });
    onEvent({ kind: 'transcript', key: chat });
    await flush();
    const started = fx.state.threads[chat].recencyAt;
    assert.ok(started > 0);
    // that turn's output while it runs: activity too
    fx.state.threads[chat] = { ...fx.state.threads[chat], updatedAt: 0, recencyAt: 0 };
    baseNative({ messages: async () => [userMsg(UUID, 'hi', 60_000), reply('done'), result(), userMsg(NEXT, 'more'), reply('working')] });
    onEvent({ kind: 'transcript', key: chat });
    await flush();
    assert.ok(fx.state.threads[chat].recencyAt > 0);
    // the other app rewound the chat: a written turn is gone, which is activity as well
    fx.state.threads[chat] = { ...fx.state.threads[chat], updatedAt: 0, recencyAt: 0 };
    baseNative({ messages: async () => [userMsg(UUID, 'hi', 60_000), reply('done'), result()] });
    onEvent({ kind: 'transcript', key: chat });
    await flush();
    assert.ok(fx.state.threads[chat].recencyAt > 0);
    // a message that never reached the transcript (its send failed) is not a rewound turn
    fx.state.threads[chat] = { ...fx.state.threads[chat], updatedAt: 0, recencyAt: 0 };
    const shown = fx.state.runtime[chat].turns;
    fx.state.runtime[chat] = { ...fx.state.runtime[chat], turns: [...shown, { id: 'pending-gone', status: 'failed', items: [] }] };
    onEvent({ kind: 'transcript', key: chat });
    await flush();
    assert.equal(fx.state.threads[chat].recencyAt, 0);
  });

  test('while this window runs a turn its stream wins over the transcript', async () => {
    const chat = claudeThreadId('own-turn');
    fx.state.threads[chat] = { id: chat };
    await claude.openClaudeThread(chat);
    await flush();
    fx.sessions[chat] = { turn: 'running' };
    let reads = 0;
    baseNative({ messages: async () => (reads++, []) });
    onEvent({ kind: 'transcript', key: chat });
    await flush();
    assert.equal(reads, 0);
    delete fx.sessions[chat];
    // a turn that starts while the transcript is read wins
    baseNative({ messages: async () => (reads++, (fx.sessions[chat] = { turn: 'running' }), onEvent(evStarting(chat, 'o2')), []) });
    const before = fx.state.runtime[chat].turns.length;
    onEvent({ kind: 'transcript', key: chat });
    await flush();
    assert.equal(reads, 1);
    assert.equal(fx.state.runtime[chat].turns.length, before + 1, 'the transcript did not replace the live turns');
    delete fx.sessions[chat];
    // a chat that switched segments isn't re-read under its old id
    fx.state.segments[chat] = [
      { harness: 'claude', nativeId: chat },
      { harness: 'codex', nativeId: 'cx-seg' },
    ];
    onEvent({ kind: 'transcript', key: chat });
    await flush();
    assert.equal(reads, 1);
  });

  test('what is on screen decides what is followed', async () => {
    const a = claudeThreadId('screen-a');
    const b = claudeThreadId('screen-b');
    fx.state.threads[a] = { id: a };
    fx.state.threads[b] = { id: b };
    await claude.openClaudeThread(a);
    await flush();
    fx.state.runtime[b] = { loaded: true, turns: [] };
    // b comes on screen; a goes away
    storeSet({ route: { name: 'thread', id: b } });
    await flush();
    assert.ok(log.some((x) => x[0] === 'unwatch' && x[1] === 'screen-a'));
    assert.ok(log.some((x) => x[0] === 'watch' && x[1] === 'screen-b'));
    // not loaded, a fresh chat, a temporary chat or a Codex chat on screen: not followed
    const c = claudeThreadId('screen-c');
    const tmp = claudeThreadId('screen-tmp');
    fx.state.threads[tmp] = { ephemeral: true };
    fx.state.runtime[tmp] = { loaded: true };
    const fresh = claude.startClaudeThread({ cwd: '/w' });
    log.length = 0;
    storeSet({ paneTabs: [{ threadId: c }, { threadId: tmp }, { threadId: fresh }, { threadId: 'codex-x' }, {}] });
    storeSet({ route: { name: 'home' } });
    await flush();
    assert.deepEqual(
      log.filter((x) => x[0] === 'watch'),
      [],
    );
  });

  test('a chat with a message held for another app stays followed off screen, so that app finishing sends it', async () => {
    const h = claudeThreadId('held-off');
    const other = claudeThreadId('held-other');
    fx.state.threads[h] = { id: h };
    fx.state.threads[other] = { id: other };
    storeSet({ route: { name: 'thread', id: h } });
    await claude.openClaudeThread(h);
    await flush();
    fx.state.runtime[h] = { ...fx.state.runtime[h], held: { text: 'later', attachments: [], opts: {} } };
    fx.state.runtime[other] = { loaded: true, turns: [] };
    log.length = 0;
    storeSet({ route: { name: 'thread', id: other } });
    await flush();
    assert.ok(!log.some((x) => x[0] === 'unwatch' && x[1] === 'held-off'), 'still followed');
    // sent: the next change of screen lets it go
    fx.state.runtime[h] = { ...fx.state.runtime[h], held: null };
    storeSet({ route: { name: 'home' } });
    await flush();
    assert.ok(log.some((x) => x[0] === 'unwatch' && x[1] === 'held-off'));
  });

  test('presence: chats other apps have open, polled while in front or every 20 s behind', async () => {
    const chat = claudeThreadId('pres-1');
    const gone = claudeThreadId('pres-gone');
    fx.state.threads[chat] = { id: chat };
    fx.state.elsewhere = {
      [gone]: { app: 'terminal', running: false },
      codexChat: { app: 'codex', running: false },
      [claudeThreadId('pres-busy')]: { app: 'terminal', running: true },
    };
    baseNative({ presence: async () => ({ 'pres-1': ['vscode'], 'pres-unknown': ['terminal'] }) });
    const poll = intervals.at(-1)!;
    poll();
    await flush();
    assert.deepEqual(called('setElsewhere'), [
      [chat, { app: 'vscode', running: false, hard: false }],
      [gone, null],
    ]);
    assert.deepEqual(called('sendHeld'), [[gone]]);
    // behind, within 20 s: no poll; a runtime-only chat counts
    fx.state.focused = false;
    let polled = 0;
    baseNative({ presence: async () => (polled++, {}) });
    poll();
    assert.equal(polled, 0);
    fx.state.focused = true;
    fx.state.runtime[claudeThreadId('pres-rt')] = { turns: [] };
    fx.state.elsewhere = { [chat]: { app: 'vscode', running: true } };
    baseNative({ presence: async () => ({ 'pres-rt': ['terminal'], 'pres-1': ['vscode'] }) });
    poll();
    await flush();
    assert.deepEqual(called('setElsewhere').slice(2), [
      [claudeThreadId('pres-rt'), { app: 'terminal', running: false, hard: false }],
      [chat, { app: 'vscode', running: true, hard: false }],
    ]);
    baseNative({
      presence: async () => {
        throw new Error('ps failed');
      },
    });
    poll();
    await flush();
    assert.equal(called('setElsewhere').length, 4);
  });
}
