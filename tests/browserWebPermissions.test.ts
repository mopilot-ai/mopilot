// Web permissions in the built-in browser's partitions (electron/capabilities/browser/webPermissions.cjs):
// deny by default, agent-driven pages denied with a note, user-driven pages asked on a card (or a native
// dialog for a page of no chat), "always" remembered per origin and permission, and who drives a page
// (BrowserTabs.driver in hostTabs.cjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { drive, setup, tabOf } from './support/browser-host-kit.ts';

const require = createRequire(import.meta.url);
const { WebPermissions, savedWebPermissions, dialogAsk, wanted, ASKABLE } = require('../electron/capabilities/browser/webPermissions.cjs');
const { KINDS } = require('../electron/capabilities/contract/approvals.cjs');
const { recentIgnored, clearIgnored } = require('../electron/ignored.cjs');

const page = (url = 'https://meet.test/room', o: any = {}) => ({ getURL: () => url, isDestroyed: () => false, ...o });

function perms(o: any = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-perms-'));
  const asked: any[] = [];
  const notes: any[] = [];
  const drivers = new Map<any, any>();
  let answer: any = { decision: 'allow', scope: 'once' };
  const p = new WebPermissions({
    file: o.file === undefined ? path.join(dir, 'sub', 'perms.json') : o.file,
    driver: o.driver ?? ((wc: any) => drivers.get(wc) ?? null),
    ask: async (req: any) => {
      asked.push(req);
      if (answer instanceof Error) throw answer;
      return typeof answer === 'function' ? answer(req) : answer;
    },
    note: (chatId: string, text: string) => notes.push([chatId, text]),
  });
  return {
    p,
    dir,
    asked,
    notes,
    drivers,
    answer: (a: any) => (answer = a),
  };
}

test('wanted: media is the camera and/or microphone; other askable permissions by name; the rest nothing', () => {
  assert.deepEqual(ASKABLE, ['camera', 'microphone', 'geolocation', 'notifications']);
  assert.deepEqual(wanted('media', { mediaTypes: ['video', 'audio'] }), ['camera', 'microphone']);
  assert.deepEqual(wanted('media', { mediaTypes: ['audio'] }), ['microphone']);
  assert.deepEqual(wanted('media', {}), []);
  assert.deepEqual(wanted('media'), []);
  assert.deepEqual(wanted('geolocation'), ['geolocation']);
  assert.deepEqual(wanted('fullscreen'), []);
  assert.equal(KINDS.has('browserPermission'), true, 'a card kind Sage may ask for');
});

