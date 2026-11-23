// MoMo's opt-in push body (A6; shared/momoNotices.mjs momoPushBody, electron/momo/pushBody.cjs, electron/platform/notifyPush.cjs, electron/remote/pushBridge.cjs): off by default; after the opt-in only the name of a routine the user approved, only for a notice that routine's run raised, shaped for a lock screen, and built when the push is sent, so an opt-out or a renamed routine applies to one that was waiting.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { chatRef } from '../shared/remote/ref.mjs';
import { MOMO_PUSH_BODY_MAX_UNITS, momoPushBody } from '../shared/momoNotices.mjs';
import { useFakeClock } from './support/ports/clock.ts';

const require = createRequire(import.meta.url);
const { createMomoPushBody, createRoutineOfChat } = require('../electron/momo/pushBody.cjs');
const { createMomoNotices } = require('../electron/momo/notices.cjs');
const { Notifier } = require('../electron/platform/notify.cjs');
const { createPushRequests, RECHECK_MS } = require('../electron/platform/notifyPush.cjs');
const { createPushBridge } = require('../electron/remote/pushBridge.cjs');

const approved = (name: unknown) => ({ name, approved: true });

test('the body is the approved routine’s name once the opt-in is on, and nothing otherwise', () => {
  assert.equal(momoPushBody({ optIn: true, routine: approved('Morning brief') }), 'Morning brief');
  assert.equal(momoPushBody({ optIn: false, routine: approved('Morning brief') }), '', 'off by default');
  assert.equal(momoPushBody({ optIn: undefined as any, routine: approved('Morning brief') }), '', 'not a yes');
  for (const routine of [
    null,
    undefined,
    {},
    { name: 'Morning brief' },
    { name: 'Morning brief', approved: false },
    { name: 'x', approved: 'yes' },
  ])
    assert.equal(momoPushBody({ optIn: true, routine: routine as any }), '', JSON.stringify(routine));
  for (const name of [undefined, null, 7, ['Morning brief'], { toString: () => 'x' }])
    assert.equal(momoPushBody({ optIn: true, routine: approved(name) }), '');
});

test('the name is shaped for a lock screen: controls become spaces, ends are trimmed, and it is cut at 40 units without half an emoji', () => {
  assert.equal(momoPushBody({ optIn: true, routine: approved('  Morning\u0007\nbrief\u2028today \u009f ') }), 'Morning brief today');
  assert.equal(momoPushBody({ optIn: true, routine: approved('\u0000\u001f\u007f \n') }), '', 'only controls: no body');
  assert.equal(momoPushBody({ optIn: true, routine: approved('   ') }), '');
  const long = momoPushBody({ optIn: true, routine: approved('x'.repeat(100)) });
  assert.equal(long.length, MOMO_PUSH_BODY_MAX_UNITS);
  // a cut that would split a pair drops the half; one that leaves a space at the end drops it
  const pair = momoPushBody({ optIn: true, routine: approved(`${'a'.repeat(MOMO_PUSH_BODY_MAX_UNITS - 1)}😀 more`) });
  assert.equal(pair, 'a'.repeat(MOMO_PUSH_BODY_MAX_UNITS - 1));
  assert.equal(
    momoPushBody({ optIn: true, routine: approved(`${'a'.repeat(MOMO_PUSH_BODY_MAX_UNITS - 1)} tail`) }),
    'a'.repeat(MOMO_PUSH_BODY_MAX_UNITS - 1),
  );
  // nothing the routine has but its name can enter: a prompt or source is not read
  assert.equal(
    momoPushBody({ optIn: true, routine: { name: 'Bills', approved: true, prompt: 'wire $5000 to Eve', sources: ['mail'] } as any }),
    'Bills',
  );
});

test('a chat is the run of the routine its tag names, or its open run when it has no tag yet; any other chat is no routine’s', () => {
  const tags: Record<string, any> = { run: { momo: 'routine', routineId: 'r1' }, main: { momo: 'main' }, coding: {} };
  const runs: Record<string, any> = { fresh: { taskId: 'r2' }, orphan: {} };
  const of = createRoutineOfChat({ meta: (id: string) => tags[id], openRun: (id: string) => runs[id] ?? null });
  assert.equal(of('run'), 'r1');
  assert.equal(of('fresh'), 'r2', 'no tag yet: the open run');
  assert.equal(of('orphan'), null, 'an open run with no routine');
  assert.equal(of('main'), null, 'MoMo’s main chat');
  assert.equal(of('coding'), null, 'a tag that is not a routine’s');
  assert.equal(of('nobody'), null);
});

