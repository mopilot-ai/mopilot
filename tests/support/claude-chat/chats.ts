// Claude renderer chat unit cases for chats.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { called, fx, claude, claudeThreadId, flush, log, rec, baseNative, userMsg, reply, result, UUID } from './fixture.ts';
import { selectionAttachment } from '../../../src/lib/annotations.ts';

export function registerChats() {
  test('a new chat starts fresh in its folder; a temporary one stays out of the sidebar', async () => {
    const id = claude.startClaudeThread({ cwd: '/repo/.claude/worktrees/wt-1/src', projectId: 'p' });
    assert.deepEqual(called('unhideFolder'), [['/repo']]);
    assert.equal(called('upsertThread')[0][0].projectId, 'p');
    assert.deepEqual(called('rememberChatProject')[0], [id, 'p', undefined]);
    assert.deepEqual(
      log.find((x) => x[0] === 'claudeNew'),
      ['claudeNew', id, { cwd: '/repo/.claude/worktrees/wt-1/src', ephemeral: false }],
    );
    assert.deepEqual(await claude.loadClaudeTurns(id, id, '/repo'), []);
    await claude.openClaudeThread(id);
    assert.equal(fx.state.runtime[id].loaded, true);
    const tmp = claude.startClaudeThread({ cwd: '/w', ephemeral: true });
    assert.equal(fx.state.threads[tmp].ephemeral, true);
    assert.equal(fx.state.threads[tmp].projectId, null);
    assert.equal(called('upsertThread').length, 1);
    assert.deepEqual(called('rememberChatProject')[1], [tmp, undefined, true]);
    // a fresh chat has no checkpoints to read; nor does a temporary one
    let reads = 0;
    baseNative({ checkpoints: async () => (reads++, {}) });
    await claude.refreshCheckpoints(id);
    fx.state.threads.x = { ephemeral: true };
    await claude.refreshCheckpoints('x');
    assert.equal(reads, 0);
    // a session written to disk: its transcript, under the chat that owns it
    baseNative({ messages: async () => [userMsg(UUID, 'hi', 60_000), reply('yo'), result()] });
    const turns = await claude.loadClaudeTurns(claudeThreadId('on-disk'), 'owner', '/w');
    assert.deepEqual(
      turns.map((t: any) => [t.id, t.status]),
      [[`h-${UUID}`, 'completed']],
    );
    // a session main made for a switched chat
    claude.markNewClaudeSession('claude:switched');
    assert.deepEqual(await claude.loadClaudeTurns('claude:switched', 'c', '/w'), []);
  });

  test('a side chat forks the session into the pane, with the selection as its draft', () => {
    fx.state.threads['claude:src'] = { cwd: '/w', projectId: 'p' };
    const id = claude.openClaudeSideChat('claude:src', 'claude:src', 'quoted');
    assert.deepEqual(log.find((x) => x[0] === 'claudeNew')[2], { cwd: '/w', ephemeral: true, forkFrom: 'src' });
    assert.deepEqual([fx.state.threads[id].ephemeral, fx.state.threads[id].projectId], [true, 'p']);
    // the real selection attachment (src/lib/annotations.ts), which the harness takes from its owner
    assert.deepEqual(called('setDraft'), [[id, { text: '', attachments: [selectionAttachment('quoted')] }]]);
    assert.deepEqual(called('openPaneTab'), [['chat', { threadId: id, sourceChatId: 'claude:src' }, undefined]]);
    const id2 = claude.openClaudeSideChat('claude:none', 'claude:none');
    assert.equal(fx.state.threads[id2].cwd, '');
    assert.equal(fx.state.threads[id2].projectId, null);
    assert.equal(called('setDraft').length, 1);
    // a parent without an account of its own leaves the side chat on the login in use
    assert.equal(fx.state.claudeChats[id2], undefined);
  });

  test("a side chat starts on the parent chat's account, pinned when the parent was (R-3)", () => {
    fx.state.threads['claude:pinned'] = { cwd: '/w' };
    fx.state.claudeChats = { 'claude:pinned': { id: 'work', pinned: true, serving: 'home' }, 'claude:auto': { id: 'home', pinned: false } };
    const pinned = claude.openClaudeSideChat('claude:pinned', 'claude:pinned');
    assert.deepEqual(fx.state.claudeChats[pinned], { id: 'work', pinned: true });
    const auto = claude.openClaudeSideChat('claude:auto', 'claude:auto');
    assert.deepEqual(fx.state.claudeChats[auto], { id: 'home', pinned: false });
  });

  test('opening a chat reads its transcript, its settings and checkpoints, and follows it', async () => {
    const id = claudeThreadId('open-1');
    fx.state.threads[id] = { id, cwd: '/w' };
    fx.state.claude.models = [{ id: 'opus', resolved: 'claude-opus-5-5' }];
    fx.state.runtime[id] = { turns: [], settings: null };
    baseNative({
      messages: async () => [userMsg(UUID, 'hello', 60_000), reply('hi'), result()],
      sessionSettings: async () => ({ model: 'claude-opus-5-5', effort: 'high' }),
      checkpoints: async () => ({ [UUID]: 'abc' }),
    });
    await claude.openClaudeThread(id);
    await flush();
    const rt = fx.state.runtime[id];
    assert.deepEqual([rt.loaded, rt.loading, rt.turns.length, rt.turns[0].status], [true, false, 1, 'completed']);
    assert.deepEqual(rt.settings, { model: 'opus', effort: 'high' });
    assert.deepEqual(rt.checkpoints, { [UUID]: 'abc' });
    assert.deepEqual(
      log.filter((x) => x[0] === 'watch'),
      [['watch', 'open-1']],
    );
    // already followed: not watched twice; an unknown thread isn't followed
    await claude.openClaudeThread(id);
    await claude.openClaudeThread(claudeThreadId('open-unknown'));
    await flush();
    assert.equal(log.filter((x) => x[0] === 'watch').length, 1);
    // a failed watch can be retried
    const id2 = claudeThreadId('open-2');
    fx.state.threads[id2] = { id: id2 };
    baseNative({ watch: rec('watch', async () => false) });
    await claude.openClaudeThread(id2);
    await flush();
    await claude.openClaudeThread(id2);
    await flush();
    assert.equal(log.filter((x) => x[0] === 'watch').length, 3);
    // a watch that failed is not in place either: it is asked again
    baseNative({
      watch: rec('watch', async () => {
        throw new Error('no watcher');
      }),
    });
    await claude.openClaudeThread(id2);
    await flush();
    await claude.openClaudeThread(id2);
    await flush();
    assert.equal(log.filter((x) => x[0] === 'watch').length, 5);
    // errors
    baseNative({
      messages: async () => {
        throw new Error('unreadable');
      },
    });
    await claude.openClaudeThread(id);
    assert.equal(fx.state.runtime[id].error, 'unreadable');
    baseNative({
      messages: async () => {
        throw 'raw';
      },
    });
    await claude.openClaudeThread(id);
    assert.equal(fx.state.runtime[id].error, 'raw');
    // a failed settings read leaves the settings alone
    baseNative({
      sessionSettings: async () => {
        throw new Error('x');
      },
      checkpoints: async () => {
        throw new Error('x');
      },
    });
    fx.state.runtime[id] = { ...fx.state.runtime[id], settings: { model: 'sonnet' } };
    await claude.openClaudeThread(id);
    await flush();
    assert.deepEqual(fx.state.runtime[id].settings, { model: 'sonnet' });
  });
}
