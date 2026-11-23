// Sends whose images are read off main's thread (electron/harness/claude/message.cjs through ChatController.claudeSend and
// electron/harness/acpTurns.cjs): a chat's sends keep their order, a Stop or a turn's end while an image is read
// means that send is not started and it waits first in line, and a steer behaves as before. Readers are faked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { setup, tick } from './support/controller/fixture';

const { AcpTurns } = createRequire(import.meta.url)('../electron/harness/acpTurns.cjs');

/** An image reader whose reads finish when the test says so. */
function slowReader() {
  const pending = new Map<string, (source: unknown) => void>();
  const read = (file: string) =>
    new Promise((resolve) => {
      pending.set(file, resolve);
    });
  const finish = async (file: string, data: string | null = file) => {
    while (!pending.has(file)) await tick();
    pending.get(file)?.(data && { type: 'base64', media_type: 'image/png', data });
  };
  return { read, finish, waiting: () => [...pending.keys()] };
}

const image = (path: string) => ({ kind: 'image', path, name: path.slice(1) });
const sentTexts = (sends: any[]) =>
  sends.map(([, , message, priority]) => [
    typeof message.content === 'string'
      ? message.content
      : message.content.map((b: any) => (b.type === 'image' ? `img:${b.source.data}` : b.text)).join('+'),
    priority ?? null,
  ]);

test('two sends keep their order while the first converts an image, whichever read finishes first', async () => {
  const { c, claudeSends, execs } = setup({ auto: false });
  const reader = slowReader();
  c.readImage = reader.read;
  const chat = 'claude:s1';
  c.send(chat, { text: 'look', attachments: [image('/a.heic')], opts: { human: true } }, 1);
  const first = c.claudeSend(chat, chat, {}, { text: 'look', attachments: [image('/a.heic')] }, undefined, { uuid: 'u1', human: true });
  // a steer with its own image, a steer the window built, and one with only text: all wait behind the turn's message
  const second = c.claudeSend(chat, chat, {}, { text: 'and this', attachments: [image('/b.png')] }, 'now', { uuid: 'u2' });
  const third = c.claudeSend(chat, chat, {}, { role: 'user', content: 'built' }, 'now', { uuid: 'u3' });
  const fourth = c.claudeSend(chat, chat, {}, { text: 'text only' }, 'now', { uuid: 'u4' });
  await tick();
  assert.deepEqual(claudeSends, []);
  assert.deepEqual(reader.waiting(), ['/a.heic']);
  await reader.finish('/a.heic', 'A');
  await reader.finish('/b.png', 'B');
  await Promise.all([first, second, third, fourth]);
  assert.deepEqual(sentTexts(claudeSends), [
    ['img:A+look', null],
    ['img:B+and this', 'now'],
    ['built', 'now'],
    ['text only', 'now'],
  ]);
  // the steers counted in the turn: it ends on the fourth result
  assert.equal(c.rt(chat).outstanding, 4);
  assert.equal(c.rt(chat).claudeSending, null);
  execs[0].done({ started: true });
});

test('a send behind a converting one reads its own image only after the one before reached Claude', async () => {
  const { c, claudeSends } = setup();
  const reader = slowReader();
  c.readImage = reader.read;
  const chat = 'claude:s2';
  c.send(chat, { text: 'go' }, 1);
  await tick();
  const first = c.claudeSend(chat, chat, {}, { text: 'one', attachments: [image('/1.heic')] }, 'now', { uuid: 'u1' });
  const second = c.claudeSend(chat, chat, {}, { text: 'two', attachments: [image('/2.heic')] }, 'now', { uuid: 'u2' });
  await tick();
  assert.deepEqual(reader.waiting(), ['/1.heic']);
  await reader.finish('/1.heic', null);
  await first;
  await reader.finish('/2.heic', '2');
  await second;
  assert.deepEqual(sentTexts(claudeSends), [
    ["one\n[1.heic couldn't be attached]", 'now'],
    ['img:2+two', 'now'],
  ]);
});

