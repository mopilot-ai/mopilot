// Claude renderer chat unit cases for turns.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { called, fx, claudeThreadId, log, onEvent, evStarting, evStarted } from './fixture.ts';

export function registerTurns() {
  test('a turn: the message shows at once, under the login it started on, then moves the chat up and names it', async () => {
    const chat = claudeThreadId('turn-1');
    fx.state.threads[chat] = { id: chat, cwd: '/w', name: null, preview: '', recencyAt: 1 };
    fx.state.threadOrder = ['x', chat];
    fx.state.claude.models = [{ id: 'opus', label: 'Opus' }];
    fx.store.modelChangeNote = () => ({ kind: 'model', text: 'Now on Opus' });
    onEvent(evStarting(chat, 'c1'));
    const rt = fx.state.runtime[chat];
    assert.equal(rt.activeTurnId, 'pending-c1');
    assert.deepEqual(
      rt.turns[0].items.map((i: any) => i.type),
      ['statusNote', 'userMessage'],
    );
    // main keeps the login a turn started on (adapterSettings served): the window writes none it would echo back (#2538)
    assert.equal(fx.state.claudeChats[chat], undefined);
    // a note from main wins; the model change note is asked for the model that ran (its window is the store's to know); no note leaves only the message
    fx.store.modelChangeNote = (...a: any[]) => (log.push(['note', ...a]), null);
    onEvent(evStarting(chat, 'c2', { opts: { note: { kind: 'x', text: 'from main' } }, account: 'work' }));
    assert.equal(fx.state.runtime[chat].turns[1].items[0].text, 'from main');
    assert.equal(fx.state.claudeChats[chat], undefined);
    onEvent(evStarting(chat, 'c3', { model: 'opus[1m]', account: 'work' }));
    onEvent(evStarting(chat, 'c4', { model: null, account: 'work' }));
    assert.deepEqual(
      log.filter((x) => x[0] === 'note').map((x) => [x[2], x[3], x[4]]),
      [
        ['opus[1m]', 'opus[1m]', undefined],
        [null, '', undefined],
      ],
    );
    assert.equal(fx.state.runtime[chat].turns[3].items.length, 1);
    // a pinned chat's record is the user's: a turn that ran elsewhere leaves it as it is here, main notes where it ran
    fx.state.claudeChats[chat] = { id: 'work', pinned: true };
    const before = fx.state.claudeChats;
    onEvent(evStarting(chat, 'c5', { account: 'home' }));
    assert.equal(fx.state.claudeChats, before);
    onEvent(evStarted(chat));
    assert.deepEqual(fx.state.threadOrder, [chat, 'x']);
    assert.ok(fx.state.threads[chat].recencyAt > 1);
    assert.equal(fx.state.threads[chat].recencyAt, fx.state.threads[chat].updatedAt);
    assert.equal(fx.state.threads[chat].preview, 'go on then');
    assert.equal(fx.state.threads[chat].name, 'go on then');
    // a named chat keeps its name and preview
    onEvent(evStarted(chat, { text: 'later' }));
    assert.equal(fx.state.threads[chat].preview, 'go on then');
  });

  test('Codex → Claude: the message shown before the switch settled is the turn Claude starts', () => {
    const chat = claudeThreadId('switch-early');
    fx.state.threads[chat] = { id: chat, cwd: '/w', name: null, preview: '', recencyAt: 1 };
    fx.store.modelChangeNote = () => null;
    const early = { id: 'pending-req-1', status: 'inProgress', items: [{ type: 'userMessage', id: 'local-req-1', clientId: 'req-1' }] };
    const earlier = { id: 'done', status: 'completed', items: [] };
    fx.state.runtime[chat] = { turns: [earlier, early], activeTurnId: 'pending-req-1' };
    onEvent(evStarting(chat, 'c9', { itemId: 'req-1', text: 'go' }));
    const rt = fx.state.runtime[chat];
    assert.deepEqual(
      rt.turns.map((t: any) => t.id),
      ['done', 'pending-c9'],
    );
    assert.equal(rt.turns[1].items.filter((i: any) => i.type === 'userMessage').length, 1);
    assert.equal(rt.activeTurnId, 'pending-c9');
  });

  test('turnStarted: side chats stay out of the sidebar; another app holding the chat is said once', () => {
    const side = claudeThreadId('side-1');
    fx.state.threads[side] = { id: side, ephemeral: true, name: null };
    fx.state.threadOrder = ['x'];
    onEvent(evStarted(side));
    assert.deepEqual(fx.state.threadOrder, ['x']);
    assert.equal(fx.state.threads[side].name, null);
    // a chat this window doesn't know: moved up, nothing to name
    const unknown = claudeThreadId('unknown-1');
    onEvent(evStarted(unknown));
    assert.equal(fx.state.threads[unknown], undefined);
    assert.equal(fx.state.threadOrder[0], unknown);
    // a later segment of a switched chat is not named after its message
    const chat = claudeThreadId('seg-chat');
    fx.state.threads[chat] = { id: chat, name: null, preview: '' };
    onEvent(evStarted(chat, { key: claudeThreadId('seg-native') }));
    assert.equal(fx.state.threads[chat].name, null);
    // elsewhere
    onEvent(evStarted(chat, { elsewhere: ['terminal'] }));
    assert.deepEqual(called('setElsewhere').at(-1), [chat, { app: 'terminal', running: false, hard: false }]);
    assert.equal(fx.state.runtime[chat].continueHere, true);
    assert.equal(called('toast').length, 0, 'idle presence does not display a recurring notification');
    fx.state.elsewhere[chat] = { app: 'terminal' };
    onEvent(evStarted(chat, { elsewhere: ['terminal'] }));
    assert.equal(called('setElsewhere').length, 1);
  });

  test('renaming from main, and a CLI that quit or failed', () => {
    const chat = claudeThreadId('steer-1');
    fx.state.threads[chat] = { id: chat, name: 'go', status: { type: 'active' } };
    // threadName replaces the provisional title only
    onEvent({ kind: 'threadName', chatId: chat, name: 'Real title', provisional: 'go' });
    assert.equal(fx.state.threads[chat].name, 'Real title');
    onEvent({ kind: 'threadName', chatId: chat, name: 'Other', provisional: 'go' });
    assert.equal(fx.state.threads[chat].name, 'Real title');
    fx.state.threads[chat].name = null;
    onEvent({ kind: 'threadName', chatId: chat, name: 'Named', provisional: 'x' });
    assert.equal(fx.state.threads[chat].name, 'Named');
    onEvent({ kind: 'threadName', chatId: 'claude:nope', name: 'x' });
    // a CLI that quit: the chat goes idle; main ends its turn and owns approval cleanup
    fx.state.pending = [
      { threadId: chat, id: 'cperm-1' },
      { threadId: chat, id: 'other' },
      { threadId: 'x', id: 'cperm-2' },
    ];
    onEvent({ kind: 'closed', key: chat });
    assert.equal(fx.state.pending.length, 3);
    assert.deepEqual(fx.state.threads[chat].status, { type: 'idle' });
    // an error is toasted
    onEvent({ kind: 'error', key: chat, error: 'spawn failed\ndetails' });
    assert.deepEqual(called('toast').at(-1), ['Claude Code: Spawn failed.', 'error']);
    // nothing running, unknown chat
    onEvent({ kind: 'error', key: 'claude:ghost', error: 'x' });
    assert.equal(fx.state.threads['claude:ghost'], undefined);
  });

  test('a steer that never reached Claude leaves the turns shown here', () => {
    const chat = claudeThreadId('steer-failed');
    fx.state.threads[chat] = { id: chat, name: 'go', status: { type: 'active' } };
    fx.state.runtime[chat] = {
      turns: [
        {
          id: 'ct-s1',
          items: [
            { type: 'userMessage', id: 'u' },
            { type: 'userMessage', id: 'k2' },
          ],
        },
        { id: 'ct-k3', items: [{ type: 'userMessage', id: 'k3' }] },
        { id: 'other', items: [{ type: 'agentMessage', id: 'a' }] },
      ],
    };
    const other = fx.state.runtime[chat].turns[2];
    onEvent({ kind: 'steerFailed', key: chat, chatId: chat, clientId: 'k2' });
    assert.deepEqual(
      fx.state.runtime[chat].turns.map((t: any) => [t.id, t.items.map((i: any) => i.id)]),
      [
        ['ct-s1', ['u']],
        ['ct-k3', ['k3']],
        ['other', ['a']],
      ],
    );
    assert.equal(fx.state.runtime[chat].turns[2], other, 'turns without it are kept as they are');
    // a steer that opened its own turn here takes that turn with it
    onEvent({ kind: 'steerFailed', key: chat, chatId: chat, clientId: 'k3' });
    assert.deepEqual(
      fx.state.runtime[chat].turns.map((t: any) => t.id),
      ['ct-s1', 'other'],
    );
  });
}
