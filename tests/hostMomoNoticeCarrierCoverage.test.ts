// The corners of the notice lane's Host code that the journey tests do not reach: races between a read and an atomic update (a matter that vanished or changed meanwhile), a reminder whose push throws or whose home moved, a draft for a notice with no decision or an address a draft may not carry, the intents' defaults and bad arguments, and the service's reads of learning when it has nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createNoticeIntents } from '../host/src/momoNoticeIntents.mjs';
import { createNoticeStore } from '../host/src/momoNoticeStore.mjs';
import { createReminders, MAX_SEND_TRIES } from '../host/src/momoNoticeReminders.mjs';
import { createFileSafeStorage } from '../host/src/secretStore.mjs';
import { mailOf, world } from './support/host/noticeHomeWorld.ts';
import { answer, mail, minutes, rig } from './support/host/momoNoticeRig.ts';

const iso = (ms: number) => new Date(ms).toISOString();
const NOW = Date.parse('2026-11-24T12:00:00Z');
const live = (over: object = {}) => ({ matterKey: 'k', state: 'open', title: 'T', reminded: 1, remindAt: iso(NOW - 1), ...over });

/** A store whose atomic update sees the records a test scripts, one per call (what the matter looked like when the update ran). */
function scripted(list: any[], seen: any[], peek: any = seen[0]) {
  const sent: any[] = [];
  return {
    sent,
    store: {
      notice: {
        getMatter: async () => peek,
        listMatters: async () => list,
        updateMatter: async (_key: string, fn: (m: any) => any) => {
          const next = fn(seen.shift());
          if (next !== undefined) sent.push(next);
          return next !== undefined;
        },
      },
    } as any,
  };
}
const sender = (status = 'sent') => ({ tell: async () => ({ status }) });
const base = (store: any, over: object = {}) => ({ store, now: () => NOW, push: () => sender(), cannotFire: () => null, ...over });

test('remind: a matter that vanished while it was being set is "no longer has that notice"; one with a reminder waiting returns that reminder’s own time', async () => {
  const vanished = scripted([], [undefined], live({ remindAt: undefined }));
  await assert.rejects(createReminders(base(vanished.store)).remind('k'), /no longer has that notice/);
  const waiting = scripted([], [live({ remindAt: iso(NOW + 5) })]);
  assert.deepEqual(await createReminders(base(waiting.store)).remind('k'), { remindAt: iso(NOW + 5) });
});

test('fire: nothing when the home moved on, a reminder taken by another pass is left, a failed push on a matter that has changed meanwhile is not put back', async () => {
  const away = scripted([live()], []);
  assert.deepEqual(await createReminders(base(away.store)).fire({ stillHome: async () => false }), { told: [], gaveUp: [] });
  const early = scripted([live()], [live({ remindAt: iso(NOW + 60_000) })]);
  assert.deepEqual(await createReminders(base(early.store)).fire({ stillHome: async () => true }), { told: [], gaveUp: [] });
  const taken = scripted([live()], [live({ remindAt: undefined })]);
  assert.deepEqual(await createReminders(base(taken.store)).fire({ stillHome: async () => true }), { told: [], gaveUp: [] });
  // the push fails, and the matter was dismissed (or is gone) when the reminder would be put back
  for (const after of [undefined, live({ state: 'dismissed', remindAt: undefined }), live({ remindAt: iso(NOW + 9) })]) {
    const racing = scripted([live()], [live(), after]);
    const out = await createReminders(base(racing.store, { push: () => sender('failed') })).fire({ stillHome: async () => true });
    assert.deepEqual([out.told, racing.sent.length], [[], 1], 'only the take-off was written');
  }
  // a reminder that already failed twice is given up the third time, said with its cause
  const last = scripted(
    [live({ remindTries: MAX_SEND_TRIES - 1 })],
    [live({ remindTries: MAX_SEND_TRIES - 1 }), live({ remindAt: undefined })],
  );
  const out = await createReminders(base(last.store, { push: () => sender('no_phone') })).fire({ stillHome: async () => true });
  assert.deepEqual(
    out.gaveUp.map((g) => [g.key, g.why]),
    [['k', 'no phone is linked']],
  );
});

