// Live visibility and notifications for computer control, on every harness: the
// chat's control strip state (appVisibility.cjs) over a session store, the "<Agent> is using your computer" /
// "<Agent> is done using your computer" notifications (controlNotifications.cjs) through the app's real Notifier
// (electron/platform/notify.cjs), and the session's appControl default (electron/session/state.cjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { AppVisibility, THUMB_EVERY_MS } = require('../electron/capabilities/appVisibility.cjs');
const { ControlNotifications } = require('../electron/capabilities/controlNotifications.cjs');
const { Notifier, KINDS, mergedTitle } = require('../electron/platform/notify.cjs');
const { SessionStore } = require('../electron/session/state.cjs');
const { agentLabel } = require('../electron/capabilities/computerUse.cjs');

const WIN = { x: 100, y: 50, width: 500, height: 400 };

/* -- the control strip state --------------------------------------------- */
function sessions() {
  const store = new SessionStore();
  const patches: any[] = [];
  return { store, patches, get: (id: string) => store.get(id), patch: (id: string, p: any) => (patches.push([id, p]), store.patch(id, p)) };
}

test('the session starts with no background control', () => {
  assert.equal(new SessionStore().get('x').appControl, null);
});

/** A cursor that records what AppVisibility asks of it; `finishes` is what finish() answers (an approach was showing). */
function fakeCursor(log: any[], onHide: () => void = () => {}, finishes = () => true) {
  return {
    show: (a: any) => (log.push(['show', a]), true),
    approach: (a: any) => (log.push(['approach', a]), Promise.resolve()),
    finish: (a: any) => (log.push(['finish', a]), finishes()),
    cancel: (c: string) => log.push(['cancel', c]),
    forgetPositions: (c: string) => log.push(['forgetPositions', c]),
    forget: (c: string) => log.push(['forget', c]),
    hide: onHide,
  };
}

test('AppVisibility: the strip lists the apps a chat holds, the latest first, with the window title and a thumbnail', () => {
  const s = sessions();
  const shown: any[] = [];
  let now = 1000;
  const v = new AppVisibility({ sessions: s, cursor: fakeCursor(shown), now: () => now });
  assert.equal(v.thumbEveryMs, THUMB_EVERY_MS);
  const notes = { bundleId: 'com.apple.Notes', name: 'Notes' };
  const token = {};
  // a screenshot before the chat acts there: remembered, not shown yet (no lock, no strip)
  v.acted('c1', {
    app: notes,
    windowId: 5,
    title: 'Doc',
    bounds: WIN,
    state: 'visible',
    action: 'screenshot',
    points: [],
    effect: 'confirmed',
    thumb: 'AAA',
  });
  assert.equal(s.store.get('c1').appControl, null);
  assert.equal(shown.length, 0, 'a screenshot has no point');
  // the chat takes Notes: the strip shows it with what was seen
  v.locked('c1', notes, true);
  assert.deepEqual(s.store.get('c1').appControl.apps, [
    {
      bundleId: 'com.apple.Notes',
      app: 'Notes',
      title: 'Doc',
      windowId: 5,
      thumbnail: 'data:image/jpeg;base64,AAA',
      at: 1000,
      takenOver: false,
    },
  ]);
  // a click: the cursor goes there; no new thumbnail keeps the old one
  now = 1500;
  v.acted('c1', {
    app: notes,
    windowId: null,
    title: null,
    bounds: WIN,
    state: 'visible',
    action: 'click',
    points: [{ x: 1, y: 2 }],
    effect: 'no_change',
    thumb: null,
    token,
  });
  assert.deepEqual(shown, [['finish', { chatId: 'c1', token }]]);
  assert.deepEqual(
    [
      s.store.get('c1').appControl.apps[0].thumbnail,
      s.store.get('c1').appControl.apps[0].title,
      s.store.get('c1').appControl.apps[0].windowId,
      s.store.get('c1').appControl.apps[0].at,
    ],
    ['data:image/jpeg;base64,AAA', 'Doc', 5, 1500],
  );
  // only a window on this Space shows the cursor; an unknown state counts as visible
  v.acted('c1', { app: notes, bounds: WIN, state: 'minimized', action: 'click', points: [{ x: 1, y: 2 }], thumb: 'BBB' });
  v.acted('c1', { app: notes, bounds: null, state: 'visible', action: 'click', points: [{ x: 1, y: 2 }] });
  v.acted('c1', { app: notes, bounds: WIN, action: 'key', points: [{ x: 3, y: 4 }] });
  assert.equal(shown.length, 2);
  assert.equal(s.store.get('c1').appControl.apps[0].thumbnail, 'data:image/jpeg;base64,BBB');
  // a second app comes first while it is the one acted in
  const mail = { bundleId: 'com.apple.mail', name: 'Mail' };
  now = 2000;
  v.locked('c1', mail, true);
  assert.deepEqual(
    s.store.get('c1').appControl.apps.map((a: any) => a.app),
    ['Mail', 'Notes'],
  );
  now = 3000;
  v.acted('c1', { app: notes, bounds: WIN, state: 'visible', action: 'scroll', points: [] });
  assert.deepEqual(
    s.store.get('c1').appControl.apps.map((a: any) => a.app),
    ['Notes', 'Mail'],
  );
  // taken over and handed back; an app the chat doesn't hold changes nothing; taking over ends the cursor
  v.takenOver('c1', 'COM.APPLE.NOTES', true);
  assert.deepEqual(shown.at(-1), ['cancel', 'c1']);
  assert.equal(s.store.get('c1').appControl.apps[0].takenOver, true);
  v.takenOver('c1', 'com.apple.Notes', false);
  assert.equal(shown.filter((x) => x[0] === 'cancel').length, 1, 'handing back keeps the cursor as it is');
  assert.equal(s.store.get('c1').appControl.apps[0].takenOver, false);
  const n = s.patches.length;
  v.takenOver('c1', 'com.other', true);
  v.takenOver('c2', 'com.apple.Notes', true);
  assert.equal(s.patches.length, n);
  // let go: one at a time, then the strip goes and the cursor hides
  v.locked('c1', notes, false);
  assert.deepEqual(
    s.store.get('c1').appControl.apps.map((a: any) => a.app),
    ['Mail'],
  );
  v.locked('c1', mail, false);
  assert.equal(s.store.get('c1').appControl, null);
  assert.deepEqual(shown.at(-1), ['cancel', 'c1'], "only the chat's own cursor goes: another chat may be showing its own");
  // taking Notes again starts from nothing seen
  v.locked('c1', notes, true);
  assert.deepEqual([s.store.get('c1').appControl.apps[0].title, s.store.get('c1').appControl.apps[0].thumbnail], [null, null]);
});

