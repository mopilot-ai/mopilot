// Saved logins in the page (loginAssist.cjs): the fill world's dropdown and sign-in watcher, main's handling of their
// signals (fill, "Save password?" offers, expiry, answers) and the "Never" list in the login store; the answer itself: browserLoginOfferAnswer.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fakePage } from './helpers/loginAssistPage.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tick } from './support/async-scenarios.ts';

const require = createRequire(import.meta.url);
const { createLoginAssist, assistScript, SIGNAL, OFFER_MS, SETTLE_MS, KEY } = require('../electron/capabilities/browser/loginAssist.cjs');
const { CredentialStore } = require('../electron/capabilities/browser/credentialStore.cjs');
const { FILL_WORLD } = require('../electron/capabilities/browser/userFill.cjs');

const fakeSafe = {
  isEncryptionAvailable: () => true,
  encryptString: (s: string) => Buffer.from(`enc:${s}`),
  decryptString: (b: Buffer) => b.toString().slice(4),
};
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'login-assist-test-'));

const prefixOf = (code: string) => code.match(/"(mopilot-login:[^"]+:)"/)![1];
const send = (wc: any, message: string) => wc.emit('console-message', { message });
/** The offer id main last told the pane about: the one its bar shows and answers. */
const lastOffer = (notes: any[]) => notes.findLast((n) => n.kind === 'offer')?.offerId;
/** What the pane heard, without the offer ids (each a fresh uuid). */
const plain = (notes: any[]) => notes.map(({ offerId: _id, ...n }) => n);

test('CredentialStore: "Never" for a site is remembered, once, and a write failure says so', () => {
  const dir = tmp();
  const store = new CredentialStore({ file: path.join(dir, 'logins.json'), safeStorage: fakeSafe });
  assert.equal(store.neverFile, path.join(dir, 'logins-never.json'));
  assert.equal(store.isNever('https://a.test'), false);
  assert.equal(store.setNever('https://a.test'), true);
  assert.equal(store.setNever('https://a.test'), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(store.neverFile, 'utf8')), ['https://a.test']);
  assert.equal(store.isNever('https://a.test'), true);
  fs.writeFileSync(store.neverFile, '{"not": "a list"}');
  assert.equal(store.isNever('https://a.test'), false);
  fs.writeFileSync(store.neverFile, '["https://b.test", 3]');
  assert.equal(store.isNever('https://b.test'), true);
  // a folder where the file goes can't be written
  const blocked = new CredentialStore({ file: path.join(dir, 'x.json'), safeStorage: fakeSafe });
  fs.mkdirSync(blocked.neverFile);
  assert.equal(blocked.setNever('https://a.test'), false);
});

test('attach: each page load installs the help with the site saved user names; nothing for a blank page, with the flag off or once gone', async () => {
  let on = true;
  const saved = [{ id: 'l1', username: 'ann' }];
  const lists: string[] = [];
  const assist = createLoginAssist({
    store: () => ({ list: (o: string) => (lists.push(o), saved) }),
    confirm: async () => true,
    isAgent: () => false,
    enabled: () => on,
    notify: () => {},
  });
  const wc = fakePage();
  assist.attach(wc);
  wc.emit('dom-ready');
  assert.equal(wc.scripts.length, 1);
  assert.equal(wc.scripts[0].world, FILL_WORLD);
  assert.match(wc.scripts[0].code, /"username":"ann"/);
  assert.match(wc.scripts[0].code, new RegExp(`"${SIGNAL}[0-9a-f-]{36}:"`));
  assert.deepEqual(lists, ['https://a.test']);
  // the same page keeps its nonce; another page gets its own
  wc.emit('dom-ready');
  assert.equal(prefixOf(wc.scripts[1].code), prefixOf(wc.scripts[0].code));
  const other = fakePage('https://b.test/', 8);
  assist.attach(other);
  other.emit('dom-ready');
  assert.notEqual(prefixOf(other.scripts[0].code), prefixOf(wc.scripts[0].code));
  wc.url = 'about:blank';
  wc.emit('dom-ready');
  wc.url = 'https://a.test/';
  on = false;
  wc.emit('dom-ready');
  on = true;
  wc.destroyed = true;
  wc.emit('dom-ready');
  assert.equal(wc.scripts.length, 2);
  // a page that refuses the script is noted, not thrown
  const refusing = fakePage('https://c.test/', 9);
  refusing.executeJavaScriptInIsolatedWorld = async () => {
    throw new Error('navigated');
  };
  assist.attach(refusing);
  refusing.emit('dom-ready');
  await tick();
});