test('the intents’ defaults and bad arguments: remind and draft default to nothing, a signal choice made twice stands, settings take one half of a pair at a time', async () => {
  const changes: any[] = [];
  const reactions: any[] = [{ rowId: 's', kind: 'not_needed' }];
  const store: any = { reactions: () => reactions, addReaction: async (r: any) => void reactions.push(r) };
  const intents: any = createNoticeIntents({
    store,
    home: { prefs: { change: async (c: any) => void changes.push(c) } } as any,
    signalIds: () => ['s'],
  });
  assert.deepEqual(await intents['notice.remind']({ key: 'k' }), { remindAt: '' });
  assert.equal(await intents['notice.draft']({ key: 'k' }), undefined);
  // a reaction of another kind to the same row does not count as the signal's choice
  await intents['signal.make']({ id: 's' });
  assert.equal(reactions.length, 2);
  await intents['signal.ignore']({ id: 's' });
  assert.equal(reactions.length, 2, 'the first choice stands');
  for (const patch of ['x', 5, null, undefined, []]) await assert.rejects(intents['settings.set']({ patch }), /not something MoMo can do/);
  await intents['settings.set']({ patch: { briefOn: false } });
  await intents['settings.set']({ patch: { briefTime: '07:30' } });
  assert.deepEqual(changes, [{ brief: { on: false } }, { brief: { time: '07:30' } }]);
});

test('the store lists only views that are objects', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-cov-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home: any = { storage: { dir }, data: { safeStorage: createFileSafeStorage(dir) } };
  const store = createNoticeStore({ home, now: () => NOW });
  await store.saveView('good', { text: 'x' }, NOW);
  await store.saveView('null', null, NOW - 1);
  await store.saveView('text', 'x' as any, NOW - 2);
  assert.deepEqual(
    store.views().map((v: any) => v.key),
    ['good'],
  );
});

test('a reminder whose push throws is reported; a home that moves during it ends quietly; one that moved before it is left alone', async (t) => {
  const throwing = rig(t);
  await throwing.notice.tick();
  throwing.clock.at += minutes(10);
  throwing.world.threads.t1 = mail('t1', { date: '2026-11-24T12:05:00Z' });
  throwing.answers.push(answer('tell_now'));
  await throwing.notice.tick();
  await throwing.notice.remind('gmail:t1');
  throwing.state.onTell = async () => {
    throw new Error('push down');
  };
  throwing.clock.at += 4 * 3_600_000;
  await throwing.notice.tick();
  assert.ok(throwing.reports.some((r: string) => r.includes('reminders failed: push down')));

  const moving = rig(t);
  await moving.notice.tick();
  moving.clock.at += minutes(10);
  moving.world.threads.t1 = mail('t1', { date: '2026-11-24T12:05:00Z' });
  moving.answers.push(answer('tell_now'));
  await moving.notice.tick();
  await moving.notice.remind('gmail:t1');
  moving.state.onTell = async () => void (moving.state.current = false);
  moving.clock.at += 4 * 3_600_000;
  await moving.notice.tick();
  assert.ok(!moving.reports.some((r: string) => r.includes('reminders failed')));

  const gone = rig(t);
  await gone.notice.tick();
  gone.clock.at += minutes(10);
  gone.world.threads.t1 = mail('t1', { date: '2026-11-24T12:05:00Z' });
  gone.answers.push(answer('tell_now'));
  await gone.notice.tick();
  await gone.notice.remind('gmail:t1');
  gone.clock.at += 4 * 3_600_000;
  gone.state.receive = false;
  await gone.notice.tick();
  assert.deepEqual(
    gone.told.filter((i: any) => i.kind === 'remind'),
    [],
  );
});

test('a reminder shows in Watching for an offered matter too, never for an ended one', async (t) => {
  const w = rig(t);
  const put = (key: string, state: string) =>
    w.store.notice.putMatter({
      matterKey: key,
      state,
      title: key,
      summary: 's',
      sources: [],
      remindAt: iso(w.clock.at + 1000),
      updatedAt: iso(w.clock.at),
    });
  await put('gmail:a', 'offered');
  await put('gmail:b', 'resolved');
  await put('gmail:c', 'open');
  assert.deepEqual((await w.notice.views.watching()).map((r: any) => r.title).sort(), ['gmail:a', 'gmail:c']);
});

