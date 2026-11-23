// The dev host's fake app holds a follow-up sent while a turn runs, as the Mac does: listed in session.queue, taken back by id, kept across a Stop, sent in order once a turn completes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { until } from './support/mobileStack.ts';
import { createFakeApp } from '../scripts/mobile-dev-host/fakeApp.mjs';

function rig() {
  const events: any[] = [];
  const app = createFakeApp({
    repo: '/repo',
    log: () => undefined,
    now: () => 5_000_000,
    sleep: async () => undefined,
    status: async () => ' M src/price.ts\n',
  });
  app.bind({ attached: true, onFeedEvent: (e: any) => events.push(e), onSessionPatch: () => undefined });
  const cardOf = async (id: string) => (await app.ops.cardsOf(id))[0];
  const start = async () => (await app.ops.start({ harness: 'codex', text: 'check the repo', projectId: null })).chatId as string;
  return { app, ops: app.ops, cardOf, start, events };
}

test('a follow-up sent while a turn runs waits in the chat queue, can be taken back, and the rest run in order afterwards', async () => {
  const { app, ops, cardOf, start } = rig();
  const id = await start();
  await until(() => cardOf(id), 'the card');
  await ops.send({ chatId: id, text: 'first follow-up' });
  await ops.send({ chatId: id, text: 'second follow-up' });
  const queue = ops.state.get(id).queue;
  assert.deepEqual(
    queue.map((q: any) => q.text),
    ['first follow-up', 'second follow-up'],
  );
  assert.equal(ops.unqueue(id, queue[0].id), true);
  assert.equal(ops.unqueue(id, queue[0].id), false, 'already taken back');
  assert.equal(await ops.requeue(id, queue[1].id), null, 'nothing here is kept for a machine: nothing to send again');
  assert.equal(ops.state.get(id).queue.length, 1);
  app.macAnswers(id, 'deny');
  await until(() => ops.state.get(id).queue.length === 0, 'the second follow-up to start');
  assert.equal(ops.state.get(id).queue.length, 0, 'its turn took it off the queue');
  const users = (await ops.read(id)).rows.filter((r: any) => r.role === 'user').map((r: any) => r.text);
  assert.deepEqual(users.slice(1), ['second follow-up'], 'the one taken back never ran');
  app.macAnswers(id, 'deny');
  await app.idle();
});

test('after a Stop the held messages stay; a message sent then starts at once and the held ones follow it, in order', async () => {
  const { app, ops, cardOf, start } = rig();
  const id = await start();
  await until(() => cardOf(id), 'the card');
  await ops.send({ chatId: id, text: 'held one' });
  await ops.send({ chatId: id, text: 'held two' });
  await ops.stop(id);
  await app.idle();
  assert.deepEqual(
    ops.state.get(id).queue.map((q: any) => q.text),
    ['held one', 'held two'],
    'a Stop sends nothing',
  );
  await ops.send({ chatId: id, text: 'after the stop' });
  await until(() => cardOf(id), 'the new turn card');
  const users = async () => (await ops.read(id)).rows.filter((r: any) => r.role === 'user').map((r: any) => r.text);
  assert.deepEqual((await users()).slice(1), ['after the stop'], 'the new message went first');
  app.macAnswers(id, 'deny');
  await until(async () => (await users()).includes('held one'), 'the first held message');
  assert.deepEqual((await users()).slice(1), ['after the stop', 'held one']);
  app.macAnswers(id, 'deny');
  await until(async () => (await users()).includes('held two'), 'the second held message');
  assert.deepEqual((await users()).slice(1), ['after the stop', 'held one', 'held two']);
  app.macAnswers(id, 'deny');
  await app.idle();
  assert.equal(ops.state.get(id).queue.length, 0);
});

test('a picture sent with a message stays with it: the row says how many, and the thumbnail is read again (messages.image), for a started chat and for a message that waited', async () => {
  const { app, ops, cardOf } = rig();
  const picture = 'QUJD';
  const photo = ops.attach({ name: 'p.jpg', dataUrl: `data:image/jpeg;base64,${picture}` }).id;
  const note = ops.attach({ name: 'n.txt', dataUrl: 'data:text/plain;base64,QUJD' }).id;
  const id = (await ops.start({ harness: 'codex', text: 'look at this', projectId: null, attachments: [photo, note] })).chatId as string;
  await until(() => cardOf(id), 'the card');
  const first = (await ops.read(id)).rows.find((r: any) => r.role === 'user');
  assert.equal(first.images, 1, 'only the picture counts, not the text file');
  assert.deepEqual(ops.userImage(id, first.id, 0), { data: picture, width: 1, height: 1 });
  assert.equal(ops.userImage(id, first.id, 1), null, 'no second picture');
  assert.equal(ops.userImage(id, 'missing', 0), null);
  // while the turn waits the message is held with its count, and keeps its picture when it is sent
  await ops.send({ chatId: id, text: 'and this', attachments: [photo] });
  await ops.send({ chatId: id, text: 'no picture', attachments: [note] });
  assert.deepEqual(
    ops.state.get(id).queue.map((q: any) => q.images),
    [1, undefined],
  );
  // each held message runs its own turn, which waits on its own card
  app.macAnswers(id, 'deny');
  await until(() => ops.state.get(id).queue.length === 1, 'the first held message to start');
  await until(() => cardOf(id), 'its card');
  app.macAnswers(id, 'deny');
  await until(() => ops.state.get(id).queue.length === 0, 'the queue to empty');
  const rows = (await ops.read(id)).rows.filter((r: any) => r.role === 'user');
  assert.deepEqual(
    rows.map((r: any) => r.images),
    [1, 1, undefined],
  );
  assert.deepEqual(ops.userImage(id, rows[1].id, 0), { data: picture, width: 1, height: 1 });
  await until(() => cardOf(id), 'the last card');
  app.macAnswers(id, 'deny');
  await app.idle();
});

