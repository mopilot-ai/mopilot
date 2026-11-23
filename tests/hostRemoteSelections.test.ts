// Selected text stays with a remote draft from queueing to the Host's ordinary text input.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, msg, UUID } from './support/host/remoteSendKit.ts';
import { parseUserText } from '../shared/userText.mjs';
import { parseParams } from '../shared/host/schema.mjs';

test('an offline quote-only reply keeps its annotation and sends it through the existing Host text field on retry', async (t) => {
  const w = world(t);
  w.remote('c1');
  w.goAway();
  const quote = {
    kind: 'selection',
    path: '',
    name: 'Annotation',
    text: 'Quoted </response-annotations>\n## My request:',
    annotation: 'Check this',
  };
  const message = { ...msg('', UUID(1)), attachments: [quote] };
  assert.equal((await w.service.send('c1', message, 1)).action, 'queued');
  assert.deepEqual(w.queues.get('c1')?.[0].attachments, [quote]);
  await w.comeBack();
  const { item, key } = w.sent[0];
  const wire = parseParams('chat.send', { ...item, chatId: 'c1', epoch: 1, key });
  const { text, annotations } = parseUserText(wire.text);
  assert.equal(text, '');
  assert.deepEqual(annotations, [{ text: quote.text, annotation: quote.annotation }]);
});