test('fill signals: the dropdown pick fills as the key button does; failures go to the pane; a forged, agent or flag-off signal does nothing', async () => {
  const store = new CredentialStore({ file: path.join(tmp(), 'logins.json'), safeStorage: fakeSafe });
  store.save('https://a.test', 'ann', 's3cret');
  const [{ id }] = store.list('https://a.test');
  const notes: any[] = [];
  let agent = false;
  let on = true;
  let allow = true;
  const assist = createLoginAssist({
    store: () => store,
    confirm: async () => allow,
    isAgent: () => agent,
    enabled: () => on,
    notify: (wc: any, d: any) => notes.push({ page: wc.id, ...d }),
  });
  const wc = fakePage();
  wc.answer = (code: string) => (code.includes('"probe"') ? { username: true, password: true } : code.includes(KEY) ? undefined : true);
  assist.attach(wc);
  wc.emit('dom-ready');
  const prefix = prefixOf(wc.scripts[0].code);
  // the page can't speak without the nonce, and other messages are ignored
  send(wc, `${SIGNAL}guess:fill:${id}`);
  send(wc, 'hello');
  wc.emit('console-message', null);
  send(wc, `${prefix}something`);
  await tick();
  assert.deepEqual(wc.typed, []);
  send(wc, `${prefix}fill:${id}`);
  await tick();
  await tick();
  assert.deepEqual(wc.typed, ['ann', 's3cret']);
  assert.deepEqual(notes, []);
  // Touch ID cancelled: nothing typed, nothing said
  allow = false;
  send(wc, `${prefix}fill:${id}`);
  await tick();
  await tick();
  assert.deepEqual(wc.typed, ['ann', 's3cret']);
  assert.deepEqual(notes, []);
  allow = true;
  send(wc, `${prefix}fill:gone`);
  await tick();
  assert.deepEqual(notes, [{ page: 7, kind: 'fill', status: 'not_found' }]);
  agent = true;
  send(wc, `${prefix}fill:${id}`);
  agent = false;
  on = false;
  send(wc, `${prefix}fill:${id}`);
  await tick();
  await tick();
  assert.equal(wc.typed.length, 2);
});

