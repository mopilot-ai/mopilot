// electron/capabilities/tools/desktopAccess.cjs: remembered ("Always allow") and saved grants, listing granted apps,
// opening apps, switching displays, and the clipboard tools with the user's clipboard restored at the turn end.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DesktopControl,
  NOTES,
  MAIL,
  TERMINAL,
  SAFARI,
  fakeHelper,
  resolveEntry,
  rig,
  rejects,
  callsOf,
  grantStore,
} from './support/desktop-kit.ts';

/* -- always allowed apps (remembered grants) ------------------------------ */

test('always allow: a remembered app is granted in any chat without a card, at its tier, and named in the result', async () => {
  const g = grantStore();
  try {
    g.store.grant(null, NOTES, 'full', 'always');
    // remembered at full control by the older computer_* card: a browser still gets view only
    g.store.grant(null, SAFARI, 'full', 'always');
    const r = rig({ grants: g.store });
    for (const a of [NOTES, SAFARI]) r.helper.resolved.set(a.name, resolveEntry(a));
    const out = await r.json('desktop_request_access', { apps: ['Notes', 'Safari'], reason: 'r' }, { chatId: 'c7' });
    assert.equal(r.asks.length, 0, 'no card');
    assert.deepEqual(out.granted, [
      { app: 'Notes', bundleId: 'com.apple.Notes', tier: 'full' },
      { app: 'Safari', bundleId: 'com.apple.Safari', tier: 'read' },
    ]);
    assert.deepEqual(out.alwaysAllowed, ['Notes', 'Safari']);
    // the chat keeps them; asking again in the chat names nothing new
    assert.deepEqual(
      [...r.d.session('c7').apps.values()].map((a: any) => [a.name, a.tier]),
      [
        ['Notes', 'full'],
        ['Safari', 'read'],
      ],
    );
    const again = await r.json('desktop_request_access', { apps: ['Notes'], reason: 'r' }, { chatId: 'c7' });
    assert.equal(again.alwaysAllowed, undefined);
    assert.equal(r.asks.length, 0);
    // Remove in Settings: future requests ask again; the chat that already has it keeps it
    g.store.revoke(null, 'com.apple.Notes');
    assert.equal(r.d.granted('c7').get('com.apple.notes').tier, 'full');
    r.answers.computerAccessSet = { decision: 'deny' };
    const other = await r.json('desktop_request_access', { apps: ['Notes'], reason: 'r' }, { chatId: 'c8' });
    assert.equal(r.asks.length, 1, 'a new chat asks again');
    assert.deepEqual(other.granted, []);
    assert.equal(other.alwaysAllowed, undefined);
  } finally {
    g.done();
  }
});

test('always allow: an app the chat has at a lower tier is raised by the remembered grant; one it has already is not named', async () => {
  const g = grantStore();
  try {
    g.store.grant(null, NOTES, 'full', 'always');
    const r = rig({ grants: g.store });
    r.helper.resolved.set('Notes', resolveEntry(NOTES));
    r.d.session('c1').apps.set('com.apple.notes', { bundleId: 'com.apple.Notes', name: 'Notes', tier: 'click' });
    const raised = await r.json('desktop_request_access', { apps: ['Notes'], reason: 'r' });
    assert.deepEqual(raised.alwaysAllowed, ['Notes']);
    assert.equal(r.d.session('c1').apps.get('com.apple.notes').tier, 'full');
    r.d.session('c2').apps.set('com.apple.notes', { bundleId: 'com.apple.Notes', name: 'Notes', tier: 'full' });
    const own = await r.json('desktop_request_access', { apps: ['Notes'], reason: 'r' }, { chatId: 'c2' });
    assert.equal(own.alwaysAllowed, undefined, "the chat's own grant covers it");
    assert.equal(r.asks.length, 0);
  } finally {
    g.done();
  }
});

test('always allow: the deny list wins over a remembered app', async () => {
  const g = grantStore();
  try {
    g.store.grant(null, NOTES, 'full', 'always');
    g.store.setDeny(['com.apple.Notes']);
    const r = rig({ grants: g.store });
    r.helper.resolved.set('Notes', resolveEntry(NOTES));
    const out = await r.json('desktop_request_access', { apps: ['Notes'], reason: 'r' });
    assert.deepEqual(out.granted, []);
    assert.deepEqual(
      out.denied.map((d: any) => d.reason),
      ['blocked in Settings → Computer use'],
    );
    assert.equal(out.alwaysAllowed, undefined);
    assert.equal(r.d.granted('c1').size, 0);
  } finally {
    g.done();
  }
});

