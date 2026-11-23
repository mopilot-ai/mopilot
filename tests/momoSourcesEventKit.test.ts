// MoMo's Calendar and Reminders sources over the helper's EventKit commands (#2139 P2, electron/momo/sources/eventKit.cjs, calendar.cjs, reminders.cjs): connecting asks macOS first and only connects on a full grant, a connect voided by a disconnect while macOS asked, helper failures as not_granted / unavailable / failed, the connect day as the history floor, range and name checks, and limits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { hubFixture } from './support/momo-sources.ts';

const require = createRequire(import.meta.url);
const { SourceError } = require('../electron/momo/sources/hub.cjs');
const { createEventKit, sourceError, limitOf, idsByTitle } = require('../electron/momo/sources/eventKit.cjs');
const { calendarSource, timeOf } = require('../electron/momo/sources/calendar.cjs');
const { remindersSource } = require('../electron/momo/sources/reminders.cjs');

const codeOf = (code: string) => (e: any) => e instanceof SourceError && e.code === code;
const DAY = 86_400_000;
const NOW = new Date(2026, 9, 23, 15, 30).getTime();
const MIDNIGHT = new Date(2026, 9, 23).getTime();
const CALS = [
  { id: 'c1', title: 'Work', account: 'iCloud' },
  { id: 'c2', title: 'Home', account: 'iCloud' },
];

/** A fake helper client: answers by method, records calls, and can be told to fail like ComputerHelper does. */
function fakeHelper(over: Record<string, (p: any) => any> = {}) {
  const calls: [string, any, any][] = [];
  const grants: any = { calendar: 'notDetermined', reminders: 'notDetermined' };
  const answers: Record<string, (p: any) => any> = {
    'eventkit.status': () => ({ protocol: 1, ...grants }),
    'eventkit.request': (p) => ((grants[p.entity] = 'granted'), { protocol: 1, ...grants }),
    'calendar.calendars': () => ({ items: CALS }),
    'reminders.lists': () => ({ items: [{ id: 'l1', title: 'Errands', account: 'iCloud' }] }),
    'calendar.events': () => ({ items: [{ title: 'Sync', start: NOW + DAY }], truncated: false }),
    'reminders.items': () => ({ items: [{ title: 'Milk' }, { title: 'Bread' }], truncated: true }),
    ...over,
  };
  return {
    calls,
    grants,
    call: async (method: string, params: any = {}, opts: any = {}) => {
      calls.push([method, params, opts]);
      return answers[method](params);
    },
  };
}
const helperError = (message: string, reason: string, extra: any = {}) => Object.assign(new Error(message), { reason, ...extra });

function setup(helper: any = fakeHelper()) {
  const f = hubFixture({ now: () => NOW });
  const eventKit = createEventKit(helper);
  return {
    ...f,
    helper,
    eventKit,
    calendar: calendarSource({ hub: f.hub, eventKit, now: () => NOW }),
    reminders: remindersSource({ hub: f.hub, eventKit }),
  };
}

test('helper failures map to source errors: not granted, outdated or missing helper, anything else failed', async () => {
  assert.ok(codeOf('not_granted')(sourceError(helperError('Calendars access is not granted', 'not_granted'))));
  const outdated = sourceError(helperError('unknown method', 'method_not_found', { fix: 'rebuild it' }));
  assert.ok(codeOf('unavailable')(outdated) && /too old.*rebuild it/.test(outdated.message));
  assert.match(sourceError(helperError('x', 'method_not_found')).message, /update MoPilot/);
  assert.ok(codeOf('unavailable')(sourceError(helperError('no helper', 'helper_unavailable'))));
  assert.ok(codeOf('failed')(sourceError(new Error('timed out'))));
  assert.ok(codeOf('failed')(sourceError('odd')));
  const own = new SourceError('mine', 'bad_args');
  assert.equal(sourceError(own), own);
  // no helper at all (not macOS): unavailable, and status says so for both
  const none = createEventKit(null);
  assert.deepEqual(await none.status(), { calendar: 'unavailable', reminders: 'unavailable' });
  await assert.rejects(none.calendars(), codeOf('unavailable'));
  const broken = createEventKit(fakeHelper({ 'eventkit.status': () => Promise.reject(new Error('boom')) }));
  await assert.rejects(broken.status(), codeOf('failed'));
});

