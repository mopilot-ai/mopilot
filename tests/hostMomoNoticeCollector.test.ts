// MoMo's notice collector on a Host (host/src/momoNotice.mjs) over a fake home, clock, Google reader and reading model: every way a pass is skipped or fails, what is kept and pushed, the brief and catch-up seams, and the views.
import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore: plain ESM without declarations
import { createMomoNotice, noticeModeOf } from '../host/src/momoNotice.mjs';
import { answer, mail, minutes, NOON, rig } from './support/host/momoNoticeRig.ts';

test('noticeModeOf: only the two known modes turn it on', () => {
  assert.deepEqual(
    [noticeModeOf('brief'), noticeModeOf('tell_now'), noticeModeOf('off'), noticeModeOf('yes'), noticeModeOf(undefined)],
    ['brief', 'tell_now', 'off', 'off', 'off'],
  );
});

test('a tick does nothing when off, away from home, paused, too soon, or while a pass runs', async (t) => {
  const off = rig(t, { mode: 'off' });
  assert.deepEqual(await off.notice.tick(), { idle: 'off' });
  const w = rig(t);
  w.state.stamp = null;
  assert.deepEqual(await w.notice.tick(), { idle: 'not-home' });
  w.state.stamp = { homeId: 'h', leaseEpoch: 1 };
  w.state.paused = true;
  assert.deepEqual(await w.notice.tick(), { idle: 'paused' });
  w.state.paused = false;
  w.world.threads.t1 = mail('t1');
  w.answers.push(answer('quiet'));
  const [first, second] = await Promise.all([w.notice.tick(), w.notice.tick()]);
  assert.deepEqual([first.did, second], [['pass'], { idle: 'busy' }]);
  assert.deepEqual(await w.notice.tick(), { idle: 'wait' });
  w.clock.at += minutes(6);
  assert.equal((await w.notice.tick()).did?.[0], 'pass');
});

test('no model, no Google, or a reading cut off by moving home read nothing and say so', async (t) => {
  const none = rig(t, { model: false });
  assert.deepEqual(await none.notice.tick(), { idle: 'no-model' });
  assert.deepEqual(none.notice.views.state().gaps, [
    {
      source: 'Reading',
      why: 'No reading model is set up on this machine yet.',
      fix: { action: 'update_host', label: 'Update MoMo on this machine' },
    },
  ]);
  const w = rig(t);
  w.world.fail.reader = true;
  assert.deepEqual(await w.notice.tick(), { idle: 'no-google' });
  assert.equal(w.notice.views.state().gaps[0].source, 'Google');
  const moved = rig(t);
  moved.world.threads.t1 = mail('t1');
  moved.state.current = false;
  assert.deepEqual(await moved.notice.tick(), { idle: 'not-home' });
  assert.deepEqual(moved.store.decisions(), []);
  // the lease is checked with the stamp the Host last saw as well
  const stale = rig(t);
  stale.state.receive = false;
  assert.deepEqual(await stale.notice.tick(), { idle: 'not-home' });
});

test('a pass that cannot finish is reported and tried again; Gmail or Calendar down is listed, not fatal', async (t) => {
  const w = rig(t);
  w.world.fail.gmail = true;
  w.world.fail.calendar = true;
  const out = await w.notice.tick();
  assert.equal(out.did?.[0], 'pass');
  assert.deepEqual(
    w.notice.views.state().gaps.map((g: any) => g.source),
    ['Gmail', 'Calendar'],
  );
  const broken = rig(t);
  (broken.store as any).connectDay = async () => {
    throw new Error('disk gone');
  };
  assert.deepEqual(await broken.notice.tick(), { idle: 'failed' });
  assert.match(broken.reports[0], /notice pass failed: .*disk gone/);
  assert.equal(broken.notice.views.state().gaps[0].source, 'Notices');
});