for (const order of ['turn first', 'steer first'] as const) {
  test(`a Stop while the turn's image is read sends nothing, and both messages wait first in line in order (${order})`, async () => {
    const { c, s, claudeSends, execs, stops } = setup({ auto: false });
    const reader = slowReader();
    c.readImage = reader.read;
    const chat = 'claude:s3';
    c.send(chat, { id: 'turn', text: 'look', attachments: [image('/a.heic')], opts: { human: true } }, 1);
    // a message already waiting stays behind both
    c.send(chat, { id: 'later', text: 'queued after' }, 1);
    // the adapter builds the turn's message (electron/harness/claude/adapter.cjs beginTurn)
    const turn = c.claudeSend(chat, chat, {}, { text: 'look', attachments: [image('/a.heic')] }, undefined, { uuid: 'u1' });
    assert.equal(c.send(chat, { id: 'steer', text: 'also', followUp: 'steer' }, 1).action, 'steered');
    await tick();
    const steer = c.claudeSend(chat, chat, {}, { text: 'also' }, 'now', { uuid: 'u2' });
    // Stop: the adapter interrupts, which marks the turn stopped (ChatController.onClaudeControl)
    assert.equal(await c.stopChat(chat), true);
    assert.deepEqual(stops, [chat]);
    c.onClaudeControl(chat, 'interrupt');
    await reader.finish('/a.heic', 'A');
    await assert.rejects(turn, /Stopped before this message was sent/);
    await assert.rejects(steer, /Stopped before this message was sent/);
    assert.deepEqual(claudeSends, []);
    // the adapters report that neither started, in either order
    const [turnExec, steerExec] = [execs.find((e) => e.kind === 'claude-turn'), execs.find((e) => e.kind === 'claude-steer')];
    const fail = (e: any) => e.done({ started: false, error: 'Stopped before this message was sent' });
    if (order === 'turn first') fail(turnExec);
    else fail(steerExec);
    await tick();
    if (order === 'turn first') fail(steerExec);
    else fail(turnExec);
    await tick();
    await tick();
    assert.equal(s(chat).turn, 'idle');
    assert.deepEqual(
      s(chat).queue.map((q: any) => q.id),
      ['turn', 'steer', 'later'],
    );
  });
}

test("a turn that ends while a steer's image is read doesn't take the steer; a steer into a stopped turn still goes", async () => {
  const { c, s, claudeSends } = setup();
  const reader = slowReader();
  c.readImage = reader.read;
  const chat = 'claude:s4';
  c.send(chat, { text: 'go' }, 1);
  await tick();
  await c.claudeSend(chat, chat, {}, { text: 'go' }, undefined, { uuid: 'u1' });
  const late = c.claudeSend(chat, chat, {}, { text: 'late', attachments: [image('/late.heic')] }, 'now', { uuid: 'u2' });
  c.onClaudeEvent({ key: chat, kind: 'message', msg: { type: 'result', subtype: 'success' } });
  assert.equal(s(chat).turn, 'idle');
  await reader.finish('/late.heic');
  await assert.rejects(late, /The turn ended before this message was sent/);
  assert.equal(claudeSends.length, 1);

  // stopped before the steer came: it goes into the turn as it did before
  c.send(chat, { text: 'again' }, 1);
  await tick();
  await c.claudeSend(chat, chat, {}, { text: 'again' }, undefined, { uuid: 'u3' });
  c.onClaudeControl(chat, 'interrupt');
  const after = c.claudeSend(chat, chat, {}, { text: 'after stop', attachments: [image('/s.heic')] }, 'now', { uuid: 'u4' });
  await reader.finish('/s.heic', 'S');
  await after;
  assert.deepEqual(sentTexts(claudeSends).at(-1), ['img:S+after stop', 'now']);
});

test('a send with no image and nothing ahead of it reaches Claude at once', () => {
  const { c, claudeSends } = setup();
  const chat = 'claude:s5';
  c.send(chat, { text: 'go' }, 1);
  void c.claudeSend(chat, chat, {}, { text: 'go', attachments: [{ kind: 'file', path: '/f.ts', name: 'f.ts' }] }, undefined, {
    uuid: 'u1',
  });
  assert.deepEqual(sentTexts(claudeSends), [['go\n@/f.ts', null]]);
});

test('ACP: a Stop while the images are read means the prompt is not sent and the message waits first in line', async () => {
  const { c, s, acpSends, acpCancels } = setup();
  const pending: ((url: string | null) => void)[] = [];
  const events: any[] = [];
  c.acpTurns = new AcpTurns({
    send: (chatId: string, key: string, payload: any, meta: any) => c.acpSend(chatId, key, payload, meta),
    rename: () => undefined,
    readImage: () => new Promise((resolve) => pending.push(resolve)),
    emit: (e: any) => (events.push(e), true),
    turnCheck: (chatId: string) => c.turnCheck(chatId),
  });
  const chat = 'acp:kimi:k1';
  c.send(chat, { id: 'm1', text: 'look', attachments: [image('/a.heic')] }, 1);
  while (!pending.length) await tick();
  assert.equal(await c.stopChat(chat), true);
  assert.deepEqual(acpCancels, [chat]);
  pending[0]('data:image/png;base64,QQ==');
  while (s(chat).turn !== 'idle') await tick();
  assert.deepEqual(acpSends, []);
  assert.equal(events.at(-1).kind, 'turnFailed');
  assert.equal(events.at(-1).error, 'Stopped before this message was sent');
  assert.deepEqual(
    s(chat).queue.map((q: any) => q.id),
    ['m1'],
  );

  // sent again, with no Stop, it goes
  c.sendNow(chat, 'm1', 1);
  while (pending.length < 2) await tick();
  pending[1]('data:image/png;base64,QQ==');
  while (!acpSends.length) await tick();
  assert.deepEqual(
    (acpSends as any[])[0][1].blocks.map((b: any) => b.type),
    ['text', 'image'],
  );
});