test('status and request answer each grant; request waits for the user', async () => {
  const helper = fakeHelper();
  const ek = createEventKit(helper);
  assert.deepEqual(await ek.status(), { calendar: 'notDetermined', reminders: 'notDetermined' });
  // a wait for the user's switch reads through a helper launched for the read when there is a way to: a running one keeps its first answer
  const n = helper.calls.length;
  assert.deepEqual(await ek.status({ fresh: true }), { calendar: 'notDetermined', reminders: 'notDetermined' });
  assert.equal(helper.calls.length, n + 1, 'no launch to read through: the helper answers');
  const launched: string[] = [];
  const withLaunch = createEventKit({
    ...helper,
    offlineStatus: async (kind: string) => (launched.push(kind), { calendar: 'granted', reminders: 'denied' }),
  } as any);
  assert.deepEqual(await withLaunch.status({ fresh: true }), { calendar: 'granted', reminders: 'denied' });
  assert.deepEqual(launched, ['eventkit']);
  assert.equal(helper.calls.length, n + 1, 'the running helper is not asked');
  assert.deepEqual(
    await withLaunch.status(),
    { calendar: 'notDetermined', reminders: 'notDetermined' },
    'a plain status asks the running helper',
  );
  // the helper is quit while System Settings is open: stopped, not running, or working; none without a helper that can
  assert.equal(await withLaunch.release(), 'none');
  assert.equal(createEventKit({ ...helper, release: () => 'busy' } as any).release(), 'busy');
  assert.equal(createEventKit(null).release(), 'none');
  assert.deepEqual(await ek.request('reminders'), { calendar: 'notDetermined', reminders: 'granted', asked: false });
  // the helper says when its call showed the prompt
  const asking = createEventKit(
    fakeHelper({ 'eventkit.request': () => ({ calendar: 'denied', reminders: 'notDetermined', asked: true }) }),
  );
  assert.deepEqual(await asking.request('calendar'), { calendar: 'denied', reminders: 'notDetermined', asked: true });
  assert.deepEqual(helper.calls.at(-1), ['eventkit.request', { entity: 'reminders' }, { timeoutMs: 600000 }]);
});

test('limits and names: clamped limits, names any case, an unknown name lists the real ones', () => {
  assert.equal(limitOf(undefined), 100);
  assert.equal(limitOf(0), 1);
  assert.equal(limitOf(2.7), 2);
  assert.equal(limitOf(10_000), 500);
  assert.equal(limitOf(Number.NaN), 100);
  assert.deepEqual(idsByTitle(CALS, [' work '], 'calendar'), ['c1']);
  assert.throws(
    () => idsByTitle(CALS, ['Gym'], 'calendar'),
    (e: any) => codeOf('bad_args')(e) && /the calendars are: Work, Home/.test(e.message),
  );
  assert.throws(() => idsByTitle([], ['Gym'], 'list'), /the lists are: none/);
  // one name that matches nothing is refused even when another matches, naming only the missing one
  assert.throws(
    () => idsByTitle(CALS, ['Work', 'Gym'], 'calendar'),
    (e: any) => /^No calendar named Gym;/.test(e.message),
  );
});

test('times: ISO or milliseconds, the fallback when missing, anything else a bad argument', () => {
  assert.equal(timeOf(undefined, 5, 'start'), 5);
  assert.equal(timeOf('', 5, 'start'), 5);
  assert.equal(timeOf(null, 5, 'start'), 5);
  assert.equal(timeOf(42, 5, 'start'), 42);
  assert.equal(timeOf('2026-10-23T09:00', 5, 'start'), new Date(2026, 9, 23, 9).getTime());
  // a bare date is the local day, not UTC midnight
  assert.equal(timeOf(' 2026-10-27 ', 5, 'end'), new Date(2026, 9, 27).getTime());
  assert.throws(
    () => timeOf('next week', 5, 'end'),
    (e: any) => codeOf('bad_args')(e) && /^end must be/.test(e.message),
  );
  assert.throws(() => timeOf({}, 5, 'start'), codeOf('bad_args'));
});

