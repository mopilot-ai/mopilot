// MoMo's starter routines (electron/momo/starterRoutines.cjs, #2285), on the real routines service and stores: once setup is done, each starter the user picked waits unapproved in Settings › MoMo › Routines; it is proposed once ever (not again on a restart, a second offer at once, another prefs change or after the user declined it); nothing is proposed before setup is done, while MoMo isn't allowed, or while it is paused or being reset (held, read again before each starter); a starter that couldn't be proposed is tried again next time.
import './support/tz-la.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { world } from './support/momo-routines.ts';

const require = createRequire(import.meta.url);
const { createStarterOffers, STARTERS } = require('../electron/momo/starterRoutines.cjs');
const { MOMO_STARTER_ROUTINES } = require('../shared/momoPrefs.mjs');
const { rules } = require('../electron/platform/scheduler.cjs');

const done = (starter: string[], o: object = {}) => ({ momo: { onboarding: { done: true, step: 0 }, routines: { starter, ...o } } });

function rig(o: { prefs?: any; dir?: string } = {}) {
  const w = world({ dir: o.dir });
  let prefs = o.prefs ?? {};
  let allowed = true;
  let held = false;
  const offer = createStarterOffers({ routines: w.service, prefs: () => prefs, allowed: () => allowed, held: () => held });
  return { w, offer, setPrefs: (p: any) => (prefs = p), setAllowed: (v: boolean) => (allowed = v), setHeld: (v: boolean) => (held = v) };
}

test('every starter setup can save has its routine: a name, a prompt, a schedule the scheduler reads and the sources it reads', () => {
  assert.deepEqual(Object.keys(STARTERS).sort(), [...MOMO_STARTER_ROUTINES].sort());
  for (const id of MOMO_STARTER_ROUTINES) {
    const r = STARTERS[id]();
    assert.ok(r.name && r.prompt && r.sources.length, id);
    assert.ok(rules.nextRun(r.rrule, new Date()), id);
  }
  // the id older builds saved stays; the routine is the morning briefing, every day at 08:00
  const morning = STARTERS.morningFeed();
  assert.deepEqual([morning.name, morning.rrule], ['Morning briefing', 'FREQ=DAILY;BYHOUR=8;BYMINUTE=0;BYSECOND=0']);
});

test('setup done: each starter picked waits unapproved, once ever; declined, it doesn’t come back', async () => {
  const { w, offer, setPrefs } = rig();
  // setup not done yet: nothing
  setPrefs({ momo: { onboarding: { done: false, step: 3 }, routines: { starter: ['morningFeed'] } } });
  assert.deepEqual(await offer(), []);
  setPrefs(done(['morningFeed', 'bills']));
  // two offers at once (a prefs change at startup): each starter once
  const [first, second] = await Promise.all([offer(), offer()]);
  assert.deepEqual(
    first.map((r: any) => r.name),
    ['Morning briefing', 'Bill reminders'],
  );
  assert.deepEqual(second, []);
  assert.deepEqual(
    w.routines.list().map((r: any) => [r.name, r.approved, r.rrule]),
    [
      ['Morning briefing', false, 'FREQ=DAILY;BYHOUR=8;BYMINUTE=0;BYSECOND=0'],
      ['Bill reminders', false, 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0'],
    ],
  );
  // declined, then setup opened again from Settings and another starter added
  await w.service.remove(w.routines.list()[0].id);
  setPrefs(done(['morningFeed', 'bills', 'weekAhead']));
  assert.deepEqual(
    (await offer()).map((r: any) => r.name),
    ['Week ahead'],
  );
  // a restart: a fresh service on the same folder offers nothing again
  const again = rig({ dir: w.dir, prefs: done(['morningFeed', 'bills', 'weekAhead']) });
  assert.deepEqual(await again.offer(), []);
  assert.deepEqual(
    again.w.routines.list().map((r: any) => r.name),
    ['Bill reminders', 'Week ahead'],
  );
});

test('the prefs offered are the ones given (a change main heard), else the ones read now', async () => {
  const { w, offer } = rig({ prefs: {} });
  assert.deepEqual(
    (await offer(done(['weekAhead']))).map((r: any) => r.name),
    ['Week ahead'],
  );
  assert.deepEqual(await offer(), [], 'nothing picked in what is read now');
  assert.equal(w.routines.list().length, 1);
});

test('not allowed: nothing is proposed; a starter that couldn’t be proposed is tried again; a check that throws doesn’t stop later offers', async () => {
  const { w, offer, setAllowed, setPrefs } = rig({ prefs: done(['bills']) });
  setAllowed(false);
  assert.deepEqual(await offer(), []);
  assert.deepEqual(w.routines.list(), []);
  setAllowed(true);
  // MoMo's storage can't be read (encryption unavailable): kept for the next offer
  const real = w.service.propose.bind(w.service);
  let failing = true;
  w.service.propose = (input: any, o: any) => (failing ? Promise.reject(new Error('unavailable')) : real(input, o));
  assert.deepEqual(await offer(), []);
  failing = false;
  assert.deepEqual(
    (await offer()).map((r: any) => r.name),
    ['Bill reminders'],
  );
  // prefs that can't be read at all: that offer fails, the next still runs
  setPrefs(done(['weekAhead']));
  const broken = createStarterOffers({
    routines: w.service,
    prefs: () => done(['weekAhead']),
    held: () => false,
    allowed: (() => {
      let n = 0;
      return () => {
        if (n++ === 0) throw new Error('access not known yet');
        return true;
      };
    })(),
  });
  await assert.rejects(broken(), /access not known yet/);
  assert.deepEqual(
    (await broken()).map((r: any) => r.name),
    ['Week ahead'],
  );
});

test('held (MoMo paused, or a reset under way): nothing more is proposed, even partway through; offered again once let go', async () => {
  const { w, offer, setHeld } = rig({ prefs: done(['morningFeed', 'weekAhead', 'bills']) });
  setHeld(true);
  assert.deepEqual(await offer(), []);
  // a reset begins while the first starter is being proposed: the rest wait
  setHeld(false);
  const propose = w.service.propose.bind(w.service);
  w.service.propose = async (input: any, o: any) => {
    const r = await propose(input, o);
    setHeld(true);
    return r;
  };
  assert.deepEqual(
    (await offer()).map((r: any) => r.name),
    ['Morning briefing'],
  );
  w.service.propose = propose;
  setHeld(false);
  assert.deepEqual(
    (await offer()).map((r: any) => r.name),
    ['Week ahead', 'Bill reminders'],
  );
});
