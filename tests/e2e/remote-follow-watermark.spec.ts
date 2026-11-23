// Checks the real main-process follow boundary while a buffered delta is included in a delayed snapshot.
import path from 'node:path';
import { test, expect } from './fixtures/app';

test('a follow snapshot identifies the buffered live text it already contains', async ({ harness }) => {
  const entry = path.resolve(__dirname, '../../electron/remote/service.cjs');
  const result = await harness.app.evaluate(async (_electron, serviceEntry) => {
    const require = process.getBuiltinModule('module').createRequire(serviceEntry);
    const { RemoteService } = require(serviceEntry);
    const { SessionStore } = require('../session/state.cjs');
    const { openPhoneItems } = require('../app/chromePanelPhones.cjs');
    const { createMemoryLink } = require('../../shared/remote/transport.mjs');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ops: any = {
      state: new SessionStore({ publish: () => {} }),
      reachable: () => true,
      cardsOf: async () => {
        await gate;
        return [];
      },
    };
    const service = new RemoteService({ ops });
    const link = createMemoryLink();
    link.addPair('phone');
    service.attach(link.mac);
    const items = openPhoneItems({
      service: () => service,
      chatOf: () => 'chat',
      rows: async () => [
        { role: 'user', text: 'Earlier question' },
        { role: 'assistant', text: 'Earlier answer' },
      ],
    });
    ops.items = items.items;
    const phone = link.phone('phone');
    const inbox: any[] = [];
    phone.onMessage((m) => inbox.push(m));
    const push = (method: string, params: object) => items.live('codex', { method, params: { threadId: 'native', ...params } });
    push('item/started', { item: { id: 'reply', type: 'agentMessage', text: '' } });
    push('item/agentMessage/delta', { itemId: 'reply', delta: 'first' });
    push('item/agentMessage/delta', { itemId: 'reply', delta: ' buffered' });
    await phone.send({ id: 'follow', t: 1, kind: 'request', method: 'chat.follow', params: { chatId: 'chat' } });
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
    const beforeReply = inbox.filter((m) => m.ev === 'items.delta');
    release();
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
    const snapshot = inbox.find((m) => m.inReplyTo === 'follow')?.result;
    push('item/agentMessage/delta', { itemId: 'reply', delta: ' later' });
    await items.items('chat', 10);
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
    const after = inbox.filter((m) => m.ev === 'items.delta' && m.feedSeq > snapshot.feedSeq);
    service.detach();
    return {
      beforeReply: beforeReply.length,
      included: beforeReply.every((m) => m.feedSeq <= snapshot.feedSeq),
      text: snapshot.items[0].text,
      history: snapshot.history,
      later: after.map((m) => m.text).join(''),
      cursor: snapshot.feedSeq,
    };
  }, entry);
  expect(result).toMatchObject({
    beforeReply: 1,
    included: true,
    text: 'first buffered',
    later: ' later',
    history: [
      { role: 'user', text: 'Earlier question' },
      { role: 'assistant', text: 'Earlier answer' },
    ],
  });
  expect(result.cursor).toBeGreaterThan(0);
});