test("always allow on the card: the checked apps are remembered at their tiers; the extras and screen control stay the chat's", async () => {
  const g = grantStore();
  try {
    const r = rig({ grants: g.store });
    for (const a of [NOTES, TERMINAL, SAFARI]) r.helper.resolved.set(a.name, resolveEntry(a));
    r.answers.computerAccessSet = {
      decision: 'allow',
      apps: ['com.apple.notes', 'com.apple.terminal', 'com.apple.safari'],
      remember: true,
      clipboardRead: true,
      systemKeyCombos: true,
      takeover: true,
    };
    r.helper.resolved.set('Mail', resolveEntry(MAIL));
    // Mail left unchecked: not granted, not remembered
    const out = await r.json('desktop_request_access', {
      apps: ['Notes', 'Terminal', 'Safari', 'Mail'],
      reason: 'r',
      clipboardRead: true,
      systemKeyCombos: true,
    });
    assert.equal(r.asks.length, 1);
    assert.deepEqual(
      out.granted.map((a: any) => a.app),
      ['Notes', 'Terminal', 'Safari'],
    );
    assert.equal(out.alwaysAllowed, undefined, 'the user answered a card');
    assert.equal(out.clipboardRead, true);
    assert.equal(out.screenControl, false, 'screen control is asked just in time, never on this card');
    assert.deepEqual(
      g.store.global().map((x: any) => [x.name, x.level]),
      [
        ['Notes', 'full'],
        ['Terminal', 'click'],
        ['Safari', 'view'],
      ],
    );
    // another chat: the apps come without a card, at the same tiers; the extras and control do not
    const c2 = await r.json('desktop_request_access', { apps: ['Notes', 'Terminal', 'Safari'], reason: 'r' }, { chatId: 'c2' });
    assert.equal(r.asks.length, 1);
    assert.deepEqual(
      c2.granted.map((a: any) => [a.app, a.tier]),
      [
        ['Notes', 'full'],
        ['Terminal', 'click'],
        ['Safari', 'read'],
      ],
    );
    assert.deepEqual(c2.alwaysAllowed, ['Notes', 'Terminal', 'Safari']);
    assert.deepEqual([c2.clipboardRead, c2.systemKeyCombos, c2.screenControl], [false, false, false]);
    // the clipboard still asks in that chat, and the card offers no app (all remembered)
    r.answers.computerAccessSet = { decision: 'allow', remember: true };
    const clip = await r.json('desktop_request_access', { apps: ['Notes'], reason: 'r', clipboardWrite: true }, { chatId: 'c2' });
    assert.equal(r.asks.length, 2);
    assert.deepEqual(r.asks[1].params.apps, []);
    assert.equal(r.asks[1].params.clipboardWrite, true);
    assert.equal(clip.clipboardWrite, true);
    assert.equal(r.d.session('c3').clipboardWrite, false, 'never remembered');
    assert.equal(g.store.global().length, 3);
  } finally {
    g.done();
  }
});

