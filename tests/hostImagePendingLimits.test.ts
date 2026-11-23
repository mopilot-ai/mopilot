// The real Host input wrapper cleans up rejected dispatches and bounds retained image/display input while native acceptance is pending.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setup, idle } from './support/host/claudeKit.ts';

test('dispatch exceptions and failed receipts keep their original cause and release pending identity reservations', async () => {
  const h = setup();
  const key = `claude:${randomUUID()}`;
  try {
    await h.sessions.chatRuntime.send({ key, text: 'warm up', cwd: h.dir });
    await idle(h, key);
    const fault = new Error('native dispatch refused');
    (h.sessions.controller as any).send = async () => {
      throw fault;
    };
    await assert.rejects(h.sessions.chatRuntime.send({ key, text: '', clientId: 'failed-throw', cwd: h.dir }), fault);
    (h.sessions.controller as any).send = async () => ({ action: 'failed', error: 'native cause' });
    await assert.rejects(h.sessions.chatRuntime.send({ key, text: '', clientId: 'failed-receipt', cwd: h.dir }), /native cause/);
    (h.sessions.controller as any).send = async () => ({ action: 'failed' });
    await assert.rejects(h.sessions.chatRuntime.send({ key, text: '', clientId: 'failed-default', cwd: h.dir }), /could not be sent/);
    (h.sessions.controller as any).send = async (_key: string, item: any) => ({ action: 'queued', id: item.id });
    for (let i = 0; i < 1000; i++) await h.sessions.chatRuntime.send({ key, text: '', clientId: `queued-${i}`, cwd: h.dir });
    await assert.rejects(h.sessions.chatRuntime.send({ key, text: '', clientId: 'overflow', cwd: h.dir }), /Too many messages/);
    (h.sessions.controller as any).stopChat = async () => {};
    await h.sessions.chatRuntime.host.cancel(key);
    assert.equal((await h.sessions.chatRuntime.send({ key, text: '', clientId: 'after-cancel', cwd: h.dir })).action, 'queued');
  } finally {
    await h.close();
  }
});
