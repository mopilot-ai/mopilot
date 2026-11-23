// MoMo's notifications (electron/momo/notices.cjs, the Notifier's 'momo' kind in electron/platform/notify.cjs, shared/momoNotices.mjs, #2139): through the real Notifier, nothing for an account MoMo is off for, only a fixed title in every payload, the notify switch, quiet hours, a click opening the MoMo chat, and every notice gone when MoMo is revoked. Every notice names a chat.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createMomoNotices, PREFIX, KEEP, QUIET_CHECK_MS } = require('../electron/momo/notices.cjs');
const { Notifier, registerNotify, needsYou, mergedTitle, KINDS } = require('../electron/platform/notify.cjs');
const { MOMO_NOTICE_TITLES, momoMergedTitle } = await import('../shared/momoNotices.mjs');

/** Local clock times on one day. */
const at = (h: number, m = 0) => new Date(2030, 0, 15, h, m).getTime();

function rig(o: { allowed?: boolean; prefs?: any; mode?: string; focused?: boolean; time?: number } = {}) {
  const state = { allowed: o.allowed ?? true, prefs: o.prefs ?? {}, time: o.time ?? at(12), viewing: false };
  const shown: any[] = [];
  const closed: string[] = [];
  const opened: any[] = [];
  /** the pending quiet-hours checks: run one with fire() */
  const timers: { fn: () => void; ms: number }[] = [];
  const notifier = new Notifier({
    getMode: () => o.mode ?? 'always',
    isFocused: () => o.focused ?? false,
    now: () => state.time,
    show: (n: any) => (shown.push(n), { close: () => closed.push(n.id) }),
  });
  const notices = createMomoNotices({
    notifier,
    allowed: () => state.allowed,
    prefs: () => state.prefs,
    open: (t: any) => opened.push(t),
    viewing: () => state.viewing,
    now: () => state.time,
    schedule: (fn: () => void, ms: number) => {
      const t = { fn, ms };
      timers.push(t);
      return t;
    },
    cancel: (t: any) => timers.splice(timers.indexOf(t), 1),
  });
  const fire = () => timers.shift()!.fn();
  return { state, shown, closed, opened, notifier, notices, timers, fire };
}

test('an account MoMo is off for gets no MoMo notice, and a click on an old one opens nothing', () => {
  const r = rig({ allowed: false });
  assert.equal(r.notices.needsYou({ kind: 'chat', chatId: 'claude:momo-main' }), false);
  assert.deepEqual(r.shown, []);
  // MoMo's key is still MoMo's: main's chat opener never gets it
  assert.equal(r.notices.click(`${PREFIX}chat:claude:momo-main`), true);
  assert.deepEqual(r.opened, []);
  assert.equal(r.notices.click('claude:coding-1'), false);
  assert.equal(r.notices.click(undefined), false);
});

test('a payload is the fixed title alone: nothing a chat holds goes into it', () => {
  const r = rig();
  // whatever a caller passes beside the chat is dropped
  const secret = 'Your test results from Dr. Lee are in';
  assert.equal(r.notices.needsYou({ kind: 'chat', chatId: 'c1', title: secret, body: secret } as any), true);
  assert.deepEqual(
    r.shown.map((n) => [n.id, n.title, n.body, n.chatId]),
    [['chat:momo:chat:c1', 'MoMo needs you', '', 'momo:chat:c1']],
  );
  assert.ok(!JSON.stringify(r.shown).includes('Dr. Lee'));
  assert.deepEqual({ ...MOMO_NOTICE_TITLES }, { needsYou: 'MoMo needs you' });
});

test('several waiting at once merge into a count, still with no content', () => {
  const r = rig();
  r.notices.needsYou({ kind: 'chat', chatId: 'claude:momo-main' });
  r.state.time += 1000;
  r.notices.needsYou({ kind: 'chat', chatId: 'codex:momo-routine' });
  assert.deepEqual(
    r.shown.map((n) => [n.title, n.body]),
    [
      ['MoMo needs you', ''],
      ['MoMo needs you (2)', ''],
    ],
  );
  assert.equal(mergedTitle('momo', true, 3), 'MoMo needs you (3)');
  assert.equal(mergedTitle('momo', false, 2), 'MoMo needs you (2)');
  assert.equal(momoMergedTitle(4), 'MoMo needs you (4)');
  assert.ok(!KINDS.includes('momo'), 'no switch in Settings › General: MoMo has its own');
  assert.equal(needsYou('momo', 'needs'), true);
  assert.equal(needsYou('momo', 'done'), false);
});

