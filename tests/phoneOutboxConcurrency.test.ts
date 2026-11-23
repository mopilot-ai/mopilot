// Outbox scheduling owns one FIFO per computer, chat and conversation kind; independent queues never wait on each other's acknowledgments.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOutbox, type QueuedSend } from '../mobile/src/outbox.ts';
import { waitFor } from './support/waitFor.ts';

function rig() {
  let n = 0;
  let rows: QueuedSend[] = [];
  const calls: { item: QueuedSend; ok(): void; fail(error: Error): void }[] = [];
  const box = createOutbox({
    online: () => true,
    ready: async () => true,
    idempotent: () => true,
    lost: () => false,
    newId: () => `send-${++n}`,
    now: () => n,
    onChange: (next) => {
      rows = next;
    },
    send: (item) => new Promise((resolve, reject) => calls.push({ item, ok: () => resolve({}), fail: reject })),
  });
  const add = (text: string, chatId = 'chat', pairId = 'pair', momo = false) => {
    const input = { text, chatId, pairId, attachments: [], ...(momo ? { momo: true as const } : {}) };
    return box.add(input);
  };
  return { box, calls, add, rows: () => rows };
}

test('a pending acknowledgment never holds another chat or computer; each chat stays FIFO', async () => {
  const r = rig();
  r.add('a1');
  r.add('a2');
  r.add('b', 'other');
  r.add('c', 'chat', 'other-pair');
  await waitFor(() => r.calls.length === 3, 'three independent sends while a1 is pending', { timeoutMs: 300 });
  assert.deepEqual(
    r.calls.map((c) => c.item.text),
    ['a1', 'b', 'c'],
  );
  r.calls[2].ok();
  r.calls[1].ok();
  await waitFor(() => r.rows().length === 2, 'reverse acknowledgments retained independently');
  assert.deepEqual(
    r.rows().map((i) => i.text),
    ['a1', 'a2'],
  );
  r.calls[0].ok();
  await waitFor(() => r.calls.length === 4, 'same-chat second send after first acknowledgment');
  assert.equal(r.calls[3].item.text, 'a2');
  r.calls[3].ok();
  await waitFor(() => !r.rows().length, 'all sends accepted');
});

for (const momo of [false, true]) {
  test(`a ${momo ? 'MoMo' : 'regular'} refusal holds only its pair, chat and kind`, async () => {
    const r = rig();
    const bad = r.add('bad', 'chat', 'pair', momo);
    await waitFor(() => r.calls.length === 1, 'first send');
    r.calls[0].fail(new Error('refused'));
    await waitFor(() => r.rows()[0].status === 'failed', 'refusal');
    r.add('held', 'chat', 'pair', momo);
    r.add('momo', 'chat', 'pair', !momo);
    r.add('other-pair', 'chat', 'else', momo);
    await waitFor(() => r.calls.length === 3, 'unrelated owners proceed', {
      timeoutMs: 300,
    });
    assert.deepEqual(
      r.calls.map((c) => c.item.text),
      ['bad', 'momo', 'other-pair'],
    );
    r.calls[1].ok();
    r.calls[2].ok();
    assert.equal(r.box.retry(bad), true);
    await waitFor(() => r.calls.length === 4, 'retry');
    assert.equal(r.calls[3].item.id, bad);
    r.calls[3].ok();
    await waitFor(() => r.calls.length === 5, 'held message resumes');
    r.calls[4].ok();
    await waitFor(() => !r.rows().length, 'queue drained');
  });
}

test('concurrent chats share capability discovery; clearing retires its pending result and allows a replacement', async () => {
  let n = 0;
  const probes: { ok(value: boolean): void; fail(error: Error): void }[] = [];
  const sent: string[] = [];
  let rows: QueuedSend[] = [];
  const box = createOutbox({
    online: () => true,
    idempotent: () => true,
    lost: () => false,
    ready: () => new Promise((resolve, reject) => probes.push({ ok: resolve, fail: reject })),
    send: async (item) => {
      sent.push(item.text);
    },
    newId: () => `s-${++n}`,
    now: () => n,
    onChange: (next) => {
      rows = next;
    },
  });
  const add = (text: string, chatId = 'a') => box.add({ text, chatId, pairId: 'p', attachments: [] });
  add('old');
  add('other', 'b');
  await waitFor(() => probes.length === 1, 'one shared discovery');
  box.clear();
  add('new');
  await waitFor(() => probes.length === 2, 'new discovery after retirement');
  probes[0].fail(new Error('obsolete failure'));
  probes[1].ok(true);
  await waitFor(() => sent.includes('new') && !rows.length, 'replacement succeeds');
  assert.deepEqual(sent, ['new']);
  add('after');
  await waitFor(() => probes.length === 3, 'later readiness remains usable');
  probes[2].ok(true);
  await waitFor(() => sent.length === 2, 'later send');
});

test('a canceled then dropped owner cannot block replacement readiness or resume after it', async () => {
  let n = 0;
  const probes: ((value: boolean) => void)[] = [];
  const sent: string[] = [];
  const box = createOutbox({
    online: () => true,
    idempotent: () => true,
    lost: () => false,
    ready: () => new Promise((resolve) => probes.push(resolve)),
    send: async (item) => {
      sent.push(item.text);
    },
    newId: () => `s-${++n}`,
    now: () => n,
    onChange: () => undefined,
  });
  const add = (text: string) => box.add({ text, chatId: 'same', pairId: 'p', attachments: [] });
  const old = add('old');
  await waitFor(() => probes.length === 1, 'old discovery');
  assert.equal(box.cancel(old), true);
  box.drop('p');
  add('new');
  await waitFor(() => probes.length === 2, 'replacement discovery');
  probes[0](true);
  assert.deepEqual(sent, []);
  probes[1](true);
  await waitFor(() => sent.length === 1, 'replacement dispatch');
  assert.deepEqual(sent, ['new']);
});

test('dropping one computer preserves another computer’s active FIFO', async () => {
  const r = rig();
  r.add('removed');
  r.add('foreign-first', 'chat', 'foreign');
  await waitFor(() => r.calls.length === 2, 'both computers in flight');
  r.box.drop('pair');
  r.add('foreign-next', 'chat', 'foreign');
  r.calls[0].ok();
  r.calls[1].ok();
  await waitFor(() => r.calls.length === 3, 'foreign FIFO resumes');
  assert.equal(r.calls[2].item.text, 'foreign-next');
  r.calls[2].ok();
  await waitFor(() => !r.rows().length, 'foreign messages accepted');
});