test('submitted: main takes the sign-in from the fill world and offers to save or update it; nothing for a known password, a Never site, no encryption or a bad answer', async () => {
  const dir = tmp();
  const store = new CredentialStore({ file: path.join(dir, 'logins.json'), safeStorage: fakeSafe });
  const notes: any[] = [];
  let agent = false;
  const assist = createLoginAssist({
    store: () => store,
    confirm: async () => true,
    isAgent: () => agent,
    notify: (wc: any, d: any) => notes.push({ page: wc.id, ...d }),
  });
  const wc = fakePage();
  let signedIn: any = { origin: 'https://a.test', username: 'ann', password: 'one' };
  wc.answer = (code: string) => (code.includes('.take()') ? signedIn : undefined);
  assist.attach(wc);
  wc.emit('dom-ready');
  const prefix = prefixOf(wc.scripts[0].code);
  // a sign-in the page then navigates away from
  const submit = async () => {
    send(wc, `${prefix}submitted`);
    await tick();
    await tick();
    wc.emit('did-navigate');
  };
  await submit();
  assert.deepEqual(plain(notes), [{ page: 7, kind: 'offer', host: 'a.test', username: 'ann', update: false }]);
  assert.match(lastOffer(notes), /^[0-9a-f-]{36}$/);
  assert.match(wc.scripts.at(-1).code, new RegExp(`window\\.${KEY}`));
  assert.equal(wc.scripts.at(-1).world, FILL_WORLD);
  // the password is in main's offer only: never in what the pane hears
  assert.ok(!JSON.stringify(notes).includes('one'));
  assert.equal(assist.answer(7, 'save', lastOffer(notes)), 'saved');
  assert.equal(store.get(store.list('https://a.test')[0].id, 'https://a.test')!.password, 'one');
  // saving re-installs the page's dropdown with the new login
  assert.match(wc.scripts.at(-1).code, /"username":"ann"/);
  assert.equal(assist.answer(7, 'save', lastOffer(notes)), 'gone');
  // the same password again: nothing to offer
  notes.length = 0;
  await submit();
  assert.deepEqual(notes, []);
  // a new password for the same user: an update
  signedIn = { origin: 'https://a.test', username: 'ann', password: 'two' };
  await submit();
  assert.deepEqual(plain(notes), [{ page: 7, kind: 'offer', host: 'a.test', username: 'ann', update: true }]);
  assert.equal(assist.answer(7, 'dismiss', lastOffer(notes)), 'dismissed');
  assert.equal(store.get(store.list('https://a.test')[0].id, 'https://a.test')!.password, 'one');
  // a newer sign-in replaces the offer waiting on the page
  notes.length = 0;
  signedIn = { origin: 'https://a.test', username: 'bob', password: 'b' };
  await submit();
  signedIn = { origin: 'https://a.test', username: 'cy', password: 'c' };
  await submit();
  assert.deepEqual(
    notes.map((n: any) => n.username),
    ['bob', 'cy'],
  );
  assert.equal(assist.answer(7, 'never', lastOffer(notes)), 'never');
  assert.equal(store.isNever('https://a.test'), true);
  assert.equal(store.list('https://a.test').length, 1);
  notes.length = 0;
  await submit();
  // nothing the script could hand back makes an offer: no origin, a page that isn't web, no password, no user name string
  for (const bad of [
    null,
    { origin: 'about:blank', username: 'x', password: 'p' },
    { origin: 3, username: 'x', password: 'p' },
    { origin: 'https://b.test', username: 'x', password: '' },
    { origin: 'https://b.test', username: 'x', password: 3 },
    { origin: 'https://b.test', username: 1, password: 'p' },
  ]) {
    signedIn = bad;
    await submit();
  }
  // no encryption key: nothing can be saved, so nothing is offered
  signedIn = { origin: 'https://b.test', username: 'x', password: 'p' };
  const off = fakeSafe.isEncryptionAvailable;
  fakeSafe.isEncryptionAvailable = () => false;
  await submit();
  fakeSafe.isEncryptionAvailable = off;
  // an agent driving the tab: nothing is taken or offered
  agent = true;
  await submit();
  agent = false;
  // the page went before main asked
  wc.executeJavaScriptInIsolatedWorld = async () => {
    throw new Error('gone');
  };
  await submit();
  assert.deepEqual(notes, []);
});

test('offers expire (the pane is told), go with their page, and an answer that cannot be written fails', async () => {
  const notes: any[] = [];
  let saveOk = false;
  let neverOk = false;
  const store = {
    available: () => true,
    isNever: () => false,
    list: () => [],
    get: () => null,
    save: () => saveOk,
    setNever: () => neverOk,
  };
  const assist = createLoginAssist({
    store: () => store,
    confirm: async () => true,
    isAgent: () => false,
    notify: (wc: any, d: any) => notes.push({ page: wc.id, ...d }),
    offerMs: 5,
  });
  assert.equal(OFFER_MS, 120_000);
  const wc = fakePage();
  wc.answer = () => ({ origin: 'https://a.test', username: '', password: 'p' });
  assist.attach(wc);
  wc.emit('dom-ready');
  const prefix = prefixOf(wc.scripts[0].code);
  const submit = async (page = wc) => {
    send(page, `${prefix}submitted`);
    await tick();
    await tick();
    page.emit('did-navigate');
  };
  await submit();
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(
    notes.map((n) => n.kind),
    ['offer', 'offer_gone'],
  );
  // the pane drops the bar of the offer that went, by its id
  assert.equal(notes[1].offerId, notes[0].offerId);
  assert.equal(assist.answer(7, 'save', lastOffer(notes)), 'gone');
  await submit();
  assert.equal(assist.answer(7, 'save', lastOffer(notes)), 'failed');
  await submit();
  assert.equal(assist.answer(7, 'never', lastOffer(notes)), 'failed');
  saveOk = true;
  neverOk = true;
  // a page that closes takes its offer with it, and nothing is said to a page that is gone
  notes.length = 0;
  await submit();
  wc.destroyed = true;
  wc.emit('destroyed');
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(
    notes.map((n) => n.kind),
    ['offer'],
  );
  assert.equal(assist.answer(7, 'save', lastOffer(notes)), 'gone');
  // expiring after the page went quiet: dropped without a word
  const quiet = fakePage('https://a.test/', 11);
  quiet.answer = wc.answer;
  assist.attach(quiet);
  quiet.emit('dom-ready');
  send(quiet, `${prefixOf(quiet.scripts[0].code)}submitted`);
  await tick();
  await tick();
  quiet.emit('did-navigate');
  quiet.destroyed = true;
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(
    notes.map((n) => n.kind),
    ['offer', 'offer'],
  );
});

