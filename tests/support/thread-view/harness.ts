// Conversation-view UI unit cases for harness.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render, settle, setStore, peerProps, T, text, user, reply, turn, chat, view } from './fixture.ts';

export function registerHarness() {
  for (const harness of ['codex', 'claude', 'acp:opencode']) {
    test(`${harness}: the thinking placeholder labels its phase beside the timer`, async (t) => {
      const now = Date.now();
      chat([turn('t1', [user('u1', 'Go')], { status: 'inProgress', startedAt: (now - 3000) / 1000 })], { activeTurnId: 't1' });
      setStore({ segments: { [T]: [{ nativeId: T, harness, start: 0 }] } });
      const v = await render(view());
      t.after(() => v.unmount());
      // nothing running yet: the status line under the task list, its thinking word after the clock
      assert.equal(text(v.$('.turn-status-slot .claude-activity-thinking')), '· Thinking…');
      assert.equal(v.$('.turn-status-slot .working-mark')?.getAttribute('data-activity'), 'think');
      const waiting = (items: any[], itemTimes = {}) =>
        chat([turn('t1', [user('u1', 'Go'), ...items], { status: 'inProgress', startedAt: (now - 3000) / 1000, itemTimes })], {
          activeTurnId: 't1',
        });
      // Each running group carries its label and clock in the same lower slot.
      const row = (sel: string) => v.$(`.turn-status-slot .claude-activity ${sel}`);
      await settle(() => waiting([{ id: 'cmd', type: 'commandExecution', command: 'ls', status: 'completed' }]));
      assert.equal(text(row('.claude-activity-label')), 'Running ls', 'waiting after a tool keeps its words');
      assert.equal(row('.claude-activity-thinking'), null, 'never "Thinking…" once a step has run');
      assert.equal(row('.working-mark')?.getAttribute('data-activity'), 'think');
      assert.equal(row('.claude-activity-time'), null, 'a running row shows its clock from five seconds');
      assert.equal(v.$$('.claude-activity').length, 1);
      assert.equal(v.$('.work .claude-activity'), null);
      await settle(() => waiting([reply('r', 'Checking the result', { phase: 'commentary' })], { r: { start: 1, end: 2 } }));
      assert.equal(text(v.$('.turn-status-slot .claude-activity-thinking')), '· Thinking…', 'waiting after commentary');
      await settle(() => waiting([reply('r', 'Still writing', { phase: 'commentary' })], { r: { start: 1 } }));
      assert.equal(v.$('.turn-status-slot .claude-activity-thinking'), null, 'streaming a reply is distinct from waiting on the model');
      assert.equal(v.$('.turn-status-slot .working-mark')?.getAttribute('data-activity'), 'default');
      await settle(() => waiting([{ id: 'cmd', type: 'commandExecution', command: 'ls', status: 'inProgress' }]));
      assert.equal(row('.claude-activity-thinking'), null, 'a live tool has its own activity');
      assert.equal(row('.working-mark')?.getAttribute('data-activity'), 'code');
      for (const [first, second] of [
        ['inProgress', 'inProgress'],
        ['completed', 'inProgress'],
        ['inProgress', 'completed'],
      ]) {
        await settle(() =>
          waiting([
            { id: 'cmd', type: 'commandExecution', command: 'ls', status: first },
            { id: 'other', type: 'commandExecution', command: 'pwd', status: second },
          ]),
        );
        assert.equal(row('.claude-activity-thinking'), null, 'a completed tool does not hide another live tool');
        assert.equal(row('.working-mark')?.getAttribute('data-activity'), 'code');
      }
      await settle(() => chat([turn('t1', [user('u1', 'Go'), reply('r', 'Done')], { status: 'completed' })]));
      assert.equal(v.$('.turn-status-slot .claude-activity'), null, 'completion clears the thinking indicator');
    });
  }

  test('a running Claude turn thinks with the Claude activity line, and replies stop streaming once they end', async () => {
    const now = Date.now();
    const segments = { [T]: [{ nativeId: T, harness: 'claude', start: 0 }] };
    chat([turn('t1', [user('u1', 'Go')], { status: 'inProgress', startedAt: (now - 3000) / 1000 })], { activeTurnId: 't1' });
    setStore({ segments });
    const v = await render(view());
    // the status line is after every turn, under the task list, as in the Code tab
    assert.equal(v.$('.work .claude-activity'), null);
    // nothing has happened yet: the thinking mark, with no words of its own
    assert.equal(v.$('.thread-column > .turn-status-slot .working-mark')?.getAttribute('data-activity'), 'think');
    assert.equal(v.$('.thread-column > .turn-status-slot .claude-activity-label'), null);
    // the placeholder waits before it fades in (#1511), so a quick first token never flashes it
    assert.ok(v.$('.turn-status-slot > .placeholder-reveal > .claude-activity'));
    assert.match(text(v.$('.turn-status-slot .claude-activity-time')), /^[34]s$/);
    // the running-tasks count follows the clock on the same line
    assert.equal(v.$('.turn-status-slot .claude-activity [data-stub="InlineTasksCount"]')?.dataset.chatid, T);
    assert.ok(!v.$('.worked-for'), 'a running Claude turn has no header');
    // a commentary reply that ended, and a final one still arriving
    const items = [
      user('u1', 'Go'),
      reply('r1', 'Looking', { phase: 'commentary' }),
      { id: 'c1', type: 'commandExecution', command: 'ls', status: 'completed' },
      reply('r2', 'Done'),
    ];
    await settle(() =>
      chat([turn('t1', items, { status: 'inProgress', itemTimes: { r1: { start: 1, end: 2 } } })], { activeTurnId: 't1' }),
    );
    const streaming = () => v.$$('[data-stub="Markdown"]').map((m) => [m.dataset.text, m.dataset.streaming]);
    assert.deepEqual(streaming(), [
      ['Looking', 'false'],
      ['Done', 'true'],
    ]);
    await settle(() =>
      chat([turn('t1', items, { status: 'inProgress', itemTimes: { r1: { start: 1, end: 2 }, r2: { start: 2, end: 3 } } })], {
        activeTurnId: 't1',
      }),
    );
    assert.deepEqual(streaming(), [
      ['Looking', 'false'],
      ['Done', 'false'],
    ]);
    await v.unmount();
  });

  test('a message from another chat shows the sender and its own text, and a lone question reply shows as one bubble', async () => {
    const reply1 = '<send_user_message_question_reply>[{"question":"Which file?","answer":"a.ts"}]</send_user_message_question_reply>';
    const quoted =
      '# Response annotations:\n<response-annotations>[{"text":"Earlier quote","annotation":"Note"}]</response-annotations>\n## My request:\n' +
      reply1;
    chat([turn('t1', [user('peer-item', '<peer_message>Please review</peer_message>'), user('qr', reply1), user('qa', quoted)])]);
    const v = await render(view());
    // main's journal supplies the text the sender wrote, not the prompt the agent received
    await settle(() =>
      peerProps.onMessages([
        {
          id: 'pm',
          sourceChatId: 'other',
          sourceTitle: 'Reviewer',
          targetChatId: T,
          targetItemId: 'peer-item',
          delivery: 'delivered',
          body: 'Please review',
        },
      ]),
    );
    // the sender by name (the title kept with the message: this window lists no such chat), never its id, and never as the user's words
    const peerNote = v.$('.side-session-card[data-kind="message"]')!;
    assert.match(text(peerNote.querySelector('.side-session-note-head')), /^Received message from Reviewer/);
    assert.doesNotMatch(text(peerNote), /\bother\b/);
    await settle(() => (peerNote.querySelector('.side-session-toggle') as HTMLElement).click());
    assert.equal(text(peerNote.querySelector('.side-session-text')), 'Please review');
    const [lone, withQuote] = v.$$('.user-message');
    // a lone reply: the question sits in the bubble, not as a quote
    assert.equal(text(lone.querySelector('.question-reply-summary')), 'Which file?');
    assert.ok(!lone.querySelector('.user-annotations'));
    // beside other quotes, only the question is left out of the quote list
    assert.deepEqual(
      [...withQuote.querySelectorAll('.user-annotation-quote')].map((q) => q.textContent),
      ['Earlier quote'],
    );
    assert.equal(text(withQuote.querySelector('.question-reply-summary')), 'Which file?');
    await v.unmount();
  });

  test('quiet turns keep a visible clock ticking without native start timestamps on either activity style', async (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 1700000000000 });
    for (const harness of ['codex', 'claude']) {
      const quiet = turn('quiet', [user('u1', 'Go')], { status: 'inProgress', durationMs: 0 });
      chat([quiet], { activeTurnId: 'quiet' });
      setStore({ segments: { [T]: [{ nativeId: T, harness, start: 0 }] } });
      const v = await render(view());
      // every harness shows the same activity line
      const selector = '.claude-activity-time';
      try {
        // as in Claude Code, the clock joins the line once the turn has run two seconds
        assert.equal(v.$(selector), null);
        await settle(() => t.mock.timers.tick(18000));
        assert.equal(text(v.$(selector)), '18s');
        await settle(() => chat([{ ...quiet, status: 'completed', durationMs: 18000 }], { activeTurnId: null }));
        assert.equal(v.$(selector), null, 'completion removes the live activity clock');
      } finally {
        await v.unmount();
      }
    }
  });
}