test('AppVisibility: a thumbnail at most once a second per chat; forget drops what was seen; no cursor is fine', () => {
  const s = sessions();
  let now = 0;
  const v = new AppVisibility({ sessions: s, now: () => now, thumbEveryMs: 1000 });
  assert.equal(v.thumbnailDue('c1'), true);
  assert.equal(v.thumbnailDue('c1'), false);
  assert.equal(v.thumbnailDue('c2'), true);
  now = 999;
  assert.equal(v.thumbnailDue('c1'), false);
  now = 1000;
  assert.equal(v.thumbnailDue('c1'), true);
  const notes = { bundleId: 'com.apple.Notes', name: 'Notes' };
  v.acted('c1', { app: notes, bounds: WIN, state: 'visible', action: 'click', points: [{ x: 1, y: 1 }], thumb: 'T' });
  v.acted('c2', { app: notes, title: 'Other', action: 'screenshot', points: [] });
  v.locked('c1', notes, true);
  v.locked('c1', notes, false);
  assert.equal(v.thumbnailDue('c1'), true, 'the strip went: the next thumbnail is due at once');
  v.forget('c2');
  v.locked('c2', notes, true);
  assert.equal(s.store.get('c2').appControl.apps[0].title, null);
  // the default clock
  assert.equal(typeof new AppVisibility({ sessions: s }).now(), 'number');
});

