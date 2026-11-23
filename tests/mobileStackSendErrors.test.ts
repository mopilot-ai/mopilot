// The phone preserves the real ledger's uncertainty code across its encrypted relay and never calls an admitted send "not sent".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRelay, startMac, startPhone, until } from './support/mobileStack';
import { isUnconfirmed } from '../mobile/src/outbox';

test('a real ledger admission failure reaches the phone as typed uncertainty and stops generic retry', async () => {
  const relay = await startRelay();
  let admitted = 0;
  const mac = await startMac(relay, {
    ops: {
      send: async (_params: unknown, check: (() => void) | undefined, admit: (() => void) | undefined) => {
        check?.();
        admit?.();
        admitted++;
        throw new Error('native admission answer lost');
      },
    },
  });
  const phone = await startPhone(relay);
  await phone.pair(await mac.qr());
  await until(() => phone.snap().pairs.length === 1 && phone.snap().safetyNumber === null, 'pair committed');
  await phone.runtime.connect(phone.snap().pairs[0].pairId);
  mac.known.add('c1');
  const error = await phone
    .ask('chat.send', { chatId: 'c1', text: 'first', attachments: [], sendId: 'typed-error-first' })
    .catch((e: any) => e);
  assert.equal(error.code, 'send_uncertain', error.message);
  const id = phone.runtime.send('c1', 'second');
  await until(() => phone.snap().outbox.some((item: any) => item.id === id && item.status === 'failed'), 'uncertain send retained');
  const item = phone.snap().outbox.find((item: any) => item.id === id)!;
  assert.equal((item as any).errorCode, 'send_uncertain', JSON.stringify(item));
  assert.equal(isUnconfirmed(item), true);
  assert.equal(item.final, true);
  assert.equal(phone.runtime.retrySend(id), false, 'generic Retry must not repeat an uncertain admission');
  assert.equal(admitted, 2);
});