test('allow in this chat: saved with the chat (Settings lists it), not for other chats; Remove takes it back; a failed save keeps the session', async () => {
  const g = grantStore();
  try {
    const r = rig({ grants: g.store });
    for (const a of [NOTES, SAFARI]) r.helper.resolved.set(a.name, resolveEntry(a));
    r.answers.computerAccessSet = { decision: 'allow' };
    await r.json('desktop_request_access', { apps: ['Notes', 'Safari'], reason: 'r' }, { chatId: 'c1' });
    assert.deepEqual(
      g.store.chat('c1').map((x: any) => [x.name, x.level]),
      [
        ['Notes', 'full'],
        ['Safari', 'view'],
      ],
    );
    assert.deepEqual(g.store.global(), [], 'not remembered for every chat');
    assert.deepEqual(g.store.chat('c2'), []);
    // a new session of the same chat (after a restart) has them without a card
    r.d.sessions.delete('c1');
    const again = await r.json('desktop_request_access', { apps: ['Notes'], reason: 'r' }, { chatId: 'c1' });
    assert.equal(r.asks.length, 1, 'no second card');
    assert.deepEqual(again.granted, [{ app: 'Notes', bundleId: 'com.apple.Notes', tier: 'full' }]);
    // Remove in Settings: the saved grant and the session's both go
    assert.equal(r.d.revoke('c1', NOTES.bundleId), true);
    assert.equal(r.d.granted('c1').has('com.apple.notes'), false);
    // a denial saves nothing
    r.answers.computerAccessSet = { decision: 'deny' };
    await r.json('desktop_request_access', { apps: ['Notes'], reason: 'r' }, { chatId: 'c3' });
    assert.deepEqual(g.store.chat('c3'), []);
  } finally {
    g.done();
  }
  // a store that can't save: the chat still gets the app for this session
  const r = rig({
    grants: {
      forChat: () => [],
      global: () => [],
      deny: () => [],
      revoke: () => false,
      grant: () => {
        throw new Error('disk full');
      },
    },
  });
  r.helper.resolved.set('Notes', resolveEntry(NOTES));
  r.answers.computerAccessSet = { decision: 'allow' };
  const out = await r.json('desktop_request_access', { apps: ['Notes'], reason: 'r' }, { chatId: 'c4' });
  assert.deepEqual(
    out.granted.map((a: any) => a.app),
    ['Notes'],
  );
  assert.equal(r.d.revoke('c4', 'com.apple.Notes'), true, 'dropped from the session');
});

test('always allow on the card: a denial remembers nothing; a store without a global list still works', async () => {
  const g = grantStore();
  try {
    const r = rig({ grants: g.store });
    r.helper.resolved.set('Notes', resolveEntry(NOTES));
    r.answers.computerAccessSet = { decision: 'deny', remember: true };
    await r.json('desktop_request_access', { apps: ['Notes'], reason: 'r' });
    assert.deepEqual(g.store.global(), []);
  } finally {
    g.done();
  }
  // the default rig's store has no global list or grant(): the chat still gets the app
  const r = rig();
  r.helper.resolved.set('Notes', resolveEntry(NOTES));
  r.answers.computerAccessSet = { decision: 'allow', remember: true };
  const out = await r.json('desktop_request_access', { apps: ['Notes'], reason: 'r' });
  assert.deepEqual(
    out.granted.map((a: any) => a.app),
    ['Notes'],
  );
  // no store at all
  const bare = new DesktopControl({
    helper: fakeHelper(),
    cu: { unattended: async () => null, harness: () => 'claude', resumeAfterCard: async () => {} },
    grants: null,
    broker: { ask: async () => ({ decision: 'allow', remember: true }) },
    hostPids: async () => new Set(),
  });
  (bare as any).helper.resolved.set('Notes', resolveEntry(NOTES));
  const res = JSON.parse((await bare.requestAccess('c1', { apps: ['Notes'], reason: 'r' }, {}))[0].text);
  assert.deepEqual(
    res.granted.map((a: any) => a.app),
    ['Notes'],
  );
});

/* -- grants ------------------------------------------------------------ */
test("granted(): saved grants from Settings, capped by their kind's tier; the stronger grant wins; blocked apps drop out", async () => {
  const saved = [
    { bundleId: 'com.apple.Safari', level: 'full', name: 'Safari' },
    { bundleId: 'com.apple.Terminal', level: 'view' },
    { bundleId: 'com.apple.Terminal', level: 'full', name: 'Terminal' },
    { bundleId: 'com.apple.Terminal', level: 'view', name: 'Terminal' },
    { bundleId: 'com.apple.Notes', level: 'click', name: 'Notes' },
    { bundleId: 'com.apple.mail', level: 'bogus', name: 'Mail' },
    { bundleId: 'ai.mopilot.code', level: 'full', name: 'MoPilot' },
    { bundleId: 'com.example.blocked', level: 'full', name: 'Blocked' },
  ];
  const r = rig({ saved, deny: ['com.example.blocked'] });
  const g = r.d.granted('c1');
  assert.deepEqual(
    [...g.values()].map((x: any) => [x.name, x.tier, x.saved]),
    [
      ['Safari', 'read', true],
      ['Terminal', 'click', true],
      ['Notes', 'click', true],
    ],
  );
  // a chat grant at a higher tier wins over the saved one; a lower one does not
  r.d.session('c1').apps.set('com.apple.notes', { bundleId: 'com.apple.Notes', name: 'Notes', tier: 'full' });
  r.d.session('c1').apps.set('com.apple.safari', { bundleId: 'com.apple.Safari', name: 'Safari', tier: 'read' });
  // added to the deny list after it was granted
  r.d.session('c1').apps.set('com.example.blocked', { bundleId: 'com.example.blocked', name: 'Blocked', tier: 'full' });
  const g2 = r.d.granted('c1');
  assert.equal(g2.get('com.apple.notes').tier, 'full');
  assert.equal(g2.get('com.apple.safari').saved, true);
  assert.equal(g2.has('com.example.blocked'), false);
  // no grant store at all
  const bare = new DesktopControl({ helper: fakeHelper(), cu: {}, grants: null, broker: null });
  assert.equal(bare.granted('c1').size, 0);
});

