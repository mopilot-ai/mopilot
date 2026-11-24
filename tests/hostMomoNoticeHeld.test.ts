// What a quiet rule held for the brief is seen somewhere: shown once and then not listed as needing the owner again, and moved to Watching when the brief is off or has not been shown for days (host/src/momoNoticeHeld.mjs, shared/momoNotice/brief.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHeldSweep, HELD_MAX_MS } from '../host/src/momoNoticeHeld.mjs';
import { mailOf, world } from './support/host/noticeHomeWorld.ts';

const NOW = Date.parse('2026-11-24T12:00:00Z');
const held = (over: object = {}) => ({
  matterKey: 'k',
  state: 'open',
  pendingDelivery: 'quiet_rule',
  updatedAt: new Date(NOW - 1000).toISOString(),
  ...over,
});
function store(list: any[], current: any = list[0]) {
  const wrote: any[] = [];
  return {
    wrote,
    store: {
      notice: {
        listMatters: async () => list,
        updateMatter: async (_k: string, fn: (m: any) => any) => {
          const next = fn(current);
          if (next !== undefined) wrote.push(next);
          return next !== undefined;
        },
      },
    } as any,
  };
}
const sweep = (s: any, briefOn: boolean) =>
  createHeldSweep({ store: s, now: () => NOW, briefOn: () => briefOn, recheckMs: () => 5000 }).sweep();

test('the sweep moves a held matter to Watching when the brief is off or it waited too long, and leaves the rest', async () => {
  const off = store([held()]);
  assert.deepEqual(await sweep(off.store, false), ['k']);
  assert.deepEqual(
    [off.wrote[0].state, off.wrote[0].pendingDelivery, off.wrote[0].nextCheck],
    ['watching', undefined, new Date(NOW + 5000).toISOString()],
  );
  const stale = store([held({ updatedAt: new Date(NOW - HELD_MAX_MS - 1).toISOString() })]);
  assert.deepEqual(await sweep(stale.store, true), ['k']);
  const fresh = store([held(), held({ matterKey: 'other', state: 'watching' }), held({ matterKey: 'n', pendingDelivery: undefined })]);
  assert.deepEqual(await sweep(fresh.store, true), []);
  // the matter changed while the sweep ran: it is left as it is
  for (const now of [null, held({ state: 'dismissed' }), held({ pendingDelivery: undefined })]) {
    const racing = store([held()], now);
    assert.deepEqual(await sweep(racing.store, false), []);
  }
});

test('through the real services: a rule-held mail is shown in one brief and is not listed as needing you in the next; one held while the brief was on moves to Watching when it is turned off', async (t) => {
  const w = await world(t, 'tell_now');
  const learning = w.home.service('learning');
  const run = async (intent: object) => (w.home.intentRegistry().intents() as any)[(intent as any).kind](intent);
  const at = (n: number) => new Date(Date.now() + n * 1000).toISOString();
  w.threads.s0 = mailOf('s0', 'Re: hello', 'Thanks.', { date: at(0), from: 'Maya <maya@x.com>', to: ['ana@acme.com'], labels: ['SENT'] });
  w.threads.t0 = mailOf('t0', 'Hello', 'Welcome.', { date: at(0) });
  w.answers.push(w.answer('quiet'));
  await w.notice().tick();
  let n = 0;
  const next = async (id: string, body: string, verdict = 'tell_now') => {
    w.threads[id] = mailOf(id, `Subject ${id}`, body, { date: at(++n) });
    w.answers.push(w.answer(verdict, 'A promo.'));
    return w.notice().tick();
  };
  for (const id of ['t1', 't2']) {
    await next(id, 'A big sale on shoes.');
    const [seen] = await w.notice().decisions({ ids: [`gmail:${id}`] });
    await run({ kind: 'row.notNeeded', rowId: `gmail:${id}`, decisionId: seen.decisionId });
  }
  await learning.confirm(learning.view().rules[0].id, 'phone:a');
  await next('p1', 'A big sale on socks.');
  const build = (day: string) =>
    w.notice().seams.build({ day, since: 0, until: Date.now() + 86_400_000 * Number(day.slice(-2)), zone: 'UTC', stamp: w.home.stamp() });
  const first = await build('2026-11-24');
  assert.deepEqual(
    first.view.keptQuiet.map((k: any) => k.id),
    ['gmail:p1'],
  );
  await w.notice().seams.deliver({ id: 'brief:1', day: '2026-11-24', text: first.text, built: first, stamp: w.home.stamp() });
  const second = await build('2026-11-25');
  const listed = second ? JSON.stringify(second.brief) : '';
  assert.ok(!listed.includes('gmail:p1'), 'shown once: not under Needs you, nor again under Kept quiet');
  // a mail held while the brief is on, then the brief is turned off: it moves to Watching
  await next('p2', 'Another sale on hats.');
  assert.equal(
    (await w.notice().watching()).some((m: any) => m.title === 'Subject p2'),
    false,
  );
  await w.home.prefs.change({ brief: { on: false } });
  await w.notice().tick();
  assert.equal(
    (await w.notice().watching()).some((m: any) => m.title === 'Subject p2'),
    true,
  );
});