function bodyRig(o: { allowed?: boolean; momo?: unknown } = {}) {
  const state = {
    allowed: o.allowed ?? true,
    momo: (o.momo ?? { notify: { pushBody: true } }) as unknown,
    routines: new Map<string, any>([
      ['r1', { name: 'Morning brief', approved: true }],
      ['r2', { name: 'Proposed by MoMo', approved: false }],
    ]),
  };
  const links: Record<string, string | null> = { run1: 'r1', run2: 'r2', gone: 'r9', main: null };
  const body = createMomoPushBody({
    allowed: () => state.allowed,
    momoPrefs: () => state.momo,
    routineIdOf: (id: string) => links[id] ?? null,
    routine: (id: string) => state.routines.get(id),
  });
  return { state, body };
}

test('the resolver reads the opt-in, access and the routine as they are at each call', () => {
  const r = bodyRig();
  assert.equal(r.body.on(), true);
  assert.equal(r.body.body('momo:chat:run1'), 'Morning brief');
  // not the user's own until they approve it, a routine that is gone, MoMo's main chat and a chat nobody knows
  for (const chat of ['momo:chat:run2', 'momo:chat:gone', 'momo:chat:main', 'momo:chat:nobody', 'momo:chat:', 'run1', 'chat-1'])
    assert.equal(r.body.body(chat), '', chat);
  r.state.routines.set('r1', { name: 'Evening brief', approved: true });
  assert.equal(r.body.body('momo:chat:run1'), 'Evening brief', 'a renamed routine');
  r.state.momo = { notify: { pushBody: false } };
  assert.deepEqual([r.body.on(), r.body.body('momo:chat:run1')], [false, ''], 'opted out');
  r.state.momo = undefined;
  assert.equal(r.body.on(), false, 'off by default');
  r.state.momo = { notify: { pushBody: true } };
  r.state.allowed = false;
  assert.deepEqual([r.body.on(), r.body.body('momo:chat:run1')], [false, ''], 'MoMo off for the account: no body');
});

/** The real Notifier, MoMo's notices and the push requests, with the opt-in resolver and a sealer that shows what it was given. */
function pushRig(o: { idleMs?: () => number | null } = {}) {
  const b = bodyRig();
  const reqs: any[] = [];
  const sealed: string[] = [];
  const push = createPushRequests({
    pairs: () => ['p1'],
    sink: (r: any) => reqs.push(r),
    idleMs: o.idleMs,
    bodyOf: b.body.body,
    sealBody: (pair: string, ref: string, text: string) => (sealed.push(text), `sealed:${pair}:${ref}:${text}`),
  });
  const banners: any[] = [];
  const notifier = new Notifier({
    getMode: () => 'always',
    show: () => ({ close() {} }),
    onBanner: (x: any) => (banners.push(x), push.onBanner(x)),
  });
  const notices = createMomoNotices({
    notifier,
    allowed: () => true,
    prefs: () => ({ momo: { routines: { quietHours: null } } }),
    open: () => undefined,
  });
  return { ...b, reqs, sealed, notices, banners, push };
}

