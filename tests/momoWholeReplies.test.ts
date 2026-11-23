// MoMo's replies arrive whole in the shell (M0b): inside the WholeReplies context a reply that is still arriving is not drawn (the chat's header says "Thinking it through" meanwhile) and appears complete, once its turn has it, as one bubble that rises in; outside it (every coding chat, and MoMo's own chat with the shell off) the reply streams exactly as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { h, render, settle, user, reply, turn, chat, view } from './support/thread-view/fixture.ts';
const { WholeReplies, useWholeReplies } = await import('../src/components/momo/shell/wholeReplies.ts');

const running = (text: string, extra: any = {}) =>
  chat([turn('t1', [user('u', 'Hi'), reply('r1', text, extra)], { status: 'inProgress', itemTimes: {} })], { activeTurnId: 't1' });
const done = (text: string, completedAt: number | null) =>
  chat([turn('t1', [user('u', 'Hi'), reply('r1', text)], { status: 'completed', completedAt, itemTimes: { r1: { start: 1, end: 2 } } })]);
const whole = (on: boolean) => h(WholeReplies.Provider, { value: on }, view());
const bubble = (v: any) => v.$('.assistant-message') as HTMLElement | null;
const markdownText = (v: any) => (v.$('[data-stub="Markdown"]') as HTMLElement | null)?.dataset.text ?? null;

test('the context is off unless the shell provides it', async () => {
  let seen: boolean | null = null;
  const Probe = () => ((seen = useWholeReplies()), null);
  const v = await render(h(Probe));
  assert.equal(seen, false);
  await v.unmount();
});

test('on: a reply still arriving is not drawn; once whole it is one bubble that arrives', async () => {
  running('Half a sen');
  const v = await render(whole(true));
  assert.equal(bubble(v), null);
  assert.equal(markdownText(v), null, 'no token of it is on screen');
  const nowSeconds = Math.floor(Date.now() / 1000);
  await settle(() => done('Half a sentence, whole.', nowSeconds));
  assert.equal(markdownText(v), 'Half a sentence, whole.');
  assert.equal(bubble(v)!.getAttribute('data-arrive'), '', 'it rises in, as the arrival token says');
  await v.unmount();
});

test('on: a reply from history is whole and still, with nothing to arrive', async () => {
  done('Old reply', 1);
  const v = await render(whole(true));
  assert.equal(markdownText(v), 'Old reply');
  assert.equal(bubble(v)!.hasAttribute('data-arrive'), false);
  await v.unmount();
});

test('on: a note MoMo wrote between steps waits for its end too, then appears whole', async () => {
  const command = { id: 'cmd', type: 'commandExecution', command: 'ls', status: 'completed' };
  const note = (end?: number) =>
    chat(
      [
        turn('t1', [user('u', 'Hi'), reply('n1', 'Looking now.'), command, reply('r1', 'Done.')], {
          status: 'inProgress',
          itemTimes: { n1: end ? { start: 1, end } : { start: 1 } },
        }),
      ],
      { activeTurnId: 't1' },
    );
  note();
  const v = await render(whole(true));
  assert.equal(v.$('.commentary'), null, 'a note still arriving is not drawn');
  await settle(() => note(2));
  assert.equal((v.$('.commentary [data-stub="Markdown"]') as HTMLElement).dataset.text, 'Looking now.');
  assert.ok(v.$('.commentary[data-arrive]'), 'a note that arrives live rises in, as the reply does');
  await v.unmount();
});

test('off: a reply streams as it always did, token by token, in coding chats and in MoMo with the shell off', async () => {
  running('Half a sen');
  const v = await render(whole(false));
  assert.equal(markdownText(v), 'Half a sen');
  assert.equal(bubble(v)!.hasAttribute('data-arrive'), false);
  await v.unmount();
});

test('off: a note between steps streams as it always did too, with nothing marked to arrive', async () => {
  const command = { id: 'cmd', type: 'commandExecution', command: 'ls', status: 'completed' };
  chat(
    [
      turn('t1', [user('u', 'Hi'), reply('n1', 'Looking no'), command], {
        status: 'inProgress',
        itemTimes: { n1: { start: 1 } },
      }),
    ],
    { activeTurnId: 't1' },
  );
  const v = await render(whole(false));
  assert.equal((v.$('.commentary [data-stub="Markdown"]') as HTMLElement).dataset.text, 'Looking no');
  assert.equal(v.$('.commentary[data-arrive]'), null);
  await v.unmount();
});