test('the notify switch: needing an answer is on unless turned off', () => {
  const r = rig();
  assert.equal(r.notices.needsYou({ kind: 'chat', chatId: 'c0' }), true);
  r.state.prefs = { momo: { notify: { needsAnswer: false } } };
  assert.equal(r.notices.needsYou({ kind: 'chat', chatId: 'c1' }), false);
  // a value that isn't a switch reads as the default
  r.state.prefs = { momo: { notify: { needsAnswer: 'no' } } };
  r.state.time += 120_000;
  assert.equal(r.notices.needsYou({ kind: 'chat', chatId: 'c2' }), true);
  r.state.prefs = null;
  assert.equal(r.notices.needsYou({ kind: 'chat', chatId: 'c3' }), true);
  // the app's own Notifications setting still applies: "Never" shows nothing
  const never = rig({ mode: 'never' });
  assert.equal(never.notices.needsYou({ kind: 'chat', chatId: 'c1' }), false);
});

test('a “needs you” in quiet hours waits, and one title-only notice says so when they end, opening the newest', () => {
  const r = rig({ time: at(23, 30) });
  assert.equal(r.notices.needsYou({ kind: 'chat', chatId: 'claude:momo-main' }), false);
  assert.equal(r.notices.needsYou({ kind: 'chat', chatId: 'n2' }), false);
  assert.deepEqual(
    r.timers.map((t) => t.ms),
    [QUIET_CHECK_MS],
  );
  // still quiet: checks again later
  r.state.time = at(6, 59);
  r.fire();
  assert.equal(r.shown.length, 0);
  assert.equal(r.timers.length, 1);
  r.state.time = at(7, 0);
  r.fire();
  assert.deepEqual(
    r.shown.map((n) => [n.title, n.body, n.chatId]),
    [['MoMo needs you', '', 'momo:chat:n2']],
  );
  assert.equal(r.timers.length, 0);
  r.notices.click('momo:chat:n2');
  assert.deepEqual(r.opened, [{ kind: 'chat', chatId: 'n2' }]);
});

test('what waits through quiet hours goes when answered, revoked or switched off, and nothing shows for it', () => {
  const r = rig({ time: at(23, 30) });
  r.notices.needsYou({ kind: 'chat', chatId: 'n1' });
  r.notices.needsYou({ kind: 'chat', chatId: 'n2' });
  r.notices.resolved({ kind: 'chat', chatId: 'n1' });
  assert.equal(r.timers.length, 1, 'one still waits');
  r.notices.resolved({ kind: 'chat', chatId: 'n2' });
  assert.equal(r.timers.length, 0, 'nothing waits');
  for (const end of [
    () => r.notices.closeAll(),
    () => (r.state.allowed = false),
    () => (r.state.prefs = { momo: { notify: { needsAnswer: false } } }),
  ]) {
    r.state.time = at(23, 30);
    r.notices.needsYou({ kind: 'chat', chatId: 'n3' });
    end();
    r.state.time = at(8, 0);
    if (r.timers.length) r.fire();
    assert.equal(r.timers.length, 0);
    r.state.allowed = true;
    r.state.prefs = {};
  }
  assert.equal(r.shown.length, 0);
  // at most the latest KEEP wait
  r.state.time = at(23, 30);
  for (let i = 0; i <= KEEP; i++) r.notices.needsYou({ kind: 'chat', chatId: `k${i}` });
  r.notices.resolved({ kind: 'chat', chatId: 'k0' });
  assert.equal(r.timers.length, 1);
});