/* -- notifications -------------------------------------------------------- */
test("ControlNotifications: once per chat and app; the whole screen posts no banner (it would take the agent's clicks), the background names the chat; done only after a start", () => {
  const sent: any[] = [];
  let viewing = false;
  const n = new ControlNotifications({
    notify: (kind: string, chatId: string, opts: any) => (sent.push([kind, chatId, opts]), { shown: true }),
    agentName: (id: string) => (id === 'c1' ? 'Claude' : ''),
    chatName: (id: string) => (id === 'c1' ? 'Trip notes' : null),
    viewing: () => viewing,
  });
  assert.equal(n.started('c1', 'Notes'), null, 'the whole screen: no banner');
  assert.equal(sent.length, 0);
  assert.equal(n.started('c1', 'Notes', { background: true }), null, 'already noted');
  viewing = true;
  n.started('c1', 'Mail', { background: true });
  assert.deepEqual(sent[0][2], {
    title: 'Claude is using your computer',
    body: 'Trip notes',
    chatTitle: 'Trip notes',
    group: 'using',
    viewing: true,
  });
  // an agent without a name, a chat without one
  n.started('c2', 'Notes', { background: true });
  assert.deepEqual(
    [sent[1][2].title, sent[1][2].body, sent[1][2].chatTitle],
    ['The agent is using your computer', '', 'The agent is using your computer'],
  );
  assert.equal(n.started('c2', ''), null);
  // done, after a whole-screen hold as after a background one
  assert.equal(n.finished('c1', 'Keynote'), null, 'never started');
  n.finished('c1', 'Notes');
  assert.deepEqual(sent[2][2], {
    title: 'Claude is done using your computer',
    body: 'Trip notes',
    chatTitle: 'Trip notes',
    group: 'done',
    viewing: true,
  });
  assert.equal(n.finished('c1', 'Notes'), null);
  n.finished('c2', 'Notes');
  assert.deepEqual([sent[3][2].body, sent[3][2].chatTitle], ['', 'The agent is done using your computer']);
  // a notifier that shows nothing; the defaults
  const quiet = new ControlNotifications({ notify: () => undefined, agentName: () => 'Codex' });
  assert.equal(quiet.started('c', 'Notes'), null);
  assert.equal(quiet.finished('c', 'Notes'), null);
});

test("agentLabel: notifications name the chat's agent on every harness", () => {
  const acp = (id: string) => (({ goose: 'Goose' }) as any)[id];
  assert.equal(agentLabel('claude', acp), 'Claude');
  assert.equal(agentLabel('codex', acp), 'Codex');
  assert.equal(agentLabel('acp:goose', acp), 'Goose');
  assert.equal(agentLabel('acp:unknown', acp), null);
  assert.equal(agentLabel('other', acp), null);
  assert.equal(agentLabel(undefined, acp), null);
});

test('the notifier: computer control is its own kind, follows the setting and its switch, and "using" and "done" merge apart', () => {
  assert.ok(KINDS.includes('computer'));
  assert.equal(mergedTitle('computer', false, 2, 'using'), '2 chats are using apps');
  assert.equal(mergedTitle('computer', false, 3, 'done'), '3 chats are done using apps');
  assert.equal(mergedTitle('computer', false, 2), '2 chats are using apps');
  const shown: any[] = [];
  let mode = 'always';
  let kinds: any = {};
  let t = 0;
  const notifier = new Notifier({
    show: (x: any) => (shown.push(x), { close() {} }),
    getMode: () => mode,
    getKinds: () => kinds,
    isFocused: () => true,
    now: () => t,
  });
  const n = new ControlNotifications({
    notify: (k: string, c: string, o: any) => notifier.notify(k, c, o),
    agentName: () => 'Claude',
    chatName: (c: string) => c.toUpperCase(),
  });
  n.started('a', 'Notes', { background: true });
  n.started('b', 'Mail', { background: true });
  assert.deepEqual(
    shown.map((x) => x.title),
    ['Claude is using your computer', '2 chats are using apps'],
  );
  t += 1000;
  n.finished('a', 'Notes');
  assert.equal(shown.at(-2).title, 'Claude is using your computer', 'the remaining using chat keeps its own message');
  assert.equal(shown.at(-1).title, 'Claude is done using your computer', '"done" doesn\'t merge into "using"');
  n.finished('b', 'Mail');
  assert.equal(shown.at(-1).title, '2 chats are done using apps');
  // the Computer use switch off, or Never: nothing
  kinds = { computer: false };
  n.started('c', 'Notes');
  mode = 'never';
  kinds = {};
  n.started('d', 'Notes');
  assert.equal(shown.length, 5);
  // "When unfocused" with the chat in front: nothing either
  mode = 'unfocused';
  const v = new ControlNotifications({
    notify: (k: string, c: string, o: any) => notifier.notify(k, c, o),
    agentName: () => 'Claude',
    viewing: () => true,
  });
  assert.equal(v.started('e', 'Notes'), null);
});

test('control notifications keep opaque chat and app pairs separate', () => {
  const shown: any[] = [];
  const n = new ControlNotifications({ notify: (...args: any[]) => shown.push(args), agentName: () => 'Agent' });
  n.started('opaque', 'part\0Notes', { background: true });
  n.started('opaque\0part', 'Notes', { background: true });
  assert.equal(shown.length, 2);
  n.finished('opaque', 'part\0Notes');
  n.finished('opaque\0part', 'Notes');
  assert.equal(shown.length, 4);
});