test('the first pass is the first connect and pushes nothing; later tell-nows are pushed once, held ones count as told, a refused push does not', async (t) => {
  const w = rig(t);
  w.world.threads.t1 = mail('t1');
  w.answers.push(answer('tell_now', 'Confirm today.'));
  const first = await w.notice.tick();
  assert.deepEqual([first.decisions, first.told], [1, []]);
  assert.deepEqual(w.told, []);
  assert.equal(w.store.lastRunAt(), NOON);
  w.clock.at += minutes(10);
  w.world.threads.t2 = mail('t2', { date: '2026-11-24T12:05:00Z' });
  w.world.threads.t3 = mail('t3', { date: '2026-11-24T12:06:00Z' });
  w.world.threads.t4 = mail('t4', { date: '2026-11-24T12:07:00Z' });
  w.answers.push(answer('tell_now'), answer('tell_now'), answer('track'));
  const second = await w.notice.tick();
  assert.deepEqual(second.told, ['gmail:t2', 'gmail:t3']);
  assert.deepEqual(
    w.told.map((i: any) => i.kind),
    ['reply', 'reply'],
  );
  w.pushResult.status = 'held';
  w.clock.at += minutes(10);
  w.world.threads.t5 = mail('t5', { date: '2026-11-24T12:25:00Z' });
  w.answers.push(answer('tell_now'));
  assert.deepEqual((await w.notice.tick()).told, ['gmail:t5']);
  w.pushResult.status = 'failed';
  w.clock.at += minutes(10);
  w.world.threads.t6 = mail('t6', { date: '2026-11-24T12:35:00Z' });
  w.answers.push(answer('tell_now'));
  assert.deepEqual((await w.notice.tick()).told, []);
});

test('brief mode keeps the matter but pushes nothing; no push yet pushes nothing; a lease lost mid-pass stops the pushes', async (t) => {
  const brief = rig(t, { mode: 'brief' });
  await brief.notice.tick();
  brief.clock.at += minutes(10);
  brief.world.threads.t1 = mail('t1', { date: '2026-11-24T12:05:00Z' });
  brief.answers.push(answer('tell_now'));
  assert.deepEqual((await brief.notice.tick()).told, []);
  assert.deepEqual(brief.told, []);
  assert.equal((await brief.store.notice.getMatter('gmail:t1'))?.state, 'open');
  const noPush = rig(t, { push: 'none' });
  await noPush.notice.tick();
  noPush.clock.at += minutes(10);
  noPush.world.threads.t1 = mail('t1', { date: '2026-11-24T12:05:00Z' });
  noPush.answers.push(answer('tell_now'));
  assert.deepEqual((await noPush.notice.tick()).told, []);
  const lost = rig(t);
  await lost.notice.tick();
  lost.clock.at += minutes(10);
  lost.world.threads.t1 = mail('t1', { date: '2026-11-24T12:05:00Z' });
  lost.answers.push(answer('tell_now'));
  // the lease goes after the pass's last write, before the push
  const settle = lost.store.setBackoff;
  lost.store.setBackoff = async (b: any) => {
    await settle(b);
    lost.state.current = false;
  };
  assert.deepEqual((await lost.notice.tick()).told, []);
  assert.deepEqual(lost.told, []);
});

test('calendar events are read: a cancelled one is not, a live one is a matter, and the calendar is marked synced only when every event was decided', async (t) => {
  const w = rig(t);
  w.world.events = [
    {
      id: 'e1',
      summary: 'Dentist',
      status: 'confirmed',
      start: { dateTime: '2026-11-24T15:00:00Z' },
      end: { dateTime: '2026-11-24T16:00:00Z' },
    },
    {
      id: 'e2',
      summary: 'Gone',
      status: 'cancelled',
      start: { dateTime: '2026-11-24T17:00:00Z' },
      end: { dateTime: '2026-11-24T18:00:00Z' },
    },
  ];
  w.answers.push(answer('track', 'Dentist later.'));
  const out = await w.notice.tick();
  assert.equal(out.decisions, 1);
  assert.ok(await w.versions.get('calendar:token'));
  const unsorted = rig(t);
  unsorted.world.events = [
    { id: 'e1', summary: 'Dentist', start: { dateTime: '2026-11-24T15:00:00Z' }, end: { dateTime: '2026-11-24T16:00:00Z' } },
  ];
  unsorted.answers.push('not json');
  await unsorted.notice.tick();
  assert.equal(await unsorted.versions.get('calendar:token'), undefined);
  assert.equal(unsorted.store.unsorted().length, 1);
});

test('mail the user sent teaches the sender check who they write to; a thread that is gone is skipped; a status with no email still reads', async (t) => {
  const w = rig(t, { status: { kind: 'not_connected' } });
  w.world.threads.t1 = mail('t1', { labels: ['SENT'], to: ['Bob <bob@partner.test>'], cc: ['carol@other.test', ''] });
  w.world.threads.gone = mail('gone', { date: '2026-11-24T11:30:00Z' });
  w.world.hide.add('gone');
  await w.notice.tick();
  assert.deepEqual(w.store.knownDomains(), ['partner.test', 'other.test']);
  // the thread that vanished between the list and the read made no decision and is not read again
  assert.deepEqual(
    w.store.decisions().map((d: any) => d.changeId),
    ['gmail:t1'],
  );
  assert.ok(await w.versions.get('gmail:gone'));
});