test('a sign-in is offered only once it looks accepted: a navigation, or its password field gone a moment later', async () => {
  assert.equal(SETTLE_MS, 3000);
  const notes: any[] = [];
  const store = { available: () => true, isNever: () => false, list: () => [], get: () => null, save: () => true, setNever: () => true };
  let agent = false;
  const assist = createLoginAssist({
    store: () => store,
    confirm: async () => true,
    isAgent: () => agent,
    notify: (wc: any, d: any) => notes.push({ page: wc.id, ...d }),
    settleMs: 50,
  });
  const wc = fakePage();
  let formLeft: any = { username: false, password: false };
  wc.answer = (code: string) =>
    code.includes('.take()')
      ? { origin: 'https://a.test', username: 'ann', password: 'p' }
      : code.includes('"probe"')
        ? formLeft
        : undefined;
  assist.attach(wc);
  wc.emit('dom-ready');
  const prefix = prefixOf(wc.scripts[0].code);
  const signIn = async () => {
    send(wc, `${prefix}submitted`);
    await tick();
    await tick();
  };
  const settle = () => new Promise((r) => setTimeout(r, 120));
  // the form went (a page that changes without navigating): offered
  await signIn();
  assert.deepEqual(notes, []);
  await settle();
  assert.deepEqual(
    notes.map((n: any) => n.kind),
    ['offer'],
  );
  // the password field still there: refused, never offered (so a wrong password can't replace a saved one)
  notes.length = 0;
  formLeft = { username: true, password: true };
  await signIn();
  await settle();
  assert.deepEqual(notes, []);
  // a navigation inside a frame isn't the page moving on; the main frame's is
  await signIn();
  wc.emit('did-navigate-in-page', {}, 'https://a.test/#x', false);
  assert.deepEqual(notes, []);
  wc.emit('did-navigate-in-page', {}, 'https://a.test/#home', true);
  await tick();
  assert.equal(notes.length, 1);
  // a navigation with nothing pending does nothing
  wc.emit('did-navigate');
  await settle();
  assert.equal(notes.length, 1);
  // the page refuses the check, or closes while it waits: nothing
  await signIn();
  wc.executeJavaScriptInIsolatedWorld = async () => {
    throw new Error('gone');
  };
  await settle();
  wc.executeJavaScriptInIsolatedWorld = async (_w: number, [{ code }]: any) => wc.answer(code);
  await signIn();
  wc.destroyed = true;
  wc.emit('destroyed');
  await settle();
  // a timer that fires once the page is gone, though it wasn't told yet
  wc.destroyed = false;
  const late = fakePage('https://a.test/', 12);
  late.answer = wc.answer;
  assist.attach(late);
  late.emit('dom-ready');
  send(late, `${prefixOf(late.scripts[0].code)}submitted`);
  await tick();
  await tick();
  late.destroyed = true;
  await settle();
  assert.equal(notes.length, 1);
  // an agent's tab gets the help without saved user names
  agent = true;
  const driven = fakePage('https://a.test/', 13);
  assist.attach(driven);
  driven.emit('dom-ready');
  assert.match(driven.scripts[0].code, /const saved = \[\];/);
});