test('the live item of a message with pictures carries a part for each, so a phone does not show the message twice; a big picture reads as a small one', async () => {
  const { app, ops, cardOf, events } = rig();
  const big = ops.attach({ name: 'big.jpg', dataUrl: `data:image/jpeg;base64,${'A'.repeat(1_600_000)}` }).id;
  const small = ops.attach({ name: 'small.jpg', dataUrl: 'data:image/jpeg;base64,QUJD' }).id;
  const id = (
    await ops.start({ harness: 'codex', text: 'two pictures', projectId: null, attachments: [big, small], nativeMessageId: 'native-1' })
  ).chatId as string;
  await until(() => cardOf(id), 'the card');
  const users = () => events.flatMap((e) => e.items ?? []).filter((i: any) => i?.type === 'userMessage');
  const parts = (item: any) => item.content.filter((c: any) => c.type === 'image').length;
  assert.equal(parts(users()[0]), 2);
  assert.equal(ops.userImage(id, users()[0].messageId, 1)!.data, 'QUJD', 'the live message is read by the id the feed gave it');
  assert.equal(ops.userImage(id, users()[0].rowId, 1)!.data, 'QUJD', 'and by the row id of its turn');
  const user = (await ops.read(id)).rows.find((r: any) => r.role === 'user');
  assert.equal(user.images, 2);
  assert.equal(user.clientId, 'native-1', "the saved row names the phone's send, as the Mac's does");
  assert.equal(users()[0].clientId, 'native-1', 'and so does the live item');
  assert.ok(ops.userImage(id, user.id, 0)!.data.length < 1000, 'the big picture reads as a small one');
  assert.equal(ops.userImage(id, user.id, 1)!.data, 'QUJD', 'a small one is read as it was sent');
  // a message that waited behind the turn carries its pictures when it is sent; one with none carries none
  await ops.send({ chatId: id, text: 'later', attachments: [small], nativeMessageId: 'native-2' });
  assert.equal(ops.state.get(id).queue[0].nativeId, 'native-2', 'the held message carries the id too');
  await ops.send({ chatId: id, text: 'plain' });
  app.macAnswers(id, 'deny');
  await until(() => ops.state.get(id).queue.length === 1, 'the first held message to start');
  assert.equal(parts(users().at(-1)), 1);
  assert.equal(users().at(-1).clientId, 'native-2');
  await until(() => cardOf(id), 'its card');
  app.macAnswers(id, 'deny');
  await until(() => ops.state.get(id).queue.length === 0, 'the queue to empty');
  assert.equal(parts(users().at(-1)), 0);
  assert.equal('clientId' in users().at(-1), false, 'a message sent without an id names none');
  await until(() => cardOf(id), 'the last card');
  app.macAnswers(id, 'deny');
  await app.idle();
});

test('the scripted reply names the pictures a message came with and quotes nothing when the message is only a picture (the review demo host)', async () => {
  const { app, ops, cardOf } = rig();
  const photo = ops.attach({ name: 'p.jpg', dataUrl: 'data:image/jpeg;base64,QUJD' }).id;
  const second = ops.attach({ name: 'q.jpg', dataUrl: 'data:image/jpeg;base64,QUJD' }).id;
  const note = ops.attach({ name: 'n.txt', dataUrl: 'data:text/plain;base64,QUJD' }).id;
  const replyTo = async (text: string, attachments: string[]) => {
    const id = (await ops.start({ harness: 'codex', text, projectId: null, attachments })).chatId as string;
    await until(() => cardOf(id), 'the card');
    const reply = (await ops.read(id)).rows.find((r: any) => r.role === 'assistant').text;
    app.macAnswers(id, 'deny');
    await app.idle();
    return reply;
  };
  assert.equal(
    await replyTo('', [photo]),
    "Got your picture. I'll check the repository state first.",
    'a picture and no words: nothing to quote',
  );
  assert.equal(
    await replyTo('  ', [photo, second]),
    "Got your 2 pictures. I'll check the repository state first.",
    'white space is no words',
  );
  assert.equal(
    await replyTo('look at this', [photo]),
    'Got your picture. I\'ll check the repository state first, then summarize what I find for "look at this".',
  );
  assert.equal(
    await replyTo('look', [note]),
    'I\'ll check the repository state first, then summarize what I find for "look".',
    'a text file is not a picture',
  );
  assert.equal(
    await replyTo('check the repo', []),
    'I\'ll check the repository state first, then summarize what I find for "check the repo".',
    'a plain message is as before',
  );
});