test('a draft: for a notice that has no decision, with an owner whose status has no email, and refused for an address a draft may not carry', async (t) => {
  const w = rig(t, { status: { kind: 'connected_read_only' } });
  w.world.threads.t9 = mail('t9', { subject: 'Hello', body: 'Can you send the file?' });
  await w.store.notice.putMatter({
    matterKey: 'gmail:t9',
    state: 'open',
    title: 'Hello',
    summary: 's',
    sources: [],
    updatedAt: iso(w.clock.at),
  });
  w.answers.push(JSON.stringify({ body: 'Sure, sending it.' }));
  await w.notice.draft('gmail:t9');
  assert.equal(w.rows.length, 1);
  assert.match(w.prompts.at(-1)!, /me@example\.invalid/);

  w.world.threads.t8 = mail('t8', {
    from: 'Ana <ana@acme>',
    headers: { 'Authentication-Results': 'mx.google.com; dmarc=pass header.from=acme' },
    subject: 'Hello',
    body: 'Can you send the file?',
  });
  await w.store.notice.putMatter({
    matterKey: 'gmail:t8',
    state: 'open',
    title: 'Hello',
    summary: 's',
    sources: [],
    updatedAt: iso(w.clock.at),
  });
  w.answers.push(JSON.stringify({ body: 'Sure.' }));
  await assert.rejects(w.notice.draft('gmail:t8'), /couldn’t write a draft/);
  assert.equal(w.rows.length, 1);
});

test('through the real loader: the intents notice.remind and notice.draft reach the service, and the service’s reads of learning cope with nothing there', async (t) => {
  const w = await world(t, 'tell_now');
  const run = async (intent: object) => (w.home.intentRegistry().intents() as any)[(intent as any).kind](intent);
  w.threads.t0 = mailOf('t0', 'Hello', 'Welcome.', { date: new Date(Date.now()).toISOString() });
  w.answers.push(w.answer('quiet'));
  await w.notice().tick();
  w.threads.t1 = mailOf('t1', 'Question', 'Can you send the file?', { date: new Date(Date.now() + 2000).toISOString() });
  w.answers.push(w.answer('tell_now'));
  await w.notice().tick();
  await run({ kind: 'notice.remind', key: 'gmail:t1' });
  // this world has no MoMo chat to take the row, so the row store is a stand-in that keeps what it is given
  const written: any[] = [];
  w.home.rows.put = async (row: any) => void written.push(row);
  w.answers.push(JSON.stringify({ body: 'Sure.' }));
  await run({ kind: 'notice.draft', key: 'gmail:t1' });
  assert.deepEqual(
    written.map((r) => r.kind),
    ['draft'],
  );

  // learning has no view, a view with no signals, or is absent: no signal id is known
  const learning = w.home.service('learning');
  const realView = learning.view;
  for (const view of [undefined, () => undefined, () => ({})]) {
    learning.view = view;
    await assert.rejects(run({ kind: 'signal.make', id: 'x' }), /no longer has that notice/);
  }
  learning.view = realView;
  const service = w.home.service.bind(w.home);
  w.home.service = (id: string) => (id === 'learning' ? undefined : service(id));
  await assert.rejects(run({ kind: 'signal.make', id: 'x' }), /no longer has that notice/);
  w.home.service = service;

  // a brief view saved without offers has none to give
  await w
    .notice()
    .seams.deliver({ id: 'brief:2026-11-24', day: '2026-11-24', text: 't', built: { view: { text: 't' } }, stamp: w.home.stamp() });
  assert.equal(w.notice().offer('o1'), null);
});

test('a home that stops being the home between a due reminder and the write that puts it back ends the fire with no report and no write', async (t) => {
  const w = rig(t);
  await w.notice.tick();
  w.clock.at += minutes(10);
  w.world.threads.t1 = mail('t1', { date: '2026-11-24T12:05:00Z' });
  w.answers.push(answer('tell_now'));
  await w.notice.tick();
  await w.notice.remind('gmail:t1');
  // the push fails, so the reminder would be put back; but by then this Host is no longer the running home
  w.pushResult.status = 'failed';
  w.state.onTell = async () => void (w.state.current = false);
  w.clock.at += 4 * 3_600_000;
  w.reports.length = 0;
  await w.notice.tick();
  assert.deepEqual(w.reports, []);
  const matter = await w.store.notice.getMatter('gmail:t1');
  assert.equal(matter.remindAt, undefined, 'taken off, and not put back by a Host that is no longer the home');
  assert.equal(matter.remindTries, 0, 'the failed try was not counted either');
});