test('a notice a routine’s run raised carries its name sealed; a nudge, a main-chat card or an unapproved routine carry none', () => {
  const r = pushRig();
  assert.equal(r.notices.needsYou({ kind: 'chat', chatId: 'run1', cardId: 'a1' }), true);
  assert.deepEqual(r.reqs[0], {
    pair: 'p1',
    kind: 'momoNeedsYou',
    ref: chatRef('p1', 'momo:chat:run1'),
    card: chatRef('p1', 'a1'),
    sealedBody: `sealed:p1:${chatRef('p1', 'momo:chat:run1')}:Morning brief`,
  });
  // the Mac's own banner and the request carry no text: the body is only in the sealed blob
  assert.ok(!JSON.stringify(r.banners).includes('Morning brief'));
  assert.ok(
    !JSON.stringify(r.reqs)
      .replace(/sealed:[^"]*/, '')
      .includes('Morning'),
  );
  // a nudge is in MoMo's main chat; a routine nobody approved; a chat that is no routine's
  for (const chatId of ['main', 'run2', 'gone', 'nobody']) {
    r.notices.needsYou({ kind: 'chat', chatId });
    assert.equal('sealedBody' in r.reqs.at(-1), false, chatId);
  }
  assert.deepEqual(r.sealed, ['Morning brief'], 'nothing else was ever sealed');
});

test('a phone that cannot be given a body (no key yet) is sent the fixed text, and opting out sends none', () => {
  const r = pushRig();
  r.push.onBanner({ kind: 'momo', chatId: 'momo:chat:run1', needs: true });
  assert.equal(r.reqs.length, 1);
  const noKey = createPushRequests({
    pairs: () => ['p1'],
    sink: (x: any) => r.reqs.push(x),
    bodyOf: () => 'Morning brief',
    sealBody: () => null,
  });
  noKey.onBanner({ kind: 'momo', chatId: 'momo:chat:run1', needs: true });
  assert.equal('sealedBody' in r.reqs.at(-1), false);
  // and one built with no sealer at all
  const bare = createPushRequests({ pairs: () => ['p1'], sink: (x: any) => r.reqs.push(x), bodyOf: () => 'Morning brief' });
  bare.onBanner({ kind: 'momo', chatId: 'momo:chat:run1', needs: true });
  assert.equal('sealedBody' in r.reqs.at(-1), false);
  r.state.momo = { notify: { pushBody: false } };
  r.sealed.length = 0;
  r.push.onBanner({ kind: 'momo', chatId: 'momo:chat:run1', needs: true });
  assert.equal('sealedBody' in r.reqs.at(-1), false);
  assert.deepEqual(r.sealed, [], 'opted out: the sealer is never asked');
  // a finished or ordinary chat never asks for a body either
  r.state.momo = { notify: { pushBody: true } };
  r.push.onBanner({ kind: 'approval', chatId: 'momo:chat:run1', needs: true });
  r.push.onBanner({ kind: 'turn', chatId: 'momo:chat:run1', needs: false });
  assert.deepEqual(r.sealed, []);
});

test('a push waiting for the person to leave the Mac is built when it is sent: an opt-out or a rename in between applies', (t) => {
  const clock = useFakeClock(t, 0);
  let idle: number | null = 1000;
  const r = pushRig({ idleMs: () => idle });
  // at the Mac: kept until the person leaves
  r.notices.needsYou({ kind: 'chat', chatId: 'run1' });
  assert.equal(r.reqs.length, 0);
  // meanwhile the routine is renamed, then the person leaves
  r.state.routines.set('r1', { name: 'Evening brief', approved: true });
  idle = 120_000;
  clock.advance(RECHECK_MS);
  assert.equal(r.reqs.length, 1);
  assert.match(r.reqs[0].sealedBody, /Evening brief$/);
  // opted out while waiting
  idle = 1000;
  r.notices.needsYou({ kind: 'chat', chatId: 'run1' });
  r.state.momo = { notify: { pushBody: false } };
  idle = 120_000;
  clock.advance(RECHECK_MS);
  assert.equal(r.reqs.length, 2);
  assert.equal('sealedBody' in r.reqs[1], false);
});

test('the bridge seals through the remote’s title key object and asks the resolver for the notice’s chat', () => {
  const sent: any[] = [];
  const asked: string[] = [];
  const remote: any = {
    devices: { list: () => [{ pairId: 'p1' }] },
    pushTitles: { seal: () => null, sealBody: (pair: string, ref: string, text: string) => `b:${pair}:${text}` },
    pushRequest: (req: any) => (sent.push(req), Promise.resolve('sent')),
  };
  const bridge = createPushBridge({ remote: () => remote, bodyOf: (chatId: string) => (asked.push(chatId), 'Morning brief') });
  bridge.onBanner({ kind: 'momo', chatId: 'momo:chat:run1', needs: true });
  assert.equal(sent[0].sealedBody, 'b:p1:Morning brief');
  assert.deepEqual(asked, ['momo:chat:run1']);
  // a remote with no title object, or none running, sends the fixed text
  remote.pushTitles = null;
  bridge.onBanner({ kind: 'momo', chatId: 'momo:chat:run1', needs: true });
  assert.equal('sealedBody' in sent[1], false);
  const off = createPushBridge({ remote: () => null, bodyOf: () => 'Morning brief' });
  off.onBanner({ kind: 'momo', chatId: 'momo:chat:run1', needs: true });
  assert.equal(sent.length, 2);
});