test('connecting asks macOS and connects only on a full grant; a refusal connects nothing', async () => {
  const s = setup(fakeHelper({ 'eventkit.request': () => ({ calendar: 'denied', reminders: 'writeOnly' }) }));
  assert.deepEqual(await s.calendar.connect(), { connected: false, grant: 'denied' });
  assert.deepEqual(await s.reminders.connect(), { connected: false, grant: 'writeOnly' });
  assert.equal(s.hub.get('calendar'), null);
  // a refusal at the prompt this call showed is marked, so the next Connect (not this one) opens the pane
  const asked = setup(fakeHelper({ 'eventkit.request': () => ({ calendar: 'denied', reminders: 'denied', asked: true }) }));
  assert.deepEqual(await asked.calendar.connect(), { connected: false, grant: 'denied', asked: true });
  const ok = setup();
  assert.deepEqual(await ok.calendar.connect(), { connected: true, grant: 'granted' });
  assert.equal(ok.hub.get('calendar').level, 'read');
  assert.deepEqual(await ok.calendar.detail(), ['Work', 'Home']);
  assert.deepEqual(await ok.reminders.detail(), ['Errands']);
});

test('a disconnect while macOS asked voids the connect', async () => {
  let answer!: (v: any) => void;
  const s = setup(fakeHelper({ 'eventkit.request': () => new Promise((r) => (answer = r)) }));
  const pending = s.calendar.connect();
  await Promise.resolve();
  s.hub.disconnect('calendar');
  answer({ calendar: 'granted', reminders: 'notDetermined' });
  assert.deepEqual(await pending, { connected: false, grant: 'granted' });
  assert.equal(s.hub.get('calendar'), null);
});

test('calendar events: default the next 7 days, decided and audited, rows and truncation passed on', async () => {
  const s = setup();
  await assert.rejects(s.calendar.events({}, 'momo-main'), codeOf('not_connected'));
  await s.calendar.connect();
  const r = await s.calendar.events({}, 'momo-main');
  assert.deepEqual(r, {
    count: 1,
    events: [{ title: 'Sync', start: NOW + DAY }],
    truncated: false,
    from: NOW,
    to: NOW + 7 * DAY,
    clipped: false,
    floor: MIDNIGHT,
  });
  assert.deepEqual(s.helper.calls.at(-1), ['calendar.events', { start: NOW, end: NOW + 7 * DAY, limit: 100 }, {}]);
  assert.equal(s.decided[0].action, 'calendar.events');
  assert.equal(s.decided[0].summary, 'events 2026-10-23 to 2026-10-30', 'the audit names local days');
  // an exclusive midnight end names the day before it
  await s.calendar.events({ start: '2026-10-24', end: '2026-10-27' }, 'momo-main');
  assert.equal(s.decided[1].summary, 'events 2026-10-24 to 2026-10-26');
  assert.equal(s.audited[0].count, 1);
});

test('calendar events never reach before the connect day; a range wholly before it reads nothing', async () => {
  const s = setup();
  await s.calendar.connect();
  const r = await s.calendar.events({ start: NOW - 3 * DAY, end: NOW + DAY }, 'momo-main');
  assert.equal(r.from, MIDNIGHT);
  assert.equal(r.clipped, true);
  assert.equal(s.helper.calls.at(-1)[1].start, MIDNIGHT);
  const calls = s.helper.calls.length;
  const before = await s.calendar.events({ start: NOW - 9 * DAY, end: NOW - 2 * DAY }, 'momo-main');
  assert.deepEqual([before.count, before.clipped], [0, true]);
  assert.equal(s.helper.calls.length, calls, 'nothing is asked of macOS');
  assert.equal(s.decided.length, 1, 'and nothing is decided or audited');
});

