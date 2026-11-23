// A browser hand-off's chat line (electron/capabilities/browser/handoffNotes.cjs, userTurn.cjs): "Finish signing in to <site> on your
// Mac" is written when the agent hands a tab over (or asks for a sign-in on the user's Chrome), and marked done by its id when the user
// clicks Done, replies, presses Stop, the chat switches harness, the tab closes or the chat is forgotten; a line the app's last run left
// open is settled at startup. Paired phones following the chat get the same item at once (chromePanelPhones.cjs, remoteItemFeed.cjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { setup as browser, tabOf, drive } from './support/browser-host-kit.ts';
import { withChatNotes } from '../shared/chatNotes.mjs';

const require = createRequire(import.meta.url);
const { noteHandoff, settleStale, onHandoffItem, textOf } = require('../electron/capabilities/browser/handoffNotes.cjs');
const { installUserTurns, askedInChrome } = require('../electron/capabilities/browser/userTurn.cjs');
const { createItemFeed } = require('../electron/harness/remoteItemFeed.cjs');
const { openPhoneItems } = require('../electron/app/chromePanelPhones.cjs');

/** A chat store with the two calls the lines use, and every patch it took. */
function store(ids = ['c']) {
  const records = new Map(ids.map((id) => [id, { id, meta: {} as any }]));
  return {
    records,
    record: (id: string) => records.get(id),
    patchMeta: (id: string, patch: any) => {
      const r = records.get(id);
      if (!r || r.meta.refuse) return false;
      r.meta = { ...r.meta, ...patch };
      return true;
    },
    notes: (id = 'c') => (records.get(id)?.meta.notes ?? []) as any[],
  };
}
const HOLD = { site: 'store.example', reason: 'Sign in to see your orders', credential: true, since: 1 };

test('a line is written once, rewritten in place by its id when it ends, and every change reaches the listeners', () => {
  const chats = store();
  const seen: any[] = [];
  const off = onHandoffItem((chatId: string, item: any) => seen.push([chatId, item]));
  assert.equal(noteHandoff(chats, 'c', 'h1', HOLD, null, 50), true);
  assert.deepEqual(chats.notes(), [
    {
      id: 'h1',
      kind: 'handoff',
      text: 'Finish signing in to store.example on your Mac',
      site: 'store.example',
      reason: 'Sign in to see your orders',
      done: false,
      turnId: null,
      turn: Number.MAX_SAFE_INTEGER,
      at: 50,
    },
  ]);
  assert.equal(noteHandoff(chats, 'c', 'h1', HOLD, 'done', 90), true);
  assert.equal(chats.notes().length, 1);
  assert.deepEqual(
    [chats.notes()[0].done, chats.notes()[0].how, chats.notes()[0].text, chats.notes()[0].at],
    [true, 'done', 'Done on store.example', 50],
  );
  assert.deepEqual(
    seen.map(([c, i]) => [c, i.type, i.kind, i.id, i.site, i.done]),
    [
      ['c', 'statusNote', 'handoff', 'h1', 'store.example', false],
      ['c', 'statusNote', 'handoff', 'h1', 'store.example', true],
    ],
  );
  // an end with no line to end, no store, a chat it doesn't have, or a store that refuses: nothing written, nobody told
  assert.equal(noteHandoff(chats, 'c', 'h2', HOLD, 'closed'), false);
  assert.equal(noteHandoff(null, 'c', 'h3', HOLD), false);
  assert.equal(noteHandoff(chats, 'nope', 'h3', HOLD), false);
  chats.records.get('c')!.meta.refuse = true;
  assert.equal(noteHandoff(chats, 'c', 'h3', HOLD), false);
  assert.equal(seen.length, 2);
  off();
  assert.equal(textOf('a.example', false, null), 'Your turn on a.example on your Mac');
  assert.equal(textOf('a.example', true, 'closed'), 'Hand-off on a.example ended');
});

test('the transcript shows it among the turns with its site, reason and whether it is over', () => {
  const turns = [{ id: 't1', items: [{ id: 'u1', type: 'userMessage' }] }];
  const note = {
    id: 'h1',
    kind: 'handoff',
    text: 'Done on store.example',
    site: 'store.example',
    reason: 'r',
    done: true,
    turnId: null,
    turn: Number.MAX_SAFE_INTEGER,
    at: 1,
  };
  const out = withChatNotes(turns, [note]);
  assert.deepEqual(out[0].items[1], {
    type: 'statusNote',
    id: 'h1',
    kind: 'handoff',
    text: 'Done on store.example',
    site: 'store.example',
    reason: 'r',
    done: true,
  });
});

test('startup settles every line the last run left open (stale: no hold survives a restart); done ones and other notes stay', () => {
  const chats = store(['c', 'd', 'e']);
  chats.records.get('c')!.meta.notes = [
    { id: 'h1', kind: 'handoff', site: 's.example', reason: 'r', done: false, at: 5 },
    { id: 'h2', kind: 'handoff', site: 's.example', reason: 'r', done: true, how: 'done', at: 6 },
    { id: 'n1', kind: 'control', text: 'x' },
  ];
  chats.records.get('e')!.meta = undefined as any;
  // a MoMo chat is not swept (it never hands a browser over), whatever its notes say
  chats.records.get('d')!.meta = { momo: 'memory', notes: [{ id: 'm1', kind: 'handoff', site: 's', reason: 'r', done: false, at: 1 }] };
  assert.equal(settleStale(chats), 1);
  assert.deepEqual(
    chats.notes().map((n) => [n.id, n.done ?? null, n.how ?? null]),
    [
      ['h1', true, 'gone'],
      ['h2', true, 'done'],
      ['n1', null, null],
    ],
  );
  assert.equal(chats.notes('d')[0].done, false);
  assert.equal(settleStale(null), 0);
});

