// The notice lane's "Not needed" tap against a matter that has moved on (host/src/momoNoticeIntents.mjs): an older state is refused, the matter is let go atomically so two taps at once are one reaction, and the sender's domain is only taught from a tap that carried the decision it saw on mail that passed the sender check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decisionIdOf } from '../shared/momoNotice/views.ts';
import { createNoticeIntents } from '../host/src/momoNoticeIntents.mjs';

function fake(senderStatus: string | undefined = 'pass', fromDomain: string | undefined = 'acme.com') {
  const reactions: any[] = [];
  const decisions: any[] = [
    { changeId: 'gmail:a', at: 'A', matterKey: 'M', decidedBy: 'model:x', outcome: 'told', senderStatus },
    { changeId: 'gmail:b', at: 'B', matterKey: 'M', decidedBy: 'model:x', outcome: 'told', senderStatus },
  ];
  const matter: any = {
    state: 'open',
    ...(fromDomain ? { fromDomain } : {}),
    updatedAt: new Date(0).toISOString(),
    sources: [],
    title: 'T',
    remindAt: 'x',
  };
  const store: any = {
    decisions: () => decisions.map((d) => ({ ...d })),
    reactions: () => reactions,
    addReaction: async (r: any) => {
      await new Promise((r) => setImmediate(r));
      reactions.push(r);
    },
    notice: {
      updateMatter: async (_key: string, fn: (m: any) => any) => {
        const next = fn(matter.gone ? undefined : { ...matter });
        if (next === undefined) return false;
        Object.keys(matter).forEach((k) => delete matter[k]);
        Object.assign(matter, next);
        return true;
      },
    },
  };
  const intents: any = createNoticeIntents({ store, home: { prefs: { change: async () => undefined } } as any, now: () => 1000 });
  return { intents, reactions, matter, decisions };
}

test('a tap on an older state of a matter is refused and changes nothing; the latest state is let go once, with its reminder cleared', async () => {
  const w = fake();
  await assert.rejects(w.intents['row.notNeeded']({ rowId: 'gmail:a' }), /changed since you saw it/);
  assert.deepEqual([w.reactions.length, w.matter.state], [0, 'open']);
  await w.intents['row.notNeeded']({ rowId: 'gmail:b' });
  assert.deepEqual([w.reactions.length, w.matter.state, w.matter.remindAt], [1, 'dismissed', undefined]);
  await w.intents['row.notNeeded']({ rowId: 'gmail:b' });
  assert.equal(w.reactions.length, 1, 'a second device’s tap changes nothing');
});

test('two taps at once are one reaction', async () => {
  const w = fake();
  await Promise.all([w.intents['row.notNeeded']({ rowId: 'gmail:b' }), w.intents['row.notNeeded']({ rowId: 'gmail:b' })]);
  assert.equal(w.reactions.length, 1);
});

test('a matter that no longer exists records nothing', async () => {
  const w = fake();
  w.matter.gone = true;
  await w.intents['row.notNeeded']({ rowId: 'gmail:b' });
  assert.equal(w.reactions.length, 0);
});

test('a tap carries the decision id it saw: an older one is refused, the current one is let through', async () => {
  const w = fake();
  await assert.rejects(w.intents['row.notNeeded']({ rowId: 'gmail:b', decisionId: 'gmail:b@2020' }), /changed since you saw it/);
  assert.deepEqual([w.reactions.length, w.matter.state], [0, 'open']);
  await w.intents['row.notNeeded']({ rowId: 'gmail:b', decisionId: decisionIdOf(w.decisions[1]) });
  assert.equal(w.matter.state, 'dismissed');
});

test('the sender’s domain is taught only by a tap with the decision id, on mail that passed the sender check', async () => {
  const taught = async (senderStatus: string | undefined, withId: boolean) => {
    const w = fake(senderStatus);
    await w.intents['row.notNeeded']({ rowId: 'gmail:b', ...(withId ? { decisionId: decisionIdOf(w.decisions[1]) } : {}) });
    return w.reactions[0].fromDomain;
  };
  assert.equal(await taught('pass', true), 'acme.com');
  assert.equal(await taught('pass', false), null, 'a tap without the decision id teaches nothing');
  assert.equal(await taught('fail', true), null, 'a spoofed sender teaches nothing');
  assert.equal(await taught('unknown', true), null);
  assert.equal(await taught('', true), null);
});

test('signals and offers are refused while the home knows none (the defaults)', async () => {
  const w = fake();
  await assert.rejects(w.intents['signal.make']({ id: 's' }), /no longer has that notice/);
  await assert.rejects(w.intents['brief.hide']({ offerId: 'o' }), /no longer has that notice/);
});