test('calendar events: bad ranges, named calendars, unknown names and the limit', async () => {
  const s = setup();
  await s.calendar.connect();
  await assert.rejects(
    s.calendar.events({ start: NOW, end: NOW }, 'c'),
    (e: any) => codeOf('bad_args')(e) && /after start/.test(e.message),
  );
  await assert.rejects(s.calendar.events({ start: NOW, end: NOW + 93 * DAY }, 'c'), /at most 92 days/);
  await s.calendar.events({ calendars: ['home'], limit: 5 }, 'c');
  assert.deepEqual(s.helper.calls.at(-1)[1], { start: NOW, end: NOW + 7 * DAY, ids: ['c2'], limit: 5 });
  await assert.rejects(s.calendar.events({ calendars: ['Gym'] }, 'c'), codeOf('bad_args'));
  assert.equal(s.audited.at(-1).result, 'failed');
});

test('macOS taking access back after connect reads as not granted', async () => {
  const helper = fakeHelper({ 'calendar.events': () => Promise.reject(helperError('Calendars access isn’t granted', 'not_granted')) });
  const s = setup(helper);
  await s.calendar.connect();
  await assert.rejects(s.calendar.events({}, 'c'), codeOf('not_granted'));
  assert.deepEqual([s.audited[0].result, s.audited[0].reason], ['failed', 'not_granted']);
});

test('reminders: open ones by default, completed only since the connect day, named lists', async () => {
  const s = setup();
  await assert.rejects(s.reminders.items({}, 'c'), codeOf('not_connected'));
  await s.reminders.connect();
  const open = await s.reminders.items({}, 'c');
  assert.deepEqual(open, {
    count: 2,
    reminders: [{ title: 'Milk' }, { title: 'Bread' }],
    truncated: true,
    floor: MIDNIGHT,
    completed: false,
  });
  assert.deepEqual(s.helper.calls.at(-1)[1], { limit: 100 });
  assert.equal(s.decided[0].summary, 'open reminders');
  await s.reminders.items({ includeCompleted: true, lists: ['errands'], limit: 3 }, 'c');
  assert.deepEqual(s.helper.calls.at(-1)[1], { ids: ['l1'], completedSince: MIDNIGHT, limit: 3 });
  assert.equal(s.decided[1].summary, 'open and completed reminders in 1 lists');
});

test('an event that started before the connect day is left out, though EventKit returns it as overlapping', async () => {
  const s = setup(
    fakeHelper({
      'calendar.events': () => ({
        items: [
          { title: 'Conference (started yesterday)', start: MIDNIGHT - DAY, end: MIDNIGHT + DAY },
          { title: 'Today', start: MIDNIGHT + 3_600_000, end: MIDNIGHT + 7_200_000 },
        ],
        truncated: false,
      }),
    }),
  );
  await s.calendar.connect();
  const r = await s.calendar.events({}, 'c');
  assert.deepEqual(
    r.events.map((e: any) => e.title),
    ['Today'],
  );
  assert.deepEqual([r.count, r.clipped], [1, true]);
  assert.equal(s.audited[0].count, 1);
});

test('macOS is not asked while MoMo is not allowed or encryption is off', async () => {
  const s = setup();
  s.flags.allowed = false;
  await assert.rejects(s.calendar.connect(), codeOf('not_allowed'));
  s.flags.allowed = true;
  s.safe.available = false;
  await assert.rejects(s.reminders.connect(), codeOf('unavailable'));
  assert.equal(s.helper.calls.length, 0);
});

// #2999: macOS answers a request without its prompt (the helper lacks the Calendars entitlement, or a stale grant record confuses
// it): notDetermined stays after a request that asked. main resets this helper's grant record once and asks again, and says what
// happened instead of sending the user to a privacy pane that has no entry to switch.
test('a request that asked but left notDetermined is a silent refusal: the helper’s grant record is reset once and macOS asked again', async () => {
  const resets: string[] = [];
  let asks = 0;
  const helper: any = fakeHelper({
    'eventkit.request': () =>
      asks++
        ? { calendar: 'granted', reminders: 'notDetermined', asked: true }
        : { calendar: 'notDetermined', reminders: 'notDetermined', asked: true },
  });
  helper.resetGrant = async (entity: string) => (resets.push(entity), true);
  const s = setup(helper);
  assert.deepEqual(await s.calendar.connect(), { connected: true, grant: 'granted' });
  assert.deepEqual(resets, ['calendar'], 'only the source being connected is reset');
  assert.equal(asks, 2);
});