test('app visibility forgets the exact chat and retains another chat thumbnail', () => {
  const state = new Map<string, any>();
  const sessions = { get: (chat: string) => state.get(chat), patch: (chat: string, patch: any) => state.set(chat, patch) };
  const v = new AppVisibility({ sessions });
  const app = { bundleId: 'com.apple.Notes', name: 'Notes' };
  v.acted('opaque', { app, thumb: 'first' });
  v.acted('opaque\0part', { app, thumb: 'second' });
  v.forget('opaque');
  v.locked('opaque\0part', app, true);
  assert.equal(state.get('opaque\0part').appControl.apps[0].thumbnail, 'data:image/jpeg;base64,second');
  v.locked('opaque', app, true);
  assert.equal(state.get('opaque').appControl.apps[0].thumbnail, null);
});

test('AppVisibility: an input action approaches before it runs and is finished when it reports; the same for every harness', async () => {
  const log: any[] = [];
  let showing = true;
  const v = new AppVisibility({
    sessions: sessions(),
    cursor: fakeCursor(
      log,
      () => {},
      () => showing,
    ),
  });
  const notes = { bundleId: 'com.apple.Notes', name: 'Notes' };
  const info = { app: notes, bounds: WIN, state: 'visible', action: 'click', points: [{ x: 1, y: 2 }] };
  // chats on any harness reach the cursor the same way: only the chat id differs
  for (const chatId of ['claude-chat', 'codex-chat', 'acp-chat', 'switched-chat']) {
    const token = {};
    await v.approach(chatId, { ...info, token });
    v.acted(chatId, { ...info, token, effect: 'confirmed' });
  }
  assert.deepEqual(
    log.map((x) => [x[0], x[1].chatId, x[1].kind ?? 'done']),
    ['claude-chat', 'codex-chat', 'acp-chat', 'switched-chat'].flatMap((c) => [
      ['approach', c, 'click'],
      ['finish', c, 'done'],
    ]),
  );
  assert.equal(log[0][1].bundleId, 'com.apple.Notes');
  assert.deepEqual(log[0][1].points, [{ x: 1, y: 2 }]);
  // a window off this Space, no point, no bounds or no cursor: nothing is shown and the input is not held
  log.length = 0;
  for (const bad of [{ state: 'minimized' }, { points: [] }, { bounds: null }, { points: undefined }])
    await v.approach('c1', { ...info, ...bad });
  await new AppVisibility({ sessions: sessions() }).approach('c1', info);
  assert.equal(log.length, 0);
  // an unknown state counts as visible
  await v.approach('c1', { ...info, state: undefined });
  assert.equal(log.length, 1);
  // a drag is drawn when it reports (its path), not before, and once: its second report (a retry) draws nothing
  log.length = 0;
  const drag = {
    ...info,
    action: 'drag',
    points: [
      { x: 1, y: 2 },
      { x: 5, y: 6 },
    ],
    token: {},
  };
  await v.approach('c1', drag);
  assert.equal(log.length, 0);
  showing = false;
  v.acted('c1', drag);
  v.acted('c1', drag);
  assert.deepEqual(
    log.map((x) => x[0]),
    ['finish', 'show'],
  );
  assert.deepEqual(log[1][1], { chatId: 'c1', bundleId: 'com.apple.Notes', bounds: WIN, points: drag.points });
  // an action that reported twice (an escalation) finishes the cursor once, and a cursor already finished is not replayed
  log.length = 0;
  showing = true;
  const twice = { ...info, token: {} };
  v.acted('c1', { ...twice, effect: 'no_change' });
  v.acted('c1', { ...twice, effect: 'confirmed' });
  assert.deepEqual(
    log.map((x) => [x[0], 'confirmed' in x[1]]),
    [['finish', false]],
  );
  // an action that ran with no approach (inside a helper batch, no token): shown after the fact, never finished
  log.length = 0;
  v.acted('c1', { ...info, effect: 'confirmed' });
  assert.deepEqual(
    log.map((x) => x[0]),
    ['approach'],
  );
  assert.equal((log as any)[0][1].kind, 'move');
  log.length = 0;
  v.acted('c1', { ...info, action: 'drag', points: [{ x: 1, y: 2 }] });
  assert.deepEqual(
    log.map((x) => x[0]),
    ['approach'],
  );
  // Stop, Esc or the end of the turn: the cursor goes; a turn end also forgets where it was
  v.interrupted('c1');
  assert.deepEqual(log.at(-1), ['cancel', 'c1']);
  v.turnEnded('c1');
  assert.deepEqual(log.at(-1), ['forgetPositions', 'c1']);
  new AppVisibility({ sessions: sessions() }).interrupted('c1');
  new AppVisibility({ sessions: sessions() }).turnEnded('c1');
  // an archived chat forgets its cursor
  v.forget('c1');
  assert.deepEqual(log.at(-1), ['forget', 'c1']);
});
