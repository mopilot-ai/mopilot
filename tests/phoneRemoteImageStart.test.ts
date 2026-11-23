// Explicit phone upload capabilities are scoped to the exact paired client generation before the remote-start facade sees attachment bytes or private paths.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rig } from './support/remote-kit.ts';
import { fakeHost, ok, fail } from './support/remoteHostKit.ts';
const id = '0123456789abcdef';
const file = { kind: 'image', path: '/private/explicitly-picked.png', name: 'picked.png' };

test('only the uploading paired phone can start an image-only Host chat with its opaque attachment id', async () => {
  const { host, calls } = fakeHost();
  const consumed: string[][] = [];
  const r = rig({
    host: () => host,
    ops: {
      attach: async () => ({ id, kind: 'image', name: 'picked.png' }),
      attachmentsForHost: (ids: string[]) => {
        assert.deepEqual(ids, [id]);
        return [file];
      },
      attachmentsSent: (ids: string[]) => consumed.push(ids),
    },
  });
  const first = r.phone('p1'),
    second = r.phone('p2');
  const attachment = ok(await first.ask('chat.attach', { name: 'picked.png', dataUrl: 'data:image/png;base64,aGVsbG8=' }));
  const request = { harness: 'claude', text: '', hostId: 'ssh:box', folder: '/srv', attachments: [attachment.id] };
  fail(await second.ask('chat.start', request), 'forbidden');
  assert.equal(calls.length, 0);
  assert.deepEqual(ok(await first.ask('chat.start', request)), { chatId: 'acp:host-claude:1' });
  assert.deepEqual(calls[0][1].attachments, [file]);
  assert.deepEqual(consumed, [[id]]);
  assert.equal(JSON.stringify(first.inbox).includes(file.path), false, 'the phone receives an opaque id, never a Mac path');
});

test('a replacement paired client with the same pair id cannot inherit an earlier generation upload capability', async () => {
  const { host, calls } = fakeHost();
  const r = rig({ host: () => host, ops: { attach: async () => ({ id, kind: 'image', name: 'picked.png' }) } });
  const phone = r.phone('p1');
  ok(await phone.ask('chat.attach', { name: 'picked.png', dataUrl: 'data:image/png;base64,aGVsbG8=' }));
  const previous = r.service.phones.get('p1');
  r.service.phones.set('p1', { ...previous, client: { ...previous.client, follows: new Set() } });
  fail(
    await phone.ask('chat.start', { harness: 'codex', text: 'look', hostId: 'ssh:box', folder: '/srv', attachments: [id] }),
    'forbidden',
  );
  assert.equal(calls.length, 0);
});

for (const kind of ['send', 'start'])
  test(`completed ${kind} receipt survives paired transport replacement, while a new effect cannot borrow the old upload`, async () => {
    const { host, calls } = fakeHost();
    const r = rig({
      host: () => host,
      ops: {
        attach: async () => ({ id, kind: 'image', name: 'picked.png' }),
        attachmentsForHost: () => [file],
      },
    });
    const phone = r.phone('p1');
    ok(await phone.ask('chat.attach', { name: 'picked.png', dataUrl: 'data:image/png;base64,aGVsbG8=' }));
    const request =
      kind === 'start'
        ? { harness: 'claude', text: 'look', hostId: 'ssh:box', folder: '/srv', attachments: [id], startId: 'original-start' }
        : { chatId: 'c1', text: 'look', attachments: [id], sendId: 'original-send' };
    const before = ok(await phone.ask(`chat.${kind}`, request));
    const previous = r.service.phones.get('p1');
    r.service.phones.set('p1', { ...previous, client: { ...previous.client, follows: new Set() } });
    assert.deepEqual(ok(await phone.ask(`chat.${kind}`, request)), before);
    const next = { ...request, ...(kind === 'start' ? { startId: 'new-start' } : { sendId: 'new-send' }) };
    fail(await phone.ask(`chat.${kind}`, next), 'forbidden');
    assert.equal(
      kind === 'start' ? calls.filter((call) => call[0] === 'start').length : r.calls.filter((call) => call[0] === 'send').length,
      1,
    );
  });

test('attachments with no way to resolve them for a Host are refused; a start without attachments never asks', async () => {
  const { host, calls } = fakeHost();
  const r = rig({ host: () => host, ops: { attach: async () => ({ id, kind: 'image', name: 'picked.png' }) } });
  const phone = r.phone('p1');
  ok(await phone.ask('chat.attach', { name: 'picked.png', dataUrl: 'data:image/png;base64,aGVsbG8=' }));
  fail(
    await phone.ask('chat.start', { harness: 'claude', text: 'look', hostId: 'ssh:box', folder: '/srv', attachments: [id] }),
    'invalid',
    /Only images/,
  );
  assert.equal(calls.length, 0);
  assert.deepEqual(ok(await phone.ask('chat.start', { harness: 'claude', text: 'plain', hostId: 'ssh:box', folder: '/srv' })), {
    chatId: 'acp:host-claude:1',
  });
  assert.deepEqual(calls[0][1].attachments, []);
});
