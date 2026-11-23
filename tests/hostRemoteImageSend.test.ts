// Remote image sends remain visibly retained on old Hosts, then upload through the negotiated channel before one native send under the original durable key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { world, msg, UUID } from './support/host/remoteSendKit.ts';
import { createHostImages } from '../host/src/chatImages.mjs';

test('an old Host leaves an image queued with a visible capability refusal; upgrading and retrying sends once under the same key', async (t) => {
  const w = world(t);
  w.remote('chat');
  const file = path.join(w.dir, 'picked.png');
  fs.writeFileSync(file, Buffer.from('89504e470d0a1a0a00000000', 'hex'));
  const key = UUID(11);
  const item = { ...msg('look', key), attachments: [{ kind: 'image', path: file }] };
  const reply = await w.service.send('chat', item, null);
  assert.equal(reply.action, 'queued');
  assert.match(reply.error, /cannot receive images/);
  assert.equal(w.sent.length, 0);
  assert.equal(w.outboxes[0].pending('chat')[0].key, key);
  const images = createHostImages({ dir: path.join(w.dir, 'host-private') });
  const host: any = w.host;
  const calls: any[] = [];
  host.speaks = () => true;
  host.call = async (method: string, p: any) => {
    calls.push(p);
    return { result: await images.upload({ ...p, owner: 'paired-mac' }) };
  };
  assert.deepEqual(await w.service.sendNow('chat', key), { status: 'sent' });
  assert.equal(w.sent.length, 1);
  assert.equal(w.sent[0].key, key);
  assert.equal(w.sent[0].item.images.length, 1);
  assert.equal(w.sent[0].item.attachments, undefined);
  assert.equal(calls[0].chatId, 'chat');
  assert.equal(JSON.stringify(calls).includes(file), false);
  assert.equal(w.outboxes[0].pending('chat').length, 0);
});

test('a folder changed while an image upload waits retains the input for a fresh folder check and never dispatches it', async (t) => {
  const w = world(t);
  w.remote('chat', 'box', 1, '/old');
  const file = path.join(w.dir, 'picked.png');
  fs.writeFileSync(file, Buffer.from('89504e470d0a1a0a00000000', 'hex'));
  const host: any = w.host;
  host.speaks = () => true;
  host.call = async (_method: string, p: any) => {
    w.remote('chat', 'box', 1, '/new');
    return { result: { imageId: p.imageId, received: p.size, done: true } };
  };
  const reply = await w.service.send('chat', { ...msg('look', UUID(12)), attachments: [{ kind: 'image', path: file }] }, null);
  assert.equal(reply.action, 'queued');
  assert.match(reply.error, /folder changed/);
  assert.equal(w.sent.length, 0);
  assert.equal(w.outboxes[0].pending('chat').length, 1);
});
