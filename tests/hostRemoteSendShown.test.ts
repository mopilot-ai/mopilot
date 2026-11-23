// A message the window draws in the transcript at once is not shown again in the chat's queue once the Host has it (electron/host/remoteSendProjection.cjs); one it does not draw, and one the machine does not have yet, still are.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { UUID, msg, world } from './support/host/remoteSendKit.ts';
import { waitFor } from './support/waitFor.ts';

const withPicture = (w: ReturnType<typeof world>, text: string, id: string) => {
  const file = path.join(w.dir, 'one.png');
  fs.writeFileSync(file, Buffer.from('89504e470d0a1a0a00000000', 'hex'));
  // a Host that takes pictures
  const host: any = w.host;
  host.speaks = () => true;
  host.call = async (_method: string, p: any) => ({ result: { imageId: p.imageId, received: p.size, done: true } });
  return { ...msg(text, id), attachments: [{ kind: 'image', path: file }] };
};
const rows = (w: ReturnType<typeof world>) => (w.queues.get('c1') ?? []).map((q) => [q.id, q.waitingFor]);

test('a message the window draws is not in the queue after the Host took it, and its pictures stay readable until the turn is applied', async (t) => {
  const w = world(t);
  w.remote('c1');
  const item = withPicture(w, 'look', UUID(1));
  const reply = await w.service.send('c1', item, 1, true);
  assert.deepEqual(reply, { action: 'started', id: UUID(1) });
  assert.deepEqual(rows(w), []);
  // each picture keeps the digest its upload made, which names the machine's copy in the saved message
  assert.deepEqual(
    w.service.sent.attached('c1', UUID(1)),
    item.attachments.map((a: any) => ({ ...a, imageId: createHash('sha256').update(fs.readFileSync(a.path)).digest('hex') })),
  );
  assert.equal(w.service.sent.attached('c1', UUID(2)), undefined);
  assert.equal(w.service.sent.attached('c1'), undefined);
  assert.equal(w.service.sent.attached('other', UUID(1)), undefined);
  w.service.sent.seen('c1', 'look', UUID(1));
  assert.equal(w.service.sent.attached('c1', UUID(1)), undefined);
});

test('a message sent while a turn runs is not drawn by the window: the queue shows it as sent until the transcript has it', async (t) => {
  const w = world(t);
  w.remote('c1');
  await w.service.send('c1', msg('more', UUID(1)), 1);
  assert.deepEqual(rows(w), [[UUID(1), undefined]]);
  w.service.sent.seen('c1', 'more', UUID(1));
  assert.deepEqual(rows(w), []);
});

test('a drawn message the machine does not have yet waits in the queue as "Waiting for host", and shows no longer once it is sent', async (t) => {
  const w = world(t);
  w.remote('c1');
  w.goAway();
  const reply = await w.service.send('c1', withPicture(w, 'look', UUID(1)), 1, true);
  assert.equal(reply!.action, 'queued');
  assert.deepEqual(rows(w), [[UUID(1), 'host']]);
  await w.comeBack();
  await waitFor(() => w.sent.length === 1, 'the message to reach the machine');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(rows(w), []);
  assert.equal(w.sent.length, 1);
});

test('a message a phone keeps for the machine is not drawn by any window, so the queue shows it from the start', async (t) => {
  const w = world(t);
  w.remote('c1');
  assert.deepEqual(w.service.enqueue('c1', msg('from the phone', UUID(7)), null), { action: 'queued', id: UUID(7) });
  const [kept] = w.outboxes[0].pending('c1');
  assert.equal(kept.options.requiresFolderCheck, true);
  assert.equal(kept.options.shown, undefined);
});