test('quiet hours hold the MoMo notice, past midnight too; none set or a time outside them shows it', () => {
  const r = rig({ time: at(23, 30) });
  // the default quiet hours, 22:00–07:00
  assert.equal(r.notices.needsYou({ kind: 'chat', chatId: 'claude:momo-main' }), false);
  r.state.time = at(6, 59);
  assert.equal(r.notices.needsYou({ kind: 'chat', chatId: 'claude:momo-main' }), false);
  r.state.time = at(7, 0);
  assert.equal(r.notices.needsYou({ kind: 'chat', chatId: 'claude:momo-main' }), true);
  r.state.prefs = { momo: { routines: { quietHours: { start: '12:00', end: '13:00' } } } };
  r.state.time = at(12, 30);
  assert.equal(r.notices.needsYou({ kind: 'chat', chatId: 'claude:momo-main' }), false);
  r.state.prefs = { momo: { routines: { quietHours: null } } };
  r.state.time = at(23, 30);
  assert.equal(r.notices.needsYou({ kind: 'chat', chatId: 'n1' }), true);
  assert.equal(r.shown.length, 2);
});

test('a click opens the MoMo chat while MoMo is on; an answered chat’s notice goes', () => {
  const r = rig();
  r.notices.needsYou({ kind: 'chat', chatId: 'claude:momo-main' });
  assert.equal(r.notices.click('momo:chat:claude:momo-main'), true);
  assert.deepEqual(r.opened, [{ kind: 'chat', chatId: 'claude:momo-main' }]);
  // once only
  r.notices.click('momo:chat:claude:momo-main');
  assert.equal(r.opened.length, 1);
  r.state.time += 120_000;
  r.notices.needsYou({ kind: 'chat', chatId: 'n1' });
  r.notices.resolved({ kind: 'chat', chatId: 'n1' });
  assert.deepEqual(r.closed, ['chat:momo:chat:n1']);
  r.notices.click('momo:chat:n1');
  assert.equal(r.opened.length, 1);
  // nothing to resolve for a chat it can't name
  r.notices.resolved({ kind: 'chat' } as any);
  assert.equal(r.closed.length, 1);
});

test('revoked: every MoMo notice the Notifier has goes, beyond the ones remembered for a click; coding ones stay', () => {
  const big = rig();
  for (let i = 0; i < KEEP + 5; i++) big.notices.needsYou({ kind: 'chat', chatId: `n${i}` });
  big.notifier.notify('turn', 'claude:coding-1', { title: 'Done' });
  big.notices.closeAll();
  assert.deepEqual([...big.notifier.byChat.keys()], ['claude:coding-1']);
});

test('revoked: every MoMo notice goes, and a later click opens nothing', () => {
  const r = rig();
  r.notices.needsYou({ kind: 'chat', chatId: 'n1' });
  r.state.allowed = false;
  r.notices.closeAll();
  assert.deepEqual(r.closed, ['chat:momo:chat:n1']);
  assert.equal(r.notices.click('momo:chat:n1'), true);
  // allowed again before a click on a notice still remembered: still nothing while off
  r.state.allowed = true;
  r.notices.needsYou({ kind: 'chat', chatId: 'n2' });
  r.state.allowed = false;
  r.notices.click('momo:chat:n2');
  assert.deepEqual(r.opened, []);
});

test('while a chat controls the screen, a MoMo notice is dropped, not shown later past MoMo’s checks', () => {
  const r = rig({ time: at(21, 59) });
  r.notifier.hold(true);
  assert.equal(r.notices.needsYou({ kind: 'chat', chatId: 'n1' }), true, 'needing you is never held back');
  // quiet hours start before the hold ends: nothing shows inside them
  r.state.time = at(22, 5);
  r.notifier.hold(false);
  assert.deepEqual(
    r.shown.map((n) => n.title),
    ['MoMo needs you'],
  );
  // a coding chat's held notice still waits for the hold to end, as before
  r.notifier.hold(true);
  r.notifier.notify('turn', 'claude:coding-1', { title: 'Done' });
  r.notifier.hold(false);
  assert.equal(r.shown.at(-1).title, 'Done');
  // a MoMo notice that isn't a "needs you" is dropped while held, never shown after
  r.notifier.hold(true);
  assert.equal(r.notifier.notify('momo', 'momo:chat:n2', { title: 'x', status: 'done' }), null);
  r.notifier.hold(false);
  assert.equal(r.shown.length, 2);
});