test('install: every handler once per session; display media and devices are denied', () => {
  const { p } = perms();
  const ses: any = {};
  const handlers: any = {};
  for (const k of [
    'setPermissionRequestHandler',
    'setPermissionCheckHandler',
    'setDisplayMediaRequestHandler',
    'setDevicePermissionHandler',
  ])
    ses[k] = (h: any) => {
      handlers[k] = (handlers[k] || 0) + 1;
      ses[`${k}:fn`] = h;
    };
  p.install(ses);
  p.install(ses);
  p.install(null);
  assert.deepEqual(Object.values(handlers), [1, 1, 1, 1]);
  let streams: any = 'unset';
  ses['setDisplayMediaRequestHandler:fn']({}, (s: any) => (streams = s));
  assert.equal(streams, null);
  assert.equal(ses['setDevicePermissionHandler:fn']({ deviceType: 'hid' }), false);
  // the request handler answers through its callback, false when the policy throws (and why is kept)
  clearIgnored();
  const got: any[] = [];
  ses['setPermissionRequestHandler:fn'](page(), 'clipboard-sanitized-write', (v: boolean) => got.push(v), {});
  p.request = async () => {
    throw new Error('boom');
  };
  ses['setPermissionRequestHandler:fn'](page(), 'media', (v: boolean) => got.push(v), {});
  assert.equal(ses['setPermissionCheckHandler:fn'](page(), 'clipboard-sanitized-write', 'https://meet.test', {}), true);
  return new Promise<void>((resolve) =>
    setImmediate(() => {
      assert.deepEqual(got, [true, false]);
      assert.match(JSON.stringify(recentIgnored()), /decide a page's media permission request \(denied\).*boom/);
      resolve();
    }),
  );
});

test('clipboard follows the app session (write always, read unless an agent drives); fullscreen and the rest are denied', async () => {
  const { p, drivers, asked } = perms();
  const wc = page();
  assert.equal(await p.request(wc, 'clipboard-sanitized-write', {}), true);
  assert.equal(await p.request(wc, 'clipboard-read', {}), true);
  assert.equal(p.check(wc, 'clipboard-read', 'https://meet.test', {}), true);
  drivers.set(wc, { chatId: 'c', tabId: 't1', agent: true });
  assert.equal(await p.request(wc, 'clipboard-read', {}), false);
  assert.equal(p.check(wc, 'clipboard-read', 'https://meet.test', {}), false);
  for (const perm of ['fullscreen', 'pointerLock', 'openExternal', 'midi'])
    assert.equal(await p.request(page(), perm, { requestingUrl: 'https://meet.test/' }), false);
  // no web origin (a file, a blank page, a page already gone)
  assert.equal(await p.request(page('file:///x.html'), 'geolocation', {}), false);
  assert.equal(await p.request(page('', { isDestroyed: () => true }), 'geolocation', {}), false);
  assert.equal(
    await p.request(
      page('', {
        getURL: () => {
          throw new Error('gone');
        },
      }),
      'geolocation',
      {},
    ),
    false,
  );
  assert.deepEqual(asked, []);
  // a driver lookup that fails is a page of no chat
  const broken = perms({
    driver: () => {
      throw new Error('no tabs');
    },
  });
  assert.equal(await broken.p.request(wc, 'clipboard-read', {}), true);
  assert.equal(await broken.p.request(wc, 'geolocation', {}), true);
  assert.equal(broken.asked[0].chatId, null);
});

test('an agent-driven page is denied without a card, and the next result says so', async () => {
  const { p, drivers, asked, notes } = perms();
  const wc = page();
  drivers.set(wc, { chatId: 'c', tabId: 'tab_aaaaaa', agent: true });
  // even a site the user allowed for good
  p.always.set('https://meet.test', new Set(['camera', 'microphone']));
  assert.equal(await p.request(wc, 'media', { mediaTypes: ['video', 'audio'], requestingUrl: 'https://meet.test/room' }), false);
  assert.equal(p.check(wc, 'media', 'https://meet.test', { mediaType: 'video' }), false);
  assert.deepEqual(asked, []);
  assert.deepEqual(notes, [
    [
      'c',
      "permission_denied tab_aaaaaa: https://meet.test asked for the camera and microphone, which pages an agent drives can't use. If the task needs it, ask the user to take over the tab.",
    ],
  ]);
});

test("a user-driven page asks on its chat's card: once, always (remembered and saved), deny or unanswered", async () => {
  const s = perms();
  const wc = page();
  s.drivers.set(wc, { chatId: 'c', tabId: 'tab_aaaaaa', agent: false });
  assert.equal(await s.p.request(wc, 'geolocation', {}), true);
  assert.deepEqual(
    s.asked.map((r) => [r.chatId, r.origin, r.permissions, r.wc === wc]),
    [['c', 'https://meet.test', ['geolocation'], true]],
  );
  assert.equal(s.p.check(wc, 'geolocation', 'https://meet.test', {}), false, 'once is not remembered');

  s.answer({ decision: 'allow', scope: 'always' });
  assert.equal(await s.p.request(wc, 'media', { mediaTypes: ['video', 'audio'] }), true);
  assert.equal(s.p.allowed('https://meet.test', 'camera'), true);
  assert.equal(s.p.check(wc, 'media', 'https://meet.test', { mediaType: 'audio' }), true);
  assert.equal(s.p.check(wc, 'media', '', { mediaType: 'video', requestingUrl: 'https://meet.test/x' }), true);
  assert.equal(s.p.check(wc, 'media', 'https://meet.test', { mediaType: 'unknown' }), false);
  assert.equal(s.p.check(wc, 'notifications', 'https://other.test', {}), false);
  assert.equal(s.p.check(wc, 'fullscreen', 'https://meet.test', {}), false);
  assert.equal(s.p.check(page('about:blank'), 'geolocation', '', undefined), false);
  // remembered: no card the next time; another permission adds to the site's set
  const before = s.asked.length;
  assert.equal(await s.p.request(wc, 'media', { mediaTypes: ['audio'] }), true);
  assert.equal(s.asked.length, before);
  await s.p.request(wc, 'notifications', {});
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(s.dir, 'sub', 'perms.json'), 'utf8')), {
    origins: { 'https://meet.test': ['camera', 'microphone', 'notifications'] },
  });
  // it survives a restart; a bad file entry is skipped
  const again = new WebPermissions({
    file: path.join(s.dir, 'sub', 'perms.json'),
    driver: () => null,
    ask: async () => null,
    note: () => {},
  });
  assert.equal(again.allowed('https://meet.test', 'notifications'), true);

  s.answer({ decision: 'deny' });
  assert.equal(await s.p.request(wc, 'geolocation', {}), false);
  s.answer(null);
  assert.equal(await s.p.request(wc, 'geolocation', {}), false);
  s.answer(new Error('card failed'));
  assert.equal(await s.p.request(wc, 'geolocation', {}), false);
});