test('the decision log carries the matter title and whether it was the first of the matter', async (t) => {
  const w = rig(t);
  w.world.threads.t1 = mail('t1', { subject: 'Contract' });
  w.answers.push(answer('track', 'Waiting.'));
  await w.notice.tick();
  const [d] = w.store.decisions();
  assert.deepEqual([d.title, d.first, d.decision], ['Contract', true, 'track']);
  const quiet = rig(t);
  quiet.world.threads.t1 = mail('t1', { labels: ['INBOX', 'CATEGORY_PROMOTIONS'] });
  await quiet.notice.tick();
  assert.deepEqual([quiet.store.decisions()[0].title, quiet.store.decisions()[0].first], ['gmail:t1', true]);
});

test('the brief seam: matters, today from the calendar, what could not be sorted, counts from the log, and a quiet day gives the claim back', async (t) => {
  const w = rig(t);
  w.world.threads.t1 = mail('t1', { subject: 'Contract' });
  w.world.threads.t2 = mail('t2', { labels: ['INBOX', 'CATEGORY_PROMOTIONS'] });
  w.world.events = [
    { id: 'e1', summary: 'Standup', start: { dateTime: '2026-11-24T14:00:00Z' }, end: { dateTime: '2026-11-24T14:30:00Z' } },
  ];
  w.answers.push(answer('tell_now', 'Sign it.'), answer('quiet'));
  await w.notice.tick();
  assert.equal(await w.notice.seams.claimBrief({ day: '2026-11-24' }), true);
  const built: any = await w.notice.seams.build({
    day: '2026-11-24',
    since: NOON - 1000,
    until: NOON + minutes(60),
    zone: 'UTC',
    stamp: w.state.stamp,
  });
  assert.match(built.text, /Needs you:\n- Contract: Sign it\./);
  assert.match(built.text, /Today:\n- 14:00 Standup/);
  // the calendar event was read by the model too
  assert.deepEqual(built.brief.checked, { mail: 2, byRules: 1, byModel: 2 });
  assert.deepEqual(
    built.view.leftOut.map((l: any) => l.id),
    ['gmail:t2'],
  );
  // a calendar that cannot be read is listed, the brief still comes
  w.world.fail.calendar = true;
  const gap: any = await w.notice.seams.build({
    day: '2026-11-24',
    since: NOON - 1000,
    until: NOON + minutes(60),
    zone: 'UTC',
    stamp: w.state.stamp,
  });
  assert.match(gap.text, /Could not check Calendar: Calendar is down/);
  // a day with nothing to say: no brief, and the claim is released
  const empty = rig(t);
  assert.equal(await empty.notice.seams.claimBrief({ day: '2026-11-24' }), true);
  assert.equal(
    await empty.notice.seams.build({ day: '2026-11-24', since: NOON - 1000, until: NOON, zone: 'UTC', stamp: empty.state.stamp }),
    null,
  );
  assert.equal(await empty.notice.seams.claimBrief({ day: '2026-11-24' }), true);
});

test('delivering a brief keeps its card, marks what it carried as told, pushes, and a push that cannot go yet is retried by the day', async (t) => {
  const w = rig(t);
  w.world.threads.t1 = mail('t1', { subject: 'Contract' });
  w.answers.push(answer('track'));
  await w.notice.tick();
  await w.store.notice.putMatter({
    matterKey: 'gmail:t1',
    state: 'open',
    title: 'Contract',
    summary: 'Sign.',
    sources: [],
    updatedAt: 'x',
    pendingDelivery: 'daily_cap',
  });
  const built: any = await w.notice.seams.build({ day: '2026-11-24', since: 0, until: NOON, zone: 'UTC', stamp: w.state.stamp });
  await w.notice.seams.deliver({ id: 'brief:2026-11-24', day: '2026-11-24', text: built.text, built, stamp: w.state.stamp });
  assert.equal(w.told.at(-1).kind, 'brief');
  assert.deepEqual(
    w.notice.views.cards().map((c: any) => c.key),
    ['brief:2026-11-24'],
  );
  assert.equal((await w.store.notice.getMatter('gmail:t1'))?.pendingDelivery, undefined);
  assert.equal(w.store.lastBriefAt(), NOON);
  w.pushResult.status = 'failed';
  await assert.rejects(
    w.notice.seams.deliver({ id: 'brief:2026-11-25', day: '2026-11-25', text: 'x', built: null, stamp: w.state.stamp }),
    /could not be pushed/,
  );
  const bare = rig(t, { push: 'none' });
  await bare.notice.seams.deliver({ id: 'brief:2026-11-24', day: '2026-11-24', text: 'x', built: {}, stamp: bare.state.stamp });
  assert.deepEqual(bare.notice.views.cards(), []);
});