test('the fill world script: a dropdown of saved user names under sign-in fields, picked by click or keys; sign-ins kept for main; only trusted events count', async () => {
  const { Window } = await import('happy-dom');
  const win: any = new Window({ url: 'https://a.test/login' });
  const doc = win.document;
  win.HTMLElement.prototype.getBoundingClientRect = function () {
    // the dropdown's host sits 4px under the field
    return { left: 10, top: 44, bottom: 40, width: 100, height: 20 };
  };
  doc.elementFromPoint = () => doc.querySelector('mopilot-login-menu');
  const signals: string[] = [];
  win.console.log = (m: string) => signals.push(m);
  doc.body.innerHTML = `<form id="f"><input id="search" type="text"><input id="user" type="email" name="email">
    <input id="pass" type="password"><button id="go">Sign in</button></form><input id="other" type="text"><span id="plain">x</span>`;
  const $ = (id: string) => doc.getElementById(id);
  const fire = (el: any, type: string, init: Record<string, unknown> = {}, trusted = true) => {
    const Ctor =
      type === 'keydown' ? win.KeyboardEvent : type.startsWith('focus') ? win.FocusEvent : type === 'click' ? win.MouseEvent : win.Event;
    const ev = new Ctor(type, { bubbles: true, cancelable: true, ...init });
    if (trusted) Object.defineProperty(ev, 'isTrusted', { value: true });
    el.dispatchEvent(ev);
    return ev;
  };
  const prefix = 'mopilot-login:n:';
  const install = (logins: any[]) => win.eval(assistScript(prefix, logins));
  install([
    { id: 'l1', username: 'ann', password: 'never sent' },
    { id: 'l2', username: '' },
  ]);
  assert.ok(!assistScript(prefix, [{ id: 'l1', username: 'ann', password: 'x' }]).includes('"password":"x"'));
  const host = () => doc.querySelector('mopilot-login-menu');
  // an untrusted focus (the page's own script) shows nothing; the user's does
  fire($('user'), 'focusin', {}, false);
  assert.equal(host(), null);
  fire($('user'), 'focusin');
  assert.ok(host());
  assert.match(host().style.cssText, /left: 10px; top: 44px/);
  // the dropdown is closed to the page: no shadowRoot to read
  assert.equal(host().shadowRoot, null);
  // keys: arrows move, Enter picks, Escape closes; other keys and other fields pass
  fire($('user'), 'keydown', { key: 'ArrowUp' });
  fire($('user'), 'keydown', { key: 'ArrowDown' });
  fire($('user'), 'keydown', { key: 'ArrowDown' });
  fire($('user'), 'keydown', { key: 'a' });
  fire($('user'), 'keydown', { key: 'ArrowDown' }, false);
  const enter = fire($('user'), 'keydown', { key: 'Enter' });
  assert.equal(enter.defaultPrevented, true);
  assert.deepEqual(signals, [`${prefix}fill:l1`]);
  assert.equal(host(), null);
  fire($('pass'), 'focusin');
  assert.ok(host());
  fire($('pass'), 'keydown', { key: 'Escape' });
  assert.equal(host(), null);
  // Enter with nothing highlighted is the page's (a sign-in with an empty password keeps nothing)
  fire($('pass'), 'focusin');
  fire($('pass'), 'keydown', { key: 'Enter' });
  assert.deepEqual(signals, [`${prefix}fill:l1`]);
  // closing: leaving the field, typing in it, scrolling, resizing, focusing another field
  fire($('pass'), 'focusout');
  assert.equal(host(), null);
  fire($('pass'), 'focusout');
  fire($('pass'), 'focusin');
  fire($('other'), 'input');
  assert.ok(host());
  fire($('pass'), 'input');
  assert.equal(host(), null);
  fire($('pass'), 'focusin');
  fire(doc, 'scroll');
  assert.equal(host(), null);
  fire($('pass'), 'focusin');
  win.dispatchEvent(new win.Event('resize'));
  assert.equal(host(), null);
  fire($('pass'), 'focusin');
  fire($('other'), 'focusin');
  assert.equal(host(), null);
  fire($('other'), 'focusin', {}, false);
  // a click on the field opens it again; a click while it is open, or on another field, doesn't
  fire($('user'), 'click');
  assert.ok(host());
  fire($('user'), 'click');
  fire($('plain'), 'click');
  fire($('user'), 'click', {}, false);
  // the dropdown's rows: mousedown keeps the focus, only a trusted click picks
  install([
    { id: 'l1', username: 'ann' },
    { id: 'l2', username: '' },
  ]);
  assert.equal(host(), null, 'an update closes the old dropdown');
  // reach the rows through attachShadow, as the page can't
  const roots: any[] = [];
  const attach = win.HTMLElement.prototype.attachShadow;
  win.HTMLElement.prototype.attachShadow = function (o: any) {
    const r = attach.call(this, o);
    roots.push(r);
    return r;
  };
  $('user').focus();
  fire($('user'), 'focusin');
  const rows = [...roots[0].querySelectorAll('.item')];
  assert.deepEqual(
    rows.map((r: any) => r.textContent),
    ['ann', '(no user name)'],
  );
  assert.equal(roots[0].querySelector('.foot').textContent, 'Saved in MoPilot');
  assert.equal(fire(rows[1], 'mousedown').defaultPrevented, true);
  fire(rows[1], 'click', {}, false);
  assert.ok(host());
  fire(rows[1], 'click');
  assert.deepEqual(signals, [`${prefix}fill:l1`, `${prefix}fill:l2`]);
  // a dropdown the page tampered with closes on the click and fills nothing: restyled, hidden by a stylesheet,
  // moved, covered, or its field no longer focused
  const tampered = [
    () => (host().style.opacity = '0'),
    () => {
      const css = doc.createElement('style');
      css.id = 'evil';
      css.textContent = 'mopilot-login-menu { visibility: hidden !important; }';
      doc.head.append(css);
      return () => css.remove();
    },
    () => {
      const real = win.getComputedStyle;
      win.getComputedStyle = (el: any) => (el === host() ? { opacity: '', visibility: '', transform: 'scale(2)', filter: '' } : real(el));
      return () => (win.getComputedStyle = real);
    },
    () => {
      const real = win.getComputedStyle;
      win.getComputedStyle = (el: any) => (el === host() ? { opacity: '1', visibility: 'visible', filter: 'opacity(0)' } : real(el));
      return () => (win.getComputedStyle = real);
    },
    () => {
      const real = win.getComputedStyle;
      win.getComputedStyle = (el: any) => (el === host() ? { opacity: '0.5' } : real(el));
      return () => (win.getComputedStyle = real);
    },
    () => {
      const h = host();
      h.getBoundingClientRect = () => ({ left: 300, top: 44 });
    },
    () => {
      const h = host();
      h.getBoundingClientRect = () => ({ left: 10, top: 400 });
    },
    () => {
      const real = doc.elementFromPoint;
      doc.elementFromPoint = () => doc.body;
      return () => (doc.elementFromPoint = real);
    },
    () => $('other').focus(),
  ];
  for (const tamper of tampered) {
    roots.length = 0;
    $('user').focus();
    fire($('user'), 'focusin');
    const undo: unknown = tamper();
    fire(roots[0].querySelector('.item'), 'click');
    if (typeof undo === 'function') undo();
    assert.equal(host(), null);
  }
  assert.equal(signals.length, 2);
  // no saved logins: no dropdown, but sign-ins are still watched
  install([]);
  fire($('user'), 'focusin');
  assert.equal(host(), null);
  const take = () => JSON.parse(JSON.stringify(win.eval(`window.${KEY}.take()`)));
  assert.equal(take(), null);
  $('user').value = 'ann@a.test';
  $('pass').value = 'pw1';
  fire($('go'), 'click');
  assert.deepEqual(take(), { origin: 'https://a.test', username: 'ann@a.test', password: 'pw1' });
  assert.equal(take(), null);
  assert.equal(signals.at(-1), `${prefix}submitted`);
  // a burst (click, then submit, then Enter) signals once, and keeps the latest values
  const before = signals.length;
  fire($('f'), 'submit');
  $('pass').value = 'pw2';
  fire($('pass'), 'keydown', { key: 'Enter' });
  assert.equal(signals.length, before);
  assert.equal(take().password, 'pw2');
  // untrusted submits and clicks, clicks on what isn't a button, and Enter outside the sign-in fields keep nothing
  fire($('f'), 'submit', {}, false);
  fire($('go'), 'click', {}, false);
  fire($('plain'), 'click');
  fire($('other'), 'keydown', { key: 'Enter' });
  fire($('pass'), 'keydown', { key: 'Enter' }, false);
  assert.equal(take(), null);
  // an empty password field, or none on the page, keeps nothing
  $('pass').value = '';
  fire($('go'), 'click');
  assert.equal(take(), null);
  doc.body.innerHTML = '<input id="user2" type="email" name="email"><button id="go2">Next</button>';
  fire(doc.getElementById('go2'), 'click');
  assert.equal(take(), null);
  // a password-only step outside a form: no user name
  doc.body.innerHTML = '<input id="p3" type="password"><div role="button" id="go3">Next</div>';
  doc.getElementById('p3').value = 'pw3';
  await new Promise((r) => setTimeout(r, 520));
  fire(doc.getElementById('go3'), 'click');
  assert.deepEqual(take(), { origin: 'https://a.test', username: '', password: 'pw3' });
  assert.equal(signals.at(-1), `${prefix}submitted`);
  assert.equal(signals.length, before + 1);
  // a click on a text node (no closest) keeps nothing
  const text = doc.createTextNode('t');
  doc.body.append(text);
  fire(text, 'click');
  assert.equal(take(), null);
  await win.happyDOM.close();
});
