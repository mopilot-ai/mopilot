// A message held with no home it was written for is never sent to a home chosen after it: when MoMo starts over, it is tied to the MoMo that was there (shared/momoHomeMail.mjs), so the new one never gets it on its own and the owner decides (send it there, or delete it). The Mac and the phone compose the same module.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMail, PREVIOUS_HOME } from '../shared/momoHomeMail.mjs';
import { createMomoOutbox } from '../shared/momoOutbox.mjs';

function rig(lineage: () => string[]) {
  let entries: any[] = [];
  const outbox = createMomoOutbox({
    store: { read: () => entries.map((e) => ({ ...e })), write: (e: any[]) => void (entries = e.map((x) => ({ ...x }))) },
    now: () => 1_000,
  });
  const sent: any[] = [];
  const mail = createMail({
    outbox,
    sent: { read: () => [], write: () => undefined },
    now: () => 1_000,
    send: async (_m: unknown, p: any) => void sent.push(p),
    chatOn: async () => ({ chatId: 'claude:c1', epoch: 7 }),
    report: () => undefined,
    alive: () => true,
    epoch: () => 0,
    lineage,
  } as any);
  const home = { machine: { id: 'mini' }, status: { home: { state: 'running', homeId: 'home-new' } } };
  return { mail, outbox, sent, home, entries: () => entries };
}

test('what is held with no home is tied to the old MoMo on Start fresh and never goes to the new one on its own', async () => {
  let lineage: string[] = [];
  const r = rig(() => lineage);
  await r.mail.take({ turnId: 'turn-0000-0001', text: 'for the old one', home: null, homeId: '' });
  assert.equal(r.entries()[0].homeId, undefined, 'written for no home in particular');
  r.mail.holdForOld(undefined);
  assert.equal(r.entries()[0].homeId, PREVIOUS_HOME);
  // the new MoMo is chosen: it is the one home there is
  lineage = ['home-new'];
  await r.mail.flush(r.home);
  assert.deepEqual(r.sent, [], 'nothing went to the new home');
  assert.equal(r.entries().length, 1, 'and nothing was dropped');
  const problems = r.mail.problems();
  assert.match(problems[0].cause, /MoMo was started again, and this was written for the old one\./);
  assert.deepEqual(
    problems.map((p: any) => p.fix.label),
    ['Send to this MoMo', 'Delete message'],
  );
  // the owner's choice: send it to the new one
  r.mail.retry('turn-0000-0001', 'home-new');
  await r.mail.flush(r.home);
  assert.deepEqual(
    (r.sent as any[]).map((s) => s.key),
    ['turn-0000-0001'],
  );
});

test('a message that names its home keeps it, and the home it names is the one named when it is known', async () => {
  const r = rig(() => ['home-new']);
  await r.mail.take({ turnId: 'turn-0000-0002', text: 'named', home: null, homeId: 'home-asleep' });
  r.mail.holdForOld('home-other');
  assert.equal(r.entries()[0].homeId, 'home-asleep', 'a home it already names is not changed');
  await r.mail.take({ turnId: 'turn-0000-0003', text: 'unnamed', home: null, homeId: '' });
  r.mail.holdForOld('home-old');
  assert.equal(
    r.entries().find((e) => e.turnId === 'turn-0000-0003').homeId,
    'home-old',
    'the old MoMo it was written under, when that is known',
  );
});