test('the catch-up seam: one card for what was held while the home slept, a push only in tell-now mode, nothing when nothing was held', async (t) => {
  const w = rig(t);
  await w.notice.tick();
  w.clock.at += 3 * 3_600_000;
  w.world.threads.t1 = mail('t1', { subject: 'Contract', date: '2026-11-24T14:55:00Z' });
  w.answers.push(answer('tell_now'));
  await w.notice.tick();
  assert.equal(w.store.decisions().at(-1).outcome, 'catch_up');
  assert.deepEqual(w.told, []);
  await w.notice.seams.catchUp({ id: 'catchup:1', from: NOON, to: w.clock.at, stamp: w.state.stamp });
  assert.deepEqual(
    w.told.map((i: any) => [i.kind, i.key]),
    [['catchUp', 'catchup:1']],
  );
  const card = w.notice.views.cards()[0];
  assert.deepEqual(
    [card.key, card.view.machine, card.view.read, card.view.needsYou],
    [`catchup:${NOON}`, { machineId: 'm1', name: 'Studio' }, 1, [{ id: 'gmail:t1', text: 'Contract' }]],
  );
  await w.notice.seams.catchUp({ id: 'catchup:2', from: 0, to: 1, stamp: w.state.stamp });
  assert.equal(w.notice.views.cards().length, 1);
  const brief = rig(t, { mode: 'brief' });
  await brief.notice.tick();
  brief.clock.at += 3 * 3_600_000;
  brief.world.threads.t1 = mail('t1', { date: '2026-11-24T14:55:00Z' });
  brief.answers.push(answer('tell_now'));
  await brief.notice.tick();
  await brief.notice.seams.catchUp({ id: 'catchup:1', from: NOON, to: brief.clock.at, stamp: brief.state.stamp });
  assert.deepEqual(brief.told, []);
  assert.equal(brief.notice.views.cards().length, 1);
});

test('the views: decisions by id, matter or newest, the Watching rows, and the actions on a matter', async (t) => {
  const w = rig(t);
  w.world.threads.t1 = mail('t1', { subject: 'Contract' });
  w.world.threads.t2 = mail('t2', { subject: 'Visa' });
  w.answers.push(answer('track', 'Waiting on legal.'), answer('quiet'));
  await w.notice.tick();
  assert.equal(w.notice.views.decisions().length, 2);
  assert.deepEqual(
    w.notice.views.decisions({ ids: ['gmail:t2'] }).map((d: any) => d.id),
    ['gmail:t2'],
  );
  assert.deepEqual(
    w.notice.views.decisions({ matterKey: 'gmail:t1' }).map((d: any) => d.id),
    ['gmail:t1'],
  );
  assert.equal(w.notice.views.decisions({ limit: 1 }).length, 1);
  const watching: any[] = await w.notice.views.watching();
  assert.deepEqual([watching.length, watching[0].title, watching[0].watch.decision.id], [1, 'Contract', 'gmail:t1']);
  const bare = rig(t);
  await bare.store.notice.putMatter({
    matterKey: 'gmail:z',
    state: 'watching',
    title: 'Z',
    summary: 's',
    sources: [],
    updatedAt: '2026-11-24T10:00:00.000Z',
  });
  assert.equal(((await bare.notice.views.watching()) as any[])[0].watch.decision, null);
  assert.equal(await w.notice.actions.snooze('gmail:t1', NOON + 3_600_000), true);
  assert.equal((await w.store.notice.getMatter('gmail:t1'))?.snoozedUntil, new Date(NOON + 3_600_000).toISOString());
  assert.equal(await w.notice.actions.dismiss('gmail:t1'), true);
  assert.equal(await w.notice.actions.dismiss('gmail:none'), false);
  assert.deepEqual(w.notice.views.state().mode, 'tell_now');
});

test('a collector made with only what it needs uses the clock, the report and the push defaults', async (t) => {
  const w = rig(t);
  const bare = createMomoNotice({
    home: w.home,
    store: w.store,
    reader: async () => ({ client: {}, versions: w.versions }),
    google: async () => ({ kind: 'not_connected' }),
    model: () => null,
    mode: () => 'tell_now',
    machine: () => ({ machineId: 'm', name: 'M' }),
    report: () => undefined,
  });
  assert.deepEqual(await bare.tick(), { idle: 'no-model' });
  assert.equal(await bare.seams.deliver({ id: 'x', day: 'd', text: 't', built: null, stamp: null }), undefined);
  assert.deepEqual(bare.views.state().lastPass?.did, []);
  await bare.seams.catchUp({ id: 'c', from: 0, to: 1, stamp: null });
});
