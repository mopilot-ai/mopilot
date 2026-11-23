// "Remind me later" on the notice lane (host/src/momoNoticeReminders.mjs): set only when it can fire, kept when new mail arrives, told once as its own push kind, atomic against a Dismiss during the push, bounded to three, tried a few times and then given up with its cause.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_REMINDERS, MAX_SEND_TRIES, REMIND_AFTER_MS } from '../host/src/momoNoticeReminders.mjs';
import { answer, mail, minutes, rig } from './support/host/momoNoticeRig.ts';

async function told(t: any, o: any = {}) {
  const w = rig(t, o);
  await w.notice.tick();
  w.clock.at += minutes(10);
  w.world.threads.t1 = mail('t1', { date: '2026-11-24T12:05:00Z' });
  w.answers.push(answer('tell_now'));
  await w.notice.tick();
  w.told.length = 0;
  return w;
}
const due = (w: any) => (w.clock.at += REMIND_AFTER_MS + minutes(6));
const matter = (w: any) => w.store.notice.getMatter('gmail:t1');

test('a reminder is set once, shown with when it fires, told once when due as its own push kind, and counted', async (t) => {
  const w = await told(t);
  const first = await w.notice.remind('gmail:t1');
  assert.equal(first.remindAt, new Date(w.clock.at + REMIND_AFTER_MS).toISOString());
  assert.deepEqual(await w.notice.remind('gmail:t1'), first, 'a second tap changes nothing');
  const [row] = await w.notice.views.watching();
  assert.equal(row.nextCheck, Date.parse(first.remindAt));
  w.clock.at += REMIND_AFTER_MS - minutes(10);
  await w.notice.tick();
  assert.deepEqual(w.told, [], 'not yet');
  w.clock.at += minutes(10);
  await w.notice.tick();
  assert.deepEqual(
    w.told.map((i: any) => [i.kind, i.key, i.text]),
    [['remind', 'remind:gmail:t1:1', 'Subject t1']],
  );
  w.clock.at += minutes(10);
  await w.notice.tick();
  assert.equal(w.told.length, 1, 'told once');
  assert.equal((await matter(w)).remindAt, undefined);
});

test('new mail on the thread keeps the reminder and the count; the push key does not repeat', async (t) => {
  const w = await told(t);
  await w.notice.remind('gmail:t1');
  w.clock.at += minutes(30);
  w.world.threads.t1 = mail('t1', { date: '2026-11-24T12:40:00Z', body: 'Any news?' });
  w.world.threads.t1.id = 'm-t1-2';
  w.answers.push(answer('tell_now'));
  await w.notice.tick();
  const kept = await matter(w);
  assert.deepEqual([kept.reminded, typeof kept.remindAt], [1, 'string']);
  due(w);
  await w.notice.tick();
  assert.deepEqual(
    w.told.filter((i: any) => i.kind === 'remind').map((i: any) => i.key),
    ['remind:gmail:t1:1'],
  );
  await w.notice.remind('gmail:t1');
  assert.equal((await matter(w)).reminded, 2, 'the count went on, not back to one');
});

test('a notice can be reminded about three times, then no more; an unknown or ended one is refused', async (t) => {
  const w = await told(t);
  for (let i = 0; i < MAX_REMINDERS; i++) {
    await w.notice.remind('gmail:t1');
    due(w);
    await w.notice.tick();
  }
  assert.deepEqual(
    w.told.filter((i: any) => i.kind === 'remind').map((i: any) => i.key),
    ['remind:gmail:t1:1', 'remind:gmail:t1:2', 'remind:gmail:t1:3'],
  );
  await assert.rejects(w.notice.remind('gmail:t1'), /three times/);
  await assert.rejects(w.notice.remind('gmail:nope'), /no longer has that notice/);
  await assert.rejects(w.notice.remind(''), /no longer has that notice/);
  await assert.rejects(w.notice.remind(7), /no longer has that notice/);
});

test('no reminder is set that could not fire: brief mode and no push say why', async (t) => {
  const brief = await told(t, { mode: 'brief' });
  await assert.rejects(brief.notice.remind('gmail:t1'), /not set to tell you now/);
  const nopush = await told(t, { push: 'none' });
  await assert.rejects(nopush.notice.remind('gmail:t1'), /no phone push is set up/);
  assert.equal((await matter(nopush)).remindAt, undefined);
});

test('a Dismiss during the push is not overwritten; a snoozed matter waits; an ended one is dropped without a push', async (t) => {
  const w = await told(t);
  await w.notice.remind('gmail:t1');
  w.state.onTell = async () => {
    const current = await matter(w);
    await w.store.notice.putMatter({ ...current, state: 'dismissed' });
  };
  due(w);
  await w.notice.tick();
  assert.equal((await matter(w)).state, 'dismissed', 'the Dismiss made during the push stands');

  const snoozed = await told(t);
  await snoozed.notice.remind('gmail:t1');
  const m = await matter(snoozed);
  await snoozed.store.notice.putMatter({ ...m, snoozedUntil: new Date(snoozed.clock.at + 5 * REMIND_AFTER_MS).toISOString() });
  due(snoozed);
  await snoozed.notice.tick();
  assert.deepEqual(snoozed.told, []);
  assert.notEqual((await matter(snoozed)).remindAt, undefined, 'it is told when the snooze ends');

  const ended = await told(t);
  await ended.notice.remind('gmail:t1');
  await ended.store.notice.putMatter({ ...(await matter(ended)), state: 'resolved' });
  due(ended);
  await ended.notice.tick();
  assert.deepEqual(ended.told, []);
  assert.equal((await matter(ended)).remindAt, undefined);
});

test('a push that does not go out is tried a few times, then given up with its cause; a held one counts as told', async (t) => {
  const w = await told(t);
  await w.notice.remind('gmail:t1');
  w.pushResult.status = 'failed';
  due(w);
  for (let i = 0; i < MAX_SEND_TRIES; i++) {
    assert.notEqual((await matter(w)).remindAt, undefined, `try ${i + 1}`);
    await w.notice.tick();
    w.clock.at += minutes(6);
  }
  assert.equal((await matter(w)).remindAt, undefined, 'given up');
  assert.deepEqual(
    w.notice.views.state().gaps.map((g: any) => g.source),
    ['Reminders'],
  );
  assert.match(w.notice.views.state().gaps[0].why, /could not be sent: the push did not go out/);
  w.clock.at += 25 * 3_600_000;
  assert.deepEqual(w.notice.views.state().gaps, [], 'the gap fades after a day');

  const held = await told(t);
  await held.notice.remind('gmail:t1');
  held.pushResult.status = 'held';
  due(held);
  await held.notice.tick();
  assert.equal((await matter(held)).remindAt, undefined);
  for (const status of ['duplicate', 'off', 'no_phone', 'not-home']) {
    const x = await told(t);
    await x.notice.remind('gmail:t1');
    x.pushResult.status = status;
    due(x);
    for (let i = 0; i < MAX_SEND_TRIES; i++) {
      await x.notice.tick();
      x.clock.at += minutes(6);
    }
    assert.equal(x.notice.views.state().gaps.length, 1, status);
  }
});

test('a reminder that falls due while the pass is waiting is still told', async (t) => {
  const w = await told(t);
  await w.notice.remind('gmail:t1');
  w.clock.at += REMIND_AFTER_MS - minutes(1);
  await w.notice.tick();
  w.clock.at += minutes(2);
  assert.deepEqual(await w.notice.tick(), { idle: 'wait' });
  assert.deepEqual(
    w.told.map((i: any) => i.kind),
    ['remind'],
  );
});