test('still no prompt after the reset: the answer says macOS did not ask, with what the helper reported', async () => {
  const resets: string[] = [];
  const silent = {
    calendar: 'notDetermined',
    reminders: 'notDetermined',
    asked: true,
    granted: false,
    requestError: 'EKErrorDomain 100: Access denied',
    requestMs: 9,
  };
  const helper: any = fakeHelper({ 'eventkit.request': () => silent });
  helper.resetGrant = async (entity: string) => (resets.push(entity), true);
  const s = setup(helper);
  assert.deepEqual(await s.reminders.connect(), {
    connected: false,
    grant: 'notDetermined',
    asked: true,
    noPrompt: true,
    reset: true,
    requestError: 'EKErrorDomain 100: Access denied',
  });
  assert.deepEqual(resets, ['reminders']);
  assert.equal(helper.calls.filter(([m]: any[]) => m === 'eventkit.request').length, 2, 'asked again once, not in a loop');
  assert.equal(s.hub.get('reminders'), null);
});

test('no reset is possible or needed: a helper without resetGrant, a failed reset, a real refusal and a prompt left unanswered', async () => {
  // no way to reset (not macOS, a fake helper): the first answer stands, marked as a silent refusal
  const plain = setup(fakeHelper({ 'eventkit.request': () => ({ calendar: 'notDetermined', reminders: 'notDetermined', asked: true }) }));
  assert.deepEqual(await plain.calendar.connect(), { connected: false, grant: 'notDetermined', asked: true, noPrompt: true });
  // tccutil failed: not asked again
  const failing: any = fakeHelper({ 'eventkit.request': () => ({ calendar: 'notDetermined', reminders: 'notDetermined', asked: true }) });
  failing.resetGrant = async () => false;
  const f = setup(failing);
  assert.deepEqual(await f.calendar.connect(), { connected: false, grant: 'notDetermined', asked: true, noPrompt: true });
  assert.equal(failing.calls.filter(([m]: any[]) => m === 'eventkit.request').length, 1);
  // the user answered: denied is their answer, nothing is reset
  const denied: any = fakeHelper({ 'eventkit.request': () => ({ calendar: 'denied', reminders: 'notDetermined', asked: true }) });
  let reset = false;
  denied.resetGrant = async () => ((reset = true), true);
  assert.deepEqual(await setup(denied).calendar.connect(), { connected: false, grant: 'denied', asked: true });
  assert.equal(reset, false);
  // a status that was not notDetermined before the call asks nothing (asked false): no reset either
  const before: any = fakeHelper({ 'eventkit.request': () => ({ calendar: 'notDetermined', reminders: 'notDetermined', asked: false }) });
  before.resetGrant = async () => ((reset = true), true);
  assert.deepEqual(await setup(before).calendar.connect(), { connected: false, grant: 'notDetermined' });
  assert.equal(reset, false);
});

test('request passes on what the helper said about the request itself', async () => {
  const ek = createEventKit(
    fakeHelper({
      'eventkit.request': () => ({
        calendar: 'notDetermined',
        reminders: 'notDetermined',
        asked: true,
        granted: false,
        requestError: 'x',
        requestMs: 4,
      }),
    }),
  );
  assert.deepEqual(await ek.request('calendar'), {
    calendar: 'notDetermined',
    reminders: 'notDetermined',
    asked: true,
    granted: false,
    requestError: 'x',
    requestMs: 4,
  });
  const old = createEventKit(fakeHelper({ 'eventkit.request': () => ({ calendar: 'granted', reminders: 'notDetermined' }) }));
  assert.deepEqual(await old.request('calendar'), { calendar: 'granted', reminders: 'notDetermined', asked: false });
  assert.equal(await old.resetGrant('calendar'), false, 'a helper client with no reset says it could not');
});