test('list_granted_applications: tiers, running and frontmost; extras; a helper that is down', async () => {
  const r = rig();
  await r.grant([NOTES, MAIL]);
  r.helper.apps = [{ bundleId: 'COM.APPLE.NOTES', frontmost: true }];
  const out = await r.json('desktop_list_granted_applications');
  assert.deepEqual(out.apps, [
    { app: 'Notes', bundleId: 'com.apple.Notes', tier: 'full', running: true, frontmost: true },
    { app: 'Mail', bundleId: 'com.apple.mail', tier: 'full', running: false, frontmost: false },
  ]);
  assert.equal(out.clipboardRead, false);
  r.helper.listApps = async () => ({});
  assert.equal((await r.json('desktop_list_granted_applications')).apps[0].running, false);
  r.helper.fail.start = new Error('down');
  assert.equal((await r.json('desktop_list_granted_applications')).apps[0].running, false);
});

test('open_application: only a granted app, found by bundle id or name; the record says whether it came forward', async () => {
  const r = rig();
  await rejects(r.call('desktop_open_application', { app: 'Notes' }), 'denied', /isn't granted in this chat/);
  await r.grant([NOTES, MAIL]);
  const byId = await r.json('desktop_open_application', { app: 'com.apple.mail' });
  assert.deepEqual(byId, { action: 'open_application', effect: 'confirmed', route: 'global', app: 'Mail', tier: 'full' });
  assert.deepEqual(callsOf(r, 'openApp').at(-1).args, ['com.apple.mail', { bundleIds: ['com.apple.mail'] }]);
  r.helper.openFront = false;
  const byName = await r.json('desktop_open_application', { app: 'notes' });
  assert.equal(byName.effect, 'unverifiable');
  assert.match(byName.reason, /did not come to the front/);
  assert.equal((await r.json('desktop_open_application', { app: 'Mai' })).app, 'Mail', 'a partial name');
  // no app named: nothing is opened (an empty name once matched every granted app)
  await rejects(r.call('desktop_open_application', {}), 'denied');
  await rejects(r.call('desktop_open_application', { app: '  ' }), 'denied');
  assert.equal(r.callsOf('openApp').length, 3);
});

test('switch_display: lists displays, picks one by id or number, and drops the old screenshot frame', async () => {
  const r = rig();
  await r.ready();
  const list = await r.json('desktop_switch_display', {});
  assert.deepEqual(
    list.displays.map((d: any) => [d.number, d.id, d.current, d.points]),
    [
      [1, 1, true, '2000x1000'],
      [2, 2, false, '1000x800'],
    ],
  );
  assert.deepEqual((await r.json('desktop_switch_display', { display: '' })).displays.length, 2);
  assert.match(await r.text('desktop_switch_display', { display: 2 }), /Screenshots now show display 2 \(Side\)/);
  assert.equal(r.d.session('c1').geom, null);
  await rejects(r.call('desktop_left_click', { coordinate: [1, 1] }), 'bad_args', /Take a desktop_screenshot first/);
  assert.match(await r.text('desktop_switch_display', { display: '1' }), /display 1 \(1\)/);
  await rejects(r.call('desktop_switch_display', { display: 9 }), 'bad_args', /No display 9/);
  r.helper.listDisplays = async () => ({});
  assert.deepEqual((await r.json('desktop_switch_display', { display: null })).displays, []);
});

test('clipboard: reading and writing need their own grants and a clipboard', async () => {
  const r = rig();
  await rejects(r.call('desktop_read_clipboard'), 'denied', /clipboardRead/);
  await rejects(r.call('desktop_write_clipboard', { text: 'x' }), 'denied', /clipboardWrite/);
  r.helper.resolved.set('Notes', resolveEntry(NOTES));
  await r.call('desktop_request_access', { apps: ['Notes'], reason: 'r', clipboardRead: true, clipboardWrite: true });
  assert.equal(await r.text('desktop_read_clipboard'), 'copied');
  assert.deepEqual(await r.json('desktop_write_clipboard', { text: 'new' }), {
    action: 'write_clipboard',
    effect: 'confirmed',
    route: 'global',
  });
  assert.equal(r.clip(), 'new');
  await r.call('desktop_write_clipboard', {});
  assert.equal(r.clip(), '');
  assert.equal(await r.text('desktop_read_clipboard'), '');
  const none = rig({ clipboard: false });
  none.helper.resolved.set('Notes', resolveEntry(NOTES));
  await none.call('desktop_request_access', { apps: ['Notes'], reason: 'r', clipboardRead: true, clipboardWrite: true });
  await rejects(none.call('desktop_read_clipboard'), 'unavailable');
  await rejects(none.call('desktop_write_clipboard', { text: 'x' }), 'unavailable');
});

/* -- the user's clipboard ------------------------------------------------ */
test('clipboard: what the tools write is undone at the turn end; something the user copied since stays', async () => {
  const r = rig();
  await r.grant([NOTES]);
  r.d.session('c1').clipboardWrite = true;
  r.setClip('mine');
  await r.call('desktop_write_clipboard', { text: 'one' });
  await r.call('desktop_write_clipboard', { text: 'two' });
  assert.equal(r.callsOf('saveClipboard').length, 1);
  assert.equal(r.clip(), 'two');
  await r.d.turnEnded('c1');
  assert.deepEqual(r.callsOf('restoreClipboard')[0].args, [true]);
  assert.equal(r.d.clip, null);
  // the user copied something meanwhile: theirs stays, the saved one is dropped
  await r.call('desktop_write_clipboard', { text: 'three' });
  r.setClip('theirs');
  await r.d.turnEnded('c1');
  assert.deepEqual(r.callsOf('restoreClipboard')[1].args, [false]);
  // a helper that can't keep it: the text is kept here and written back
  r.helper.fail.saveClipboard = Object.assign(new Error('unknown method'), { reason: 'method_not_found' });
  r.setClip('mine');
  await r.call('desktop_write_clipboard', { text: 'four' });
  await r.d.turnEnded('c1');
  assert.equal(r.clip(), 'mine');
  r.setClip('');
  await r.call('desktop_write_clipboard', { text: 'five' });
  r.setClip('copied by the user');
  await r.d.turnEnded('c1');
  assert.equal(r.clip(), 'copied by the user');
  // used by two chats: it comes back when the last one's turn ends
  r.setClip('mine');
  await r.grant([NOTES], 'c2');
  r.d.session('c2').clipboardWrite = true;
  await r.call('desktop_write_clipboard', { text: 'six' });
  await r.call('desktop_write_clipboard', { text: 'seven' }, { chatId: 'c2' });
  await r.d.turnEnded('c1');
  assert.equal(r.clip(), 'seven');
  await r.d.turnEnded('c3');
  await r.d.forget('c2');
  assert.equal(r.clip(), 'mine');
  assert.ok(r.ended.includes('c2'), 'forget lets go of the clipboard too');
});

test('clipboard: a helper that fails to put it back still lets go of it, and the next write keeps it again', async () => {
  const r = rig();
  await r.grant([NOTES]);
  r.d.session('c1').clipboardWrite = true;
  await r.call('desktop_write_clipboard', { text: 'one' });
  r.helper.fail.restoreClipboard = new Error('the helper stopped');
  await r.d.turnEnded('c1');
  assert.equal(r.callsOf('restoreClipboard').length, 1);
  assert.equal(r.d.clip, null);
  assert.deepEqual(r.ended, ['c1']);
  await r.call('desktop_write_clipboard', { text: 'two' });
  assert.equal(r.callsOf('saveClipboard').length, 2);
});
