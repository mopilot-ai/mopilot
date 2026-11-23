// Hook notices remain visible through the completed conversation view, including a rejected prompt's notice-only history.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTurns } from './support/claude-translate.ts';
import { chat, view, render, turn, user, reply } from './support/thread-view/fixture.ts';

test('a replayed rejected prompt shows its reason without opening a work disclosure', async () => {
  const turns = buildTurns(
    [
      {
        type: 'system',
        subtype: 'informational',
        level: 'warning',
        uuid: 'blocked',
        prevent_continuation: true,
        content: 'The project policy blocked this prompt.',
      },
    ],
    'claude:chat',
    '/repo',
  );
  chat(turns);
  const v = await render(view());
  assert.equal(v.$('.hook-feedback')?.textContent, 'The project policy blocked this prompt.');
  assert.equal(v.$('.worked-for'), null);
  await v.unmount();
});

test('several notices retain their messages and stay visible beside a completed reply and folded tool work', async () => {
  const notes = ['First hook warning.\nRun setup.', 'Second hook warning.'].map((text, n) => ({
    type: 'hookPrompt',
    id: `notice-${n}`,
    fragments: [{ text }],
  }));
  chat([
    turn('finished', [
      user('u', 'Fix the code.'),
      { type: 'commandExecution', id: 'cmd', command: 'npm test', status: 'completed', aggregatedOutput: 'passed' },
      reply('a', 'Done.'),
      ...notes,
    ]),
  ]);
  const v = await render(view());
  assert.deepEqual(
    Array.from(v.host.querySelectorAll('.hook-feedback')).map((n) => n.textContent),
    notes.map((n) => n.fragments[0].text),
  );
  assert.doesNotMatch(v.$('.worked-for')?.className ?? '', /open/);
  await v.unmount();
});

test('a hook-only reply has completion actions without inventing a work header', async () => {
  for (const status of ['inProgress', 'completed']) {
    chat([
      turn(
        'hook-reply',
        [
          user('u', 'DENYME and HOOKFAIL'),
          { type: 'hookPrompt', id: 'notice', fragments: [{ text: 'lint found 3 problems' }] },
          reply('a', 'The action was declined.'),
        ],
        { status },
      ),
    ]);
    const v = await render(view());
    assert.equal(v.$('.hook-feedback')?.textContent, 'lint found 3 problems');
    assert.equal(v.$('.message-actions') !== null, status === 'completed');
    if (status === 'completed') assert.equal(v.$('.worked-for'), null);
    await v.unmount();
  }
});