test('an answer goes to the page as it is then: not one handed back to the agent, closed, or on another site', async () => {
  const s = perms();
  let url = 'https://meet.test/room';
  let closed = false;
  const wc = page('', { getURL: () => url, isDestroyed: () => closed });
  const who = { chatId: 'c', tabId: 'tab_aaaaaa', agent: false };
  s.drivers.set(wc, who);
  // the user hands the tab back while the card is open, then allows
  s.answer(() => ((who.agent = true), { decision: 'allow', scope: 'once' }));
  assert.equal(await s.p.request(wc, 'geolocation', {}), false);
  who.agent = false;
  // the page moves to another site while the card is open
  s.answer(() => ((url = 'https://other.test/'), { decision: 'allow', scope: 'once' }));
  assert.equal(await s.p.request(wc, 'geolocation', {}), false);
  url = 'https://meet.test/room';
  // the tab closes: "Always" is still the user's choice for the site, but nothing is granted to a closed page
  s.answer(() => ((closed = true), { decision: 'allow', scope: 'always' }));
  assert.equal(await s.p.request(wc, 'notifications', {}), false);
  assert.equal(s.p.allowed('https://meet.test', 'notifications'), true);
  closed = false;
  // a frame of another site on the same page still gets its answer
  s.answer({ decision: 'allow', scope: 'once' });
  assert.equal(await s.p.request(wc, 'geolocation', { requestingUrl: 'https://maps.test/embed' }), true);
});

test('requests asked together share one card; a page of no chat asks with no chat', async () => {
  const s = perms();
  let release: any;
  s.answer(() => new Promise((r) => (release = r)));
  const wc = page();
  const a = s.p.request(wc, 'geolocation', {});
  const b = s.p.request(wc, 'geolocation', {});
  await new Promise((r) => setImmediate(r));
  assert.equal(s.asked.length, 1);
  assert.equal(s.asked[0].chatId, null);
  release({ decision: 'allow', scope: 'once' });
  assert.deepEqual(await Promise.all([a, b]), [true, true]);
  assert.equal(s.p.asking.size, 0);
});