test('a notice that names no chat shows nothing; the user looking at it in a focused window gets no banner', () => {
  const r = rig();
  for (const bad of [
    null,
    {},
    { kind: 'chat' },
    { kind: 'chat', chatId: '' },
    { kind: 'chat', chatId: 'x'.repeat(257) },
    { kind: 'nope', id: 'a' },
  ])
    assert.equal(r.notices.needsYou(bad as any), false);
  assert.equal(r.shown.length, 0);
  const seen = rig({ mode: 'unfocused', focused: true });
  seen.state.viewing = true;
  assert.equal(seen.notices.needsYou({ kind: 'chat', chatId: 'claude:momo-main' }), false);
  seen.state.viewing = false;
  assert.equal(seen.notices.needsYou({ kind: 'chat', chatId: 'claude:momo-main' }), true);
});

test('only the latest notices are remembered for their click', () => {
  const r = rig();
  for (let i = 0; i <= KEEP; i++) r.notices.needsYou({ kind: 'chat', chatId: `n${i}` });
  r.notices.click('momo:chat:n0');
  assert.deepEqual(r.opened, []);
  r.notices.click(`momo:chat:n${KEEP}`);
  assert.deepEqual(r.opened, [{ kind: 'chat', chatId: `n${KEEP}` }]);
  // the same item again moves to the newest
  r.notices.needsYou({ kind: 'chat', chatId: 'n1' });
  r.notices.needsYou({ kind: 'chat', chatId: 'n1' });
  r.notices.click('momo:chat:n1');
  assert.equal(r.opened.length, 2);
});

test('a window can’t make a MoMo notice over app:notify; other kinds still go through', async () => {
  const handlers = new Map<string, any>();
  const made: { title: string }[] = [];
  class FakeNotification {
    static isSupported = () => true;
    o: any;
    constructor(o: any) {
      this.o = o;
      made.push(o);
    }
    on() {}
    show() {}
    close() {}
  }
  registerNotify({ handle: (ch: string, f: any) => handlers.set(ch, f) }, { Notification: FakeNotification, getMode: () => 'always' });
  await handlers.get('app:notify')({}, 'momo', 'momo:chat:n1', { title: 'Forged', status: 'needs' });
  assert.equal(made.length, 0);
  await handlers.get('app:notify')({}, 'turn', 'claude:c1', { title: 'Done' });
  assert.deepEqual(
    made.map((n) => n.title),
    ['Done'],
  );
});

test('with no viewing check or clock given, nothing counts as seen and the computer’s clock decides quiet hours', () => {
  const shown: any[] = [];
  const notifier = new Notifier({ getMode: () => 'unfocused', isFocused: () => true, show: (n: any) => (shown.push(n), { close() {} }) });
  let prefs: any = { momo: { routines: { quietHours: null } } };
  const notices = createMomoNotices({ notifier, allowed: () => true, prefs: () => prefs, open: () => {} });
  assert.equal(notices.needsYou({ kind: 'chat', chatId: 'claude:momo-main' }), true);
  assert.equal(shown[0].title, 'MoMo needs you');
  // quiet for the next hour: the wait uses the app's own timer, which revoking cancels
  const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  prefs = { momo: { routines: { quietHours: { start: hhmm(new Date()), end: hhmm(new Date(Date.now() + 3_600_000)) } } } };
  assert.equal(notices.needsYou({ kind: 'chat', chatId: 'n1' }), false);
  notices.closeAll();
});

test('setup’s Notifications row: one notice says MoMo’s notifications are on, which is how macOS asks for permission; none while Notifications is Never (#2607)', () => {
  const noticed: any[] = [];
  const make = (mode: string) =>
    createMomoNotices({
      notifier: new Notifier({ getMode: () => mode, show: () => ({ close() {} }), showNotice: (n: any) => noticed.push(n) }),
      allowed: () => true,
      prefs: () => ({}),
      open() {},
    });
  assert.equal(make('unfocused').welcome(), true);
  assert.deepEqual(noticed, [{ title: 'MoMo notifications are on', body: 'You’ll hear from MoMo when it needs you.' }]);
  assert.equal(make('never').welcome(), true, 'it still answers: nothing went wrong for the user to be told');
  assert.equal(noticed.length, 1, 'but Never shows nothing');
});
