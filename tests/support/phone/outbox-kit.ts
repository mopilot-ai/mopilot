// Gives a hand-built phone runtime the real outbox: send, cancelSend and retrySend work as in the app, and snapshot().outbox shows the queue.
import { createHash } from 'node:crypto';
import { createMessageIdentity } from '../../../mobile/src/remote/messageIdentity.ts';
import { createOutbox, sendParams } from '../../../mobile/src/outbox.ts';

export function withOutbox(runtime: any, o: { notify?: () => void; online?: () => boolean; lost?: (error: unknown) => boolean } = {}) {
  if (!runtime.messageIdentity) {
    const identity = createMessageIdentity(
      (bytes) => createHash('sha256').update(bytes).digest(),
      () => runtime.snapshot().selectedPair ?? null,
    );
    const request = runtime.request;
    runtime.request = async (method: string, params: any) => {
      const owner = runtime.snapshot();
      const reply = await request(method, params);
      if (method === 'machine.hello' && owner.selectedPair)
        identity.observe(
          owner.selectedPair,
          Promise.resolve(reply),
          () => owner.generation === runtime.snapshot().generation && owner.selectedPair === runtime.snapshot().selectedPair,
        );
      return reply;
    };
    runtime.messageIdentity = identity.id;
  }
  let n = 0;
  let items: any[] = [];
  const base = runtime.snapshot;
  const box = createOutbox({
    online: o.online ?? (() => true),
    send: (item) => runtime.request('chat.send', { ...sendParams(item), sendId: item.id, deadline: 1 }),
    lost: o.lost ?? (() => false),
    idempotent: () => true,
    ready: async () => true,
    newId: () => `send-${++n}-test`,
    identity: (item, id) => runtime.messageIdentity('chat.send', item.chatId, id),
    now: () => 1,
    onChange: (next) => {
      items = next;
      o.notify?.();
    },
  });
  // a test that sets the outbox in its own snapshot keeps it
  runtime.snapshot = () => ({ outbox: items, ...base() });
  runtime.send = (chatId: string, text: string, attachments: string[] = [], skills: string[] = [], momo?: true, pictures: string[] = []) =>
    box.add({ pairId: 'p', chatId, text, attachments, ...(skills.length ? { skills } : {}), ...(momo ? { momo } : {}) }, pictures);
  runtime.cancelSend = (id: string) => box.cancel(id);
  runtime.editSend = (id: string, text: string) => box.edit(id, text);
  runtime.retrySend = (id: string) => box.retry(id);
  return box;
}