/** A browser host and a chat store wired as main wires them, with a controller whose hooks the test calls. */
function wired(t: any) {
  const h = browser(t);
  const chats = store();
  const controller: any = { state: { get: () => ({}), publish: () => {} }, send: async () => true };
  installUserTurns({ controller, browserTabs: h.tabs, chats });
  const tab = tabOf(h);
  tab.wc.url = 'https://github.com/login';
  return { h, chats, controller, tab };
}

test('a tab handed over writes the line; Done, a reply, Stop, a switch or the tab closing marks that same line done with how', async (t) => {
  const w = wired(t);
  w.h.tabs.requestSignin(w.tab, { reason: 'Sign in', credential: true });
  assert.deepEqual(
    w.chats.notes().map((n) => [n.site, n.done, n.text]),
    [['github.com', false, 'Finish signing in to github.com on your Mac']],
  );
  assert.equal(await w.h.tabs.signinDone('c', null), true);
  assert.deepEqual([w.chats.notes()[0].done, w.chats.notes()[0].how], [true, 'done']);
  // each later hand-off is its own line, ended its own way
  w.h.tabs.requestSignin(w.tab);
  w.controller.beforeDispatch({ chatId: 'c', item: { opts: { human: true } } });
  w.h.tabs.requestSignin(w.tab);
  w.controller.onStopped('c');
  w.h.tabs.requestSignin(w.tab);
  w.controller.state.publish({ chatId: 'c', patch: { pendingSwitch: { to: 'codex' } } });
  w.h.tabs.requestSignin(w.tab);
  w.tab.wc.destroy();
  await drive(t, Promise.resolve());
  assert.deepEqual(
    w.chats.notes().map((n) => [n.done, n.how]),
    [
      [true, 'done'],
      [true, 'replied'],
      [true, 'stopped'],
      [true, 'switched'],
      [true, 'closed'],
    ],
  );
  assert.equal(new Set(w.chats.notes().map((n) => n.id)).size, 5);
});

test('on the user’s Chrome the refused credential hand-off leaves one open line until the user replies; nothing without a route', async (t) => {
  const w = wired(t);
  assert.equal(askedInChrome('c', null), null, 'not the Chrome route');
  assert.equal(w.chats.notes().length, 0);
  assert.equal(askedInChrome('c', 'Your Chrome', 'Sign in to the store'), 'Your Chrome');
  assert.equal(askedInChrome('c', 'Your Chrome'), 'Your Chrome', 'asked again: still the one line');
  assert.deepEqual(
    w.chats.notes().map((n) => [n.site, n.reason, n.done, n.text]),
    [['Your Chrome', 'Sign in to the store', false, 'Finish signing in to Your Chrome on your Mac']],
  );
  w.controller.beforeDispatch({ chatId: 'c', item: { opts: { human: true } } });
  assert.deepEqual([w.chats.notes()[0].done, w.chats.notes()[0].how], [true, 'replied']);
  // a chat the store doesn't have: no line, and nothing left waiting for it
  assert.equal(askedInChrome('gone', 'Your Chrome'), 'Your Chrome');
  w.controller.onStopped('gone');
});

test('paired phones following the chat get the line at once, appended then replaced by its id; none while no transport is attached', () => {
  const events: any[] = [];
  const feed = createItemFeed({
    emit: (e: any) => events.push(e),
    timers: { setTimeout: (fn: () => void) => (fn(), 0), clearTimeout: () => {} },
  });
  feed.appItem('c', { id: 'h1', type: 'statusNote', kind: 'handoff', done: false });
  feed.appItem('c', { id: 'h1', type: 'statusNote', kind: 'handoff', done: true });
  assert.deepEqual(
    events.map((e) => [e.ev, e.turnId, e.live, e.items[0].done]),
    [
      ['items.append', null, true, false],
      ['items.replace', null, true, true],
    ],
  );
  assert.deepEqual(
    feed.snapshot('c').liveItems.map((i: any) => [i.id, i.done]),
    [['h1', true]],
    'one item, in place',
  );
  // the panel's phones subscribe to the lines; nothing is sent while no phone is attached, and a failure there is the phones' own
  const sent: any[] = [];
  let attached = false;
  let fails = false;
  openPhoneItems({
    service: () => {
      if (fails) throw new Error('service gone');
      return { attached, onFeedEvent: (e: any) => sent.push(e) };
    },
    chatOf: (id: string) => id,
    rows: async () => [],
  });
  const chats = store();
  noteHandoff(chats, 'c', 'h9', HOLD);
  attached = true;
  noteHandoff(chats, 'c', 'h9', HOLD, 'done');
  fails = true;
  noteHandoff(chats, 'c', 'h9', HOLD, 'done');
  assert.ok(sent.some((e) => e.ev === 'items.append' && e.items[0].id === 'h9' && e.items[0].done === true));
});

test("a deleted chat's live items leave the phones' feed", async () => {
  const phones = openPhoneItems({
    service: () => ({ attached: true, onFeedEvent: () => undefined }),
    chatOf: (id: string) => id,
    rows: async () => [],
  });
  noteHandoff(store(), 'c', 'h1', HOLD);
  assert.equal((await phones.items('c', 5)).items.length, 1);
  phones.forget('c');
  assert.deepEqual((await phones.items('c', 5)).items, []);
});
