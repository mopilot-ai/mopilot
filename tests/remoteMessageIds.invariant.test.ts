// Every message the Mac builds for a phone passes checkMessage: an event payload's own id, t or kind never replaces the envelope's.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { checkMessage } from '../shared/remote/envelope.mjs';

const { RemoteService } = createRequire(import.meta.url)('../electron/remote/service.cjs');

function service() {
  const sent: any[] = [];
  const svc: any = new RemoteService({ ops: {}, momoAllowed: () => true, now: () => 42 });
  svc.transport = { send: async (_pair: string, msg: unknown) => void sent.push(msg) };
  svc.phones = new Map([['a', { client: { pairId: 'p_12345678' } }]]);
  return { svc, sent };
}

test('events whose payload carries a long id, a number id, a kind or a time keep a short string envelope id', async () => {
  const { svc, sent } = service();
  for (const payload of [
    { id: 'claude:' + 'a'.repeat(80) },
    { id: 12 },
    { id: JSON.stringify(['origin', 'b'.repeat(70)]) },
    { kind: 'x', t: 'late' },
  ])
    await svc.emit('p_12345678', { ev: 'any.thing', ...payload });
  svc.onMomoActivity('claude:' + 'c'.repeat(90));
  await new Promise((r) => setImmediate(r));
  assert.equal(sent.length, 5);
  for (const m of sent) {
    assert.doesNotThrow(() => checkMessage(m));
    assert.match(m.id, /^m_[0-9a-f-]{36}$/);
    assert.equal(m.kind, 'event');
  }
  assert.equal(sent[4].itemId.length, 97);
});