test('load and save: no file, an unreadable file, bad entries, and a save that fails', () => {
  const none = perms({ file: null });
  none.p.always.set('https://a.test', new Set(['camera']));
  none.p.save();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-perms-'));
  const file = path.join(dir, 'p.json');
  fs.writeFileSync(file, '{not json');
  assert.equal(perms({ file }).p.always.size, 0);
  fs.writeFileSync(
    file,
    JSON.stringify({
      origins: {
        'https://a.test': ['camera', 'bogus'],
        'https://b.test/path': ['camera'],
        'https://c.test': 'camera',
        'https://d.test': [],
      },
    }),
  );
  assert.deepEqual([...perms({ file }).p.always.keys()], ['https://a.test']);
  fs.writeFileSync(file, '{}');
  assert.equal(perms({ file }).p.always.size, 0);
  // A path that becomes unwritable after a successful read reports the save failure.
  const taken = path.join(dir, 'later-blocked');
  const blocked = perms({ file: path.join(taken, 'x', 'y.json') });
  fs.writeFileSync(taken, 'not a directory');
  blocked.p.always.set('https://a.test', new Set(['camera']));
  assert.throws(() => blocked.p.save(), /Couldn't save the web permission/);
});

test("dialogAsk: a native dialog on the page's window (or alone) with Deny, Allow once and Always", async () => {
  const shown: any[] = [];
  let response = 1;
  const dialog = {
    showMessageBox: async (...a: any[]) => {
      shown.push(a);
      return { response };
    },
  };
  const win = { id: 'w' };
  const shownPage = page('x');
  // main says which window shows a page (a view's, a <webview>'s host); none, or undefined, stands alone
  const ask = dialogAsk(dialog, (wc: any) => (wc === shownPage ? win : wc?.id === 'u' ? undefined : null));
  const req = {
    chatId: null,
    origin: 'https://meet.test',
    permissions: ['camera', 'microphone'],
    wc: shownPage,
  };
  assert.deepEqual(await ask(req), { decision: 'allow', scope: 'once' });
  assert.equal(shown[0][0], win);
  assert.deepEqual(shown[0][1], {
    type: 'question',
    message: 'https://meet.test wants to use your camera and microphone',
    buttons: ['Deny', 'Allow once', 'Always allow for this site'],
    defaultId: 0,
    cancelId: 0,
  });
  response = 2;
  assert.deepEqual(await ask({ ...req, wc: page() }), { decision: 'allow', scope: 'always' });
  assert.equal(shown[1].length, 1, 'no window: the dialog stands alone');
  await ask({ ...req, wc: page('u', { id: 'u' }) });
  assert.equal(shown[2].length, 1);
  response = 0;
  const throwing = dialogAsk(dialog, () => {
    throw new Error('gone');
  });
  assert.deepEqual(await throwing({ ...req, permissions: ['geolocation'] }), { decision: 'deny' });
  assert.equal(shown[3][0].message, 'https://meet.test wants to use your location');
  response = 7;
  assert.equal(await ask(req), null);
});

test('driver: the chat whose tab or popup a page is, and whether an agent holds it now', async (t) => {
  const h = setup(t);
  const tab = tabOf(h);
  assert.equal(h.tabs.driver(null), null);
  assert.equal(h.tabs.driver(h.newWC()), null, 'a page of no chat');
  assert.deepEqual(h.tabs.driver(tab.wc), { chatId: 'c', tabId: tab.id, agent: false });
  await drive(t, h.tabs.ready(tab, 'c'));
  assert.equal(h.tabs.driver(tab.wc).agent, true);
  const popup = h.tabs.adoptPopup(tab.wc, h.popupWC());
  assert.deepEqual(h.tabs.driver(popup.wc), { chatId: 'c', tabId: popup.id, agent: true }, "the opener's agent drives its popup");
  h.tabs.takeOver('c', tab.id, true);
  assert.equal(h.tabs.driver(tab.wc).agent, false);
  assert.equal(h.tabs.driver(popup.wc).agent, false);
  h.tabs.takeOver('c', tab.id, false);
  popup.takenOver = true;
  assert.equal(h.tabs.driver(popup.wc).agent, false);
  popup.takenOver = false;
  const signin = h.tabs.requestSignin(tab, { reason: 'log in' });
  assert.equal(h.tabs.driver(tab.wc).agent, false, 'the user signs in');
  h.tabs.signinDone('c', tab.id);
  await signin;
  popup.signin = { reason: 'x' };
  assert.equal(h.tabs.driver(popup.wc).agent, false);
});

test('Settings lists the sites allowed for good and removes one, through the running policy or the file before it starts', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-perms-saved-'));
  const file = path.join(dir, 'perms.json');
  fs.writeFileSync(
    file,
    JSON.stringify({ origins: { 'https://z.test': ['notifications'], 'https://meet.test': ['microphone', 'camera'] } }),
  );
  // before the browser started: the file itself
  const before = savedWebPermissions(file);
  assert.deepEqual(before.list(), [
    { origin: 'https://meet.test', permissions: ['camera', 'microphone'] },
    { origin: 'https://z.test', permissions: ['notifications'] },
  ]);
  assert.deepEqual(before.forget('https://z.test'), [{ origin: 'https://meet.test', permissions: ['camera', 'microphone'] }]);
  assert.deepEqual(before.forget('https://none.test'), [{ origin: 'https://meet.test', permissions: ['camera', 'microphone'] }]);
  assert.notEqual(savedWebPermissions(file), before, 'a file-only view is never the running policy');
  // the running policy: a removal is what its permission checks see at once
  const running = new WebPermissions({ file, driver: () => null, ask: async () => null, note: () => {} });
  assert.equal(savedWebPermissions(file), running);
  assert.equal(running.check(page(), 'media', 'https://meet.test', { mediaType: 'video' }), true);
  assert.deepEqual(savedWebPermissions(file).forget('https://meet.test'), []);
  assert.equal(running.check(page(), 'media', 'https://meet.test', { mediaType: 'video' }), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { origins: {} });
  // a policy without a file is never what Settings edits
  const memory = new WebPermissions({ file: null, driver: () => null, ask: async () => null, note: () => {} });
  assert.deepEqual(memory.list(), []);
  fs.rmSync(dir, { recursive: true, force: true });
});
