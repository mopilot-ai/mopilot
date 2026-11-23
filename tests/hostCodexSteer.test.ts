// A message sent with followUp steer while a Codex turn runs on the Host (host/src/sessions.mjs, #4916): `turn/steer` into the running turn, where one without it waits behind it, as on This Mac.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { base, open, until } from './support/hostCodexKit.ts';

test('a message with followUp steer goes into the running Codex turn; without it, it queues', async () => {
  const h = await open(fs.mkdtempSync(path.join(base, 'st-')));
  try {
    const chatId = 'chat-steer';
    await h.call('chat.subscribe', chatId);
    const cwd = fs.realpathSync(fs.mkdtempSync(path.join(base, 'cwd-')));
    await h.call('chat.start', chatId, { harness: 'codex', text: 'first', cwd });
    await until(() => h.sessions.state.snapshot(chatId).turn === 'idle' && h.frames.some((m) => m.frame?.item?.t === 'assistant'));
    await h.call('chat.send', chatId, { text: 'slow please' });
    await until(() => h.sessions.state.snapshot(chatId).turn === 'running');
    const into: any = await h.call('chat.send', chatId, { text: 'and this too', followUp: 'steer' });
    assert.equal(into.result.action, 'steered');
    await until(() => h.requests().some((r) => r.method === 'turn/steer'));
    assert.equal(h.sessions.state.snapshot(chatId).queue.length, 0, 'not queued behind the turn');
    // the stream tells the message in the turn it went into
    await until(() => h.frames.some((m) => m.frame?.item?.event?.kind === 'steered'));
    const told = h.frames.find((m) => m.frame?.item?.event?.kind === 'steered')!.frame.item.event;
    assert.equal(told.user.content[0].text, 'and this too');
    assert.equal(told.user.messageKey, told.user.clientId);
    const plain: any = await h.call('chat.send', chatId, { text: 'later' });
    assert.equal(plain.result.action, 'queued');
    await h.call('chat.stop', chatId);
    await until(() => h.sessions.state.snapshot(chatId).turn === 'idle');
  } finally {
    h.close();
  }
});
