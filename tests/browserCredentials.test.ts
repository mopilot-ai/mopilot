// The in-app browser's secure credential hand-off (electron/capabilities/browser/credentials.cjs and
// credentialStore.cjs) and browser_request_credentials in hostTools.cjs: field detection, the sheet's
// answers, the origin check, decline and take-over, saved logins, and that no value ever reaches a tool
// result or the operation log. Driven over a fake tab and BrowserTabs, a real OriginGrants and Registry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeTab, makeTabs, LOGIN } from './support/browserCredentialTabs';
import { createRequire } from 'node:module';
import { waitFor } from './support/waitFor.ts';
const require = createRequire(import.meta.url);
const {
  CredentialHandoff,
  requestCredentials,
  registerCredentialIpc,
  detectFields,
  cleanAnswer,
} = require('../electron/capabilities/browser/credentials.cjs');
const { CredentialStore } = require('../electron/capabilities/browser/credentialStore.cjs');
const { createBrowserTools } = require('../electron/capabilities/browser/hostTools.cjs');
const { OriginGrants } = require('../electron/capabilities/browser/origins.cjs');
const { Registry, OperationLog, ToolError } = require('../electron/capabilities/contract/registry.cjs');

const SECRET = 'hunter2-Sup3r$ecret';
const USER = 'ada@example.com';

/** A fake safeStorage: reversible, and visibly not plain text. */
const safeStorage = (available = true) => ({
  isEncryptionAvailable: () => available,
  encryptString: (s: string) => Buffer.from(`enc:${[...s].reverse().join('')}`),
  decryptString: (b: Buffer) => [...b.toString().slice(4)].reverse().join(''),
});
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'creds-')), 'sub', 'logins.json');

/** Starts a request and returns the open sheet once it shows. */
async function opened(handoff: any, run: () => Promise<any>) {
  const p = run();
  await waitFor(() => handoff.list().length, 'the sheet to open');
  return { p, sheet: handoff.list()[0] };
}

const ctx = (signal: AbortSignal | null = null) => ({ chatId: 'c1', segmentId: 's1', signal });

test('cleanAnswer keeps only what main acts on: fill values by kind, takeover, everything else a decline', () => {
  assert.deepEqual(cleanAnswer(null), { action: 'decline' });
  assert.deepEqual(cleanAnswer({ action: 'takeover', values: { password: 'x' } }), { action: 'takeover' });
  assert.deepEqual(cleanAnswer({ action: 'weird' }), { action: 'decline' });
  assert.deepEqual(
    cleanAnswer({ action: 'fill', values: { username: 'u', password: 7, otp: '', extra: 'x', pin: 'y' }, savedId: 's', save: true }),
    { action: 'fill', values: { username: 'u' }, savedId: 's', save: true },
  );
  assert.deepEqual(cleanAnswer({ action: 'fill', values: { password: 'p'.repeat(5000) }, savedId: 3, save: 'yes' }), {
    action: 'fill',
    values: {},
    savedId: null,
    save: false,
  });
  assert.deepEqual(cleanAnswer({ action: 'fill' }), { action: 'fill', values: {}, savedId: null, save: false });
});

test('detectFields: named refs from one frame, or the first frame with a password or code field', async () => {
  const tab = makeTab({
    top: { origin: 'https://a.example', fields: [{ ref: 'ref_1', kind: 'username', label: 'Email' }] },
    frames: {
      S1: { origin: 'https://a.example', fail: true, fields: [] },
      S2: { origin: 'https://idp.example', fields: [{ ref: 'ref_5', kind: 'password', label: 'Password' }] },
    },
  });
  assert.deepEqual(await detectFields(tab, null), {
    sessionId: 'S2',
    origin: 'https://idp.example',
    fields: [{ ref: 'ref_5', kind: 'password', label: 'Password' }],
  });
  assert.deepEqual(await detectFields(tab, ['ref_1']), {
    sessionId: '',
    origin: 'https://a.example',
    fields: [{ ref: 'ref_1', kind: 'username', label: 'Email' }],
  });
  await assert.rejects(detectFields(tab, ['ref_1', 'ref_5']), /one frame only/);
  tab.page[''].fields.push({ ref: 'ref_stale' }, { ref: 'ref_button' });
  await assert.rejects(detectFields(tab, ['ref_stale']), (e: any) => e.code === 'stale_ref');
  await assert.rejects(detectFields(tab, ['ref_button']), /ref_button is not a username, password or one-time code field/);
  // only a username anywhere: that frame; nothing at all: null
  const only = makeTab({
    top: { origin: 'https://a.example', fields: [] },
    frames: { S1: { origin: 'https://a.example', fields: [LOGIN[0]] } },
  });
  assert.equal((await detectFields(only, null)).sessionId, 'S1');
  only.page.S1.fields = [];
  assert.equal(await detectFields(only, null), null);
  // a username first, then a frame with only a username too: the first one stays
  const two = makeTab({
    top: { origin: 'https://a.example', fields: [LOGIN[0]] },
    frames: { S1: { origin: 'https://a.example', fields: [{ ref: 'ref_9', kind: 'username', label: '' }] } },
  });
  assert.equal((await detectFields(two, null)).sessionId, '');
});

test('the sheet lists the site, fields and saved logins (never a password), and closes on answer, finish or abort', async () => {
  const store = new CredentialStore({ file: tmpFile(), safeStorage: safeStorage() });
  store.save('https://a.example', USER, SECRET);
  const changes: any[] = [];
  const handoff = new CredentialHandoff({ store, onChange: (l: any) => changes.push(l) });
  const view = { chatId: 'c1', tabId: 't1', origin: 'https://a.example', frameOrigin: '', reason: 'r', fields: [] };
  const { id, answer } = handoff.ask(view);
  const [listed] = handoff.list();
  assert.equal(listed.id, id);
  assert.equal(listed.canSave, true);
  assert.deepEqual(
    listed.saved.map((s: any) => s.username),
    [USER],
  );
  assert.ok(!JSON.stringify(handoff.list()).includes(SECRET));
  assert.equal(handoff.answer('nope', { action: 'decline' }), false);
  assert.equal(handoff.answer(id, { action: 'takeover' }), true);
  assert.deepEqual(await answer, { action: 'takeover' });
  assert.equal(changes.length, 2);
  assert.deepEqual(handoff.list(), []);
  // forgetting a saved login refreshes the sheets
  assert.equal(handoff.forget(listed.saved[0].id), true);
  assert.equal(handoff.forget('gone'), false);
  assert.equal(changes.length, 3);
  // aborted before and while it shows
  const ac = new AbortController();
  ac.abort();
  assert.deepEqual(await handoff.ask(view, ac.signal).answer, { action: 'stopped' });
  const ac2 = new AbortController();
  const later = handoff.ask(view, ac2.signal);
  ac2.abort();
  assert.deepEqual(await later.answer, { action: 'stopped' });
  // no store: nothing saved, nothing to save into, nothing to forget
  const bare = new CredentialHandoff();
  bare.ask(view);
  assert.deepEqual(bare.list()[0].saved, []);
  assert.equal(bare.list()[0].canSave, false);
  assert.equal(bare.forget('x'), false);
});

test('the IPC lists, answers and forgets, and is removed again', async () => {
  const handlers = new Map<string, Function>();
  const ipcMain = { handle: (ch: string, fn: Function) => handlers.set(ch, fn), removeHandler: (ch: string) => handlers.delete(ch) };
  const store = new CredentialStore({ file: tmpFile(), safeStorage: safeStorage() });
  store.save('https://a.example', USER, SECRET);
  const handoff = new CredentialHandoff({ store });
  const off = registerCredentialIpc({ ipcMain, handoff });
  const { id, answer } = handoff.ask({ chatId: 'c1', tabId: 't1', origin: 'https://a.example', frameOrigin: '', reason: '', fields: [] });
  const [sheet] = await handlers.get('browser:credentialRequests')!();
  assert.equal(sheet.id, id);
  assert.equal(await handlers.get('browser:credentialForget')!({}, sheet.saved[0].id), true);
  assert.equal(await handlers.get('browser:credentialAnswer')!({}, id, { action: 'decline' }), true);
  assert.deepEqual(await answer, { action: 'decline' });
  off();
  assert.equal(handlers.size, 0);
});

test('filled: each field is focused in its frame and gets the text through Input.insertText; the result is only a status', async () => {
  const tab = makeTab({ top: { origin: 'https://a.example', fields: LOGIN } });
  const tabs = makeTabs(tab);
  const handoff = new CredentialHandoff();
  const { p, sheet } = await opened(handoff, () => requestCredentials({ tabs, handoff }, tab, { reason: ' Sign in\nto A ' }, ctx()));
  assert.deepEqual(
    { origin: sheet.origin, frameOrigin: sheet.frameOrigin, reason: sheet.reason, fields: sheet.fields, chatId: sheet.chatId },
    {
      origin: 'https://a.example',
      frameOrigin: '',
      reason: 'Sign in to A',
      fields: [
        { kind: 'username', label: 'Email' },
        { kind: 'password', label: 'Password' },
      ],
      chatId: 'c1',
    },
  );
  handoff.answer(sheet.id, { action: 'fill', values: { username: USER, password: SECRET, otp: '123456' } });
  const out = await p;
  assert.equal(
    out,
    'status: filled\nMoPilot filled the sign-in fields; you never see their values. Read the page again before continuing. (tab t1)',
  );
  assert.deepEqual(tab.typed, { ref_1: USER, ref_2: SECRET });
  assert.deepEqual(
    tab.sent.map((s: any) => [s[0], s[2]]),
    [
      ['Input.insertText', ''],
      ['Input.insertText', ''],
    ],
  );
  assert.deepEqual(tabs.calls.at(-1), ['ready', 'c1', { input: true }]);
  assert.ok(!out.includes(SECRET) && !out.includes(USER));
  // the listeners on the page are gone again
  assert.equal(tab.wc.listenerCount('did-navigate'), 0);
  assert.equal(tab.wc.listenerCount('destroyed'), 0);
});

test('fields in a frame from another origin: the sheet names it and the fill goes to that frame', async () => {
  const tab = makeTab({
    top: { origin: 'https://a.example', fields: [] },
    frames: { S2: { origin: 'https://idp.example', fields: [{ ref: 'ref_5', kind: 'otp', label: '' }] } },
  });
  const tabs = makeTabs(tab);
  const handoff = new CredentialHandoff();
  const { p, sheet } = await opened(handoff, () => requestCredentials({ tabs, handoff }, tab, { submit: true }, ctx()));
  assert.equal(sheet.frameOrigin, 'https://idp.example');
  assert.equal(sheet.reason, '');
  handoff.answer(sheet.id, { action: 'fill', values: { otp: '424242' } });
  assert.match(await p, /^status: filled\n/);
  assert.deepEqual(tab.sent[0], ['Input.insertText', { text: '424242' }, 'S2']);
  assert.deepEqual(tabs.calls.at(-1), ['settle']);
});

test('submit: a form is submitted by the page agent; without one, Enter goes to the field', async () => {
  const tab = makeTab({ top: { origin: 'https://a.example', fields: LOGIN }, noForm: true });
  const tabs = makeTabs(tab);
  const handoff = new CredentialHandoff();
  const { p, sheet } = await opened(handoff, () =>
    requestCredentials({ tabs, handoff }, tab, { submit: true, refs: ['ref_1', 'ref_2'] }, ctx()),
  );
  handoff.answer(sheet.id, { action: 'fill', values: { username: USER, password: SECRET } });
  assert.match(await p, /^status: filled\n/);
  assert.deepEqual(
    tab.sent.slice(2).map((s: any) => [s[0], s[1].type, s[1].key]),
    [
      ['Input.dispatchKeyEvent', 'keyDown', 'Enter'],
      ['Input.dispatchKeyEvent', 'keyUp', 'Enter'],
    ],
  );
});

test('origin_changed: the page leaves the site while the sheet shows, or before or while filling', async () => {
  // while the sheet shows: a navigation on the same site keeps it, another site ends it
  {
    const tab = makeTab({ top: { origin: 'https://a.example', fields: LOGIN } });
    const tabs = makeTabs(tab);
    const handoff = new CredentialHandoff();
    const { p, sheet } = await opened(handoff, () => requestCredentials({ tabs, handoff }, tab, {}, ctx()));
    tab.href = 'https://a.example/login?step=2';
    tab.wc.emit('did-navigate-in-page');
    assert.equal(handoff.list().length, 1);
    tab.href = 'https://evil.example/login';
    tab.wc.emit('did-navigate');
    assert.match(await p, /^status: origin_changed\n/);
    assert.equal(handoff.answer(sheet.id, { action: 'fill', values: { password: SECRET } }), false);
    assert.deepEqual(tab.sent, []);
  }
  // between the answer and the fill
  {
    const tab = makeTab({ top: { origin: 'https://a.example', fields: LOGIN } });
    const tabs = makeTabs(tab);
    const handoff = new CredentialHandoff();
    const { p, sheet } = await opened(handoff, () => requestCredentials({ tabs, handoff }, tab, {}, ctx()));
    tabs.ready = async () => {
      tab.href = 'https://evil.example/';
    };
    handoff.answer(sheet.id, { action: 'fill', values: { password: SECRET } });
    assert.match(await p, /^status: origin_changed\n/);
    assert.deepEqual(tab.sent, []);
  }
  // the fields' frame moved to another origin
  {
    const tab = makeTab({ top: { origin: 'https://a.example', fields: LOGIN } });
    const tabs = makeTabs(tab);
    const handoff = new CredentialHandoff();
    const { p, sheet } = await opened(handoff, () => requestCredentials({ tabs, handoff }, tab, {}, ctx()));
    tab.page[''].origin = 'https://evil.example';
    handoff.answer(sheet.id, { action: 'fill', values: { password: SECRET } });
    assert.match(await p, /^status: origin_changed\n/);
    assert.deepEqual(tab.sent, []);
  }
  // the page left during the fill: nothing is submitted
  {
    const tab = makeTab({ top: { origin: 'https://a.example', fields: LOGIN } });
    const tabs = makeTabs(tab);
    const handoff = new CredentialHandoff();
    const { p, sheet } = await opened(handoff, () => requestCredentials({ tabs, handoff }, tab, { submit: true }, ctx()));
    const send = tab.send.bind(tab);
    tab.send = async (...a: any[]) => {
      await send(...a);
      tab.href = 'https://evil.example/';
    };
    handoff.answer(sheet.id, { action: 'fill', values: { password: SECRET } });
    assert.match(await p, /^status: origin_changed\n/);
  }
});

test('declined, an empty fill, and user_took_over (the user signs in on the page, then the call returns)', async () => {
  for (const [answer, status] of [
    [{ action: 'decline' }, 'declined'],
    [{ action: 'fill', values: { otp: '1' } }, 'declined'],
  ] as const) {
    const tab = makeTab({ top: { origin: 'https://a.example', fields: LOGIN } });
    const tabs = makeTabs(tab);
    const handoff = new CredentialHandoff();
    const { p, sheet } = await opened(handoff, () => requestCredentials({ tabs, handoff }, tab, {}, ctx()));
    handoff.answer(sheet.id, answer);
    assert.equal((await p).split('\n')[0], `status: ${status}`);
    assert.deepEqual(tab.sent, []);
  }
  const tab = makeTab({ top: { origin: 'https://a.example', fields: LOGIN } });
  const tabs = makeTabs(tab);
  const handoff = new CredentialHandoff();
  const { p, sheet } = await opened(handoff, () => requestCredentials({ tabs, handoff }, tab, { reason: 'Sign in' }, ctx()));
  handoff.answer(sheet.id, { action: 'takeover' });
  assert.match(await p, /^status: user_took_over\n/);
  assert.deepEqual(tabs.calls.at(-1), ['requestSignin', 'Sign in']);
  // no reason given
  const tab2 = makeTab({ top: { origin: 'https://a.example', fields: LOGIN } });
  const tabs2 = makeTabs(tab2);
  const r2 = await opened(handoff, () => requestCredentials({ tabs: tabs2, handoff }, tab2, {}, ctx()));
  handoff.answer(r2.sheet.id, { action: 'takeover' });
  await r2.p;
  assert.deepEqual(tabs2.calls.at(-1), ['requestSignin', '']);
});

test('submission_failed: the text did not land, a field went stale, the fill threw, or the submit failed', async () => {
  const cases: Array<[string, any, (tab: any, tabs: any) => void]> = [
    ['dropped', { dropText: true }, () => {}],
    ['stale', {}, (tab) => (tab.agentImpl = async (op: string) => (op === 'credentialFocus' ? { error: 'stale' } : undefined))],
    ['check gone', {}, (tab) => (tab.agentImpl = async (op: string, a: any) => (op === 'credentialCheck' && !a.submit ? null : undefined))],
    ['threw', {}, (tab) => (tab.send = async () => Promise.reject(new Error(`CDP failed: ${SECRET}`)))],
    [
      'submit stale',
      {},
      (tab) => (tab.agentImpl = async (op: string, a: any) => (op === 'credentialCheck' && a.submit ? { error: 'stale' } : undefined)),
    ],
  ];
  for (const [name, o, patch] of cases) {
    const tab = makeTab({ top: { origin: 'https://a.example', fields: LOGIN }, ...o });
    const tabs = makeTabs(tab);
    const handoff = new CredentialHandoff();
    const { p, sheet } = await opened(handoff, () => requestCredentials({ tabs, handoff }, tab, { submit: true }, ctx()));
    patch(tab, tabs);
    handoff.answer(sheet.id, { action: 'fill', values: { username: USER, password: SECRET } });
    const out = await p;
    assert.match(out, /^status: submission_failed\n/, name);
    assert.ok(!out.includes(SECRET), name);
  }
});

test('the tab closing, the turn ending, and pages with no sign-in fields', async () => {
  // closed while the sheet shows
  {
    const tab = makeTab({ top: { origin: 'https://a.example', fields: LOGIN } });
    const tabs = makeTabs(tab);
    const handoff = new CredentialHandoff();
    const { p } = await opened(handoff, () => requestCredentials({ tabs, handoff }, tab, {}, ctx()));
    tab.wc.emit('destroyed');
    await assert.rejects(p, (e: any) => e.code === 'tab_closed');
  }
  // closed while filling: the tab_closed error passes through
  {
    const tab = makeTab({ top: { origin: 'https://a.example', fields: LOGIN } });
    const tabs = makeTabs(tab);
    const handoff = new CredentialHandoff();
    const { p, sheet } = await opened(handoff, () => requestCredentials({ tabs, handoff }, tab, {}, ctx()));
    tabs.ready = async () => {
      throw new ToolError('Tab t1 was closed.', 'tab_closed');
    };
    handoff.answer(sheet.id, { action: 'fill', values: { password: SECRET } });
    await assert.rejects(p, (e: any) => e.code === 'tab_closed');
  }
  // the turn ended
  {
    const tab = makeTab({ top: { origin: 'https://a.example', fields: LOGIN } });
    const tabs = makeTabs(tab);
    const handoff = new CredentialHandoff();
    const ac = new AbortController();
    const { p } = await opened(handoff, () => requestCredentials({ tabs, handoff }, tab, {}, ctx(ac.signal)));
    ac.abort();
    await assert.rejects(p, (e: any) => e.code === 'aborted');
  }
  const handoff = new CredentialHandoff();
  const blank = makeTab({ url: 'about:blank' });
  await assert.rejects(requestCredentials({ tabs: makeTabs(blank), handoff }, blank, {}, ctx()), /Open the sign-in page in t1 first/);
  const none = makeTab();
  await assert.rejects(
    requestCredentials({ tabs: makeTabs(none), handoff }, none, { refs: [] }, ctx()),
    (e: any) => e.code === 'no_fields' && /browser_request_signin/.test(e.message),
  );
});

test('saved logins: picked by id for this origin only, saved after a successful fill when asked, never in the store as plain text', async () => {
  const file = tmpFile();
  const store = new CredentialStore({ file, safeStorage: safeStorage() });
  const handoff = new CredentialHandoff({ store });
  const run = async (answer: any, o: any = {}) => {
    const tab = makeTab({ top: { origin: 'https://a.example', fields: [...LOGIN, { ref: 'ref_3', kind: 'otp', label: 'Code' }] }, ...o });
    const tabs = makeTabs(tab);
    const { p, sheet } = await opened(handoff, () => requestCredentials({ tabs, handoff }, tab, {}, ctx()));
    handoff.answer(sheet.id, typeof answer === 'function' ? answer(sheet) : answer);
    return { out: await p, tab };
  };
  // typed and saved
  const first = await run({ action: 'fill', values: { username: USER, password: SECRET }, save: true });
  assert.match(first.out, /^status: filled/);
  assert.ok(!fs.readFileSync(file, 'utf8').includes(SECRET));
  const [saved] = store.list('https://a.example');
  assert.equal(saved.username, USER);
  // a saved login and a typed code
  const second = await run((sheet: any) => ({ action: 'fill', savedId: sheet.saved[0].id, values: { otp: '999000' } }));
  assert.match(second.out, /^status: filled/);
  assert.deepEqual(second.tab.typed, { ref_1: USER, ref_2: SECRET, ref_3: '999000' });
  // typed values win over the saved ones
  const third = await run((sheet: any) => ({ action: 'fill', savedId: sheet.saved[0].id, values: { username: 'other' } }));
  assert.deepEqual(third.tab.typed, { ref_1: 'other', ref_2: SECRET });
  // not saved after a failed fill
  await run({ action: 'fill', values: { username: 'b', password: 'pw-b' }, save: true }, { dropText: true });
  assert.equal(store.list('https://a.example').length, 1);
  // a login saved for another site, or one that is gone, is never filled
  store.save('https://b.example', 'eve', 'evepw');
  const other = store.list('https://b.example')[0].id;
  const fourth = await run({ action: 'fill', savedId: other, values: {} });
  assert.match(fourth.out, /^status: submission_failed/);
  assert.deepEqual(fourth.tab.sent, []);
  // a username-less save, and no store at all
  await run({ action: 'fill', values: { password: 'solo' }, save: true });
  assert.ok(store.list('https://a.example').some((s: any) => s.username === ''));
  const bare = new CredentialHandoff();
  const tab = makeTab({ top: { origin: 'https://a.example', fields: LOGIN } });
  const r = await opened(bare, () => requestCredentials({ tabs: makeTabs(tab), handoff: bare }, tab, {}, ctx()));
  bare.answer(r.sheet.id, { action: 'fill', savedId: 'x', values: {} });
  assert.match(await r.p, /^status: submission_failed/);
  const tab2 = makeTab({ top: { origin: 'https://a.example', fields: LOGIN } });
  const r2 = await opened(bare, () => requestCredentials({ tabs: makeTabs(tab2), handoff: bare }, tab2, {}, ctx()));
  bare.answer(r2.sheet.id, { action: 'fill', values: { password: SECRET }, save: true });
  assert.match(await r2.p, /^status: filled/);
});

test('CredentialStore: unavailable encryption, unreadable files, replacing a login and forgetting it', () => {
  const file = tmpFile();
  const off = new CredentialStore({ file, safeStorage: safeStorage(false) });
  assert.equal(off.available(), false);
  assert.equal(off.save('https://a.example', 'u', 'p'), false);
  assert.equal(new CredentialStore({ file }).available(), false);
  const throwing = new CredentialStore({
    file,
    safeStorage: {
      isEncryptionAvailable: () => {
        throw new Error('no keychain');
      },
    } as any,
  });
  assert.equal(throwing.available(), false);
  const store = new CredentialStore({ file, safeStorage: safeStorage() });
  assert.deepEqual(store.list('https://a.example'), []);
  assert.equal(store.save('', 'u', 'p'), false);
  assert.equal(store.save('https://a.example', 'u', ''), false);
  assert.equal(store.save('https://a.example', null, 'p1'), true);
  assert.equal(store.save('https://a.example', '', 'p2'), true, 'the same username replaces the login');
  const [only] = store.list('https://a.example');
  assert.equal(store.list('https://a.example').length, 1);
  assert.deepEqual(store.get(only.id, 'https://a.example'), { username: '', password: 'p2' });
  assert.equal(store.get(only.id, 'https://b.example'), null);
  assert.equal(off.get(only.id, 'https://a.example'), null, 'no key: no password');
  const broken = new CredentialStore({
    file,
    safeStorage: {
      ...safeStorage(),
      decryptString: () => {
        throw new Error('bad key');
      },
    },
  });
  assert.equal(broken.get(only.id, 'https://a.example'), null);
  assert.equal(store.remove('nope'), false);
  assert.equal(store.remove(only.id), true);
  // entries without an id or origin are ignored; a file that is not a list is empty; missing usernames read as ''
  fs.writeFileSync(file, JSON.stringify([{ id: 'x' }, null, { id: 'y', origin: 'https://a.example', secret: '' }]));
  assert.deepEqual(store.list('https://a.example'), [{ id: 'y', username: '' }]);
  assert.equal(store.get('y', 'https://a.example')!.username, '');
  fs.writeFileSync(file, '{"not":"a list"}');
  assert.deepEqual(store.list('https://a.example'), []);
  // …but a save, an import or a delete never writes over logins it couldn't read
  assert.equal(store.save('https://a.example', 'u', 'p3'), false);
  assert.throws(
    () => store.saveMany([{ origin: 'https://a.example', username: 'u', password: 'p' }], 'import:x'),
    /Couldn't read the saved logins \(not a list of logins\)/,
  );
  assert.throws(() => store.remove('y'), /so they weren't changed/);
  assert.throws(() => store.deleteImported(null), /so they weren't changed/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{"not":"a list"}');
  // nor over a file that isn't JSON: it is kept, with a copy beside it
  fs.writeFileSync(file, '[{"id":"x","origin":"https://a.example"');
  assert.equal(store.save('https://a.example', 'u', 'p3'), false);
  assert.equal(fs.readFileSync(file, 'utf8'), '[{"id":"x","origin":"https://a.example"');
  assert.equal(fs.readFileSync(`${file}.unreadable`, 'utf8'), '{"not":"a list"}', 'the oldest unreadable copy stays intact');
  fs.rmSync(`${file}.unreadable`);
  fs.writeFileSync(file, '[]');
  // saving replaces the file whole: one left readable by others becomes private, and no temporary file stays
  fs.chmodSync(file, 0o644);
  assert.equal(store.save('https://a.example', 'u', 'p3'), true);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), [path.basename(file)]);
  // a folder where the file should be: saving fails quietly
  const dirStore = new CredentialStore({ file: path.dirname(file), safeStorage: safeStorage() });
  assert.equal(dirStore.save('https://a.example', 'u', 'p'), false);
});

/** The registered tool over a real OriginGrants and Registry with a file operation log. */
function toolWorld(o: any = {}) {
  const tab = makeTab({ top: { origin: 'https://a.example', fields: LOGIN } });
  const tabs: any = { ...makeTabs(tab), awaitUser: async (_t: any, p: unknown) => p };
  const grants = new OriginGrants({
    file: null,
    anchor: () => 'ask',
    ask: async () => ({ decision: 'allow', scope: 'once', level: o.level ?? 'write' }),
  });
  grants.set('https://a.example', o.level ?? 'write');
  const handoff = 'credentials' in o ? o.credentials : new CredentialHandoff();
  const logFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'oplog-')), 'operations.jsonl');
  const registry = new Registry({ log: new OperationLog({ file: logFile }) });
  for (const t of createBrowserTools({ tabs, grants, credentials: handoff, chromeRoute: o.chromeRoute })) registry.register(t);
  return { tab, tabs, handoff, registry, logFile };
}

test('browser_request_credentials still reports a completed fill when saving fails in the OS keychain', async () => {
  const file = tmpFile();
  const store = new CredentialStore({
    file,
    safeStorage: {
      ...safeStorage(),
      encryptString: () => {
        throw new Error(`Could not encrypt ${SECRET}`);
      },
    },
  });
  const w = toolWorld({ credentials: new CredentialHandoff({ store }) });
  const r = await opened(w.handoff, () => w.registry.invoke('c1', 's1', 'browser_request_credentials', {}, { callId: 'save-failure' }));
  w.handoff.answer(r.sheet.id, { action: 'fill', values: { username: USER, password: SECRET }, save: true });
  const res = await r.p;
  assert.equal(res.ok, true);
  assert.match(JSON.stringify(res), /status: filled/);
  assert.ok(!JSON.stringify(res).includes(SECRET));
  assert.ok(!fs.readFileSync(w.logFile, 'utf8').includes(SECRET));
  assert.equal(fs.existsSync(file), false);
});

test('browser_request_credentials through the Registry: the result and operation log carry a status, never a value', async () => {
  const w = toolWorld();
  const p = w.registry.invoke('c1', 's1', 'browser_request_credentials', { reason: 'Sign in to A' }, { callId: 'k1' });
  await waitFor(() => w.handoff.list().length, 'the sheet to open');
  w.handoff.answer(w.handoff.list()[0].id, { action: 'fill', values: { username: USER, password: SECRET } });
  const res = await p;
  assert.equal(res.ok, true);
  const text = JSON.stringify(res);
  assert.match(res.content[0].text, /^status: filled\n/);
  assert.equal(res.content.at(-1).text, 'STATE');
  assert.ok(!text.includes(SECRET) && !text.includes(USER));
  const log = fs.readFileSync(w.logFile, 'utf8');
  assert.match(log, /"tool":"browser_request_credentials"/);
  assert.match(log, /"argKeys":\["reason"\]/);
  assert.ok(!log.includes(SECRET) && !log.includes(USER) && !log.includes('Sign in to A'));
});

test("browser_request_credentials refuses in the user's own Chrome, without the sheet, and on a read-only site", async () => {
  const chrome = toolWorld({ chromeRoute: (chatId: string) => (chatId === 'c1' ? 'Your Chrome' : null) });
  const r1 = await chrome.registry.invoke('c1', 's1', 'browser_request_credentials', {});
  assert.equal(r1.ok, false);
  assert.equal(r1.error.code, 'wrong_browser');
  assert.match(
    r1.error.message,
    /This chat's browser is Your Chrome, where MoPilot can't fill a login\. Ask the user to sign in themselves in their Chrome/,
  );
  assert.match(
    r1.error.message,
    /<refusal reason="credentials_unavailable" retryable="false">\nnext: Ask the user in chat to sign in themselves in their Chrome/,
  );
  const none = toolWorld({ credentials: null, chromeRoute: () => null });
  const r2 = await none.registry.invoke('c1', 's1', 'browser_request_credentials', {});
  assert.equal(r2.error.code, 'wrong_browser');
  assert.match(r2.error.message, /Secure sign-in is unavailable here/);
  const readOnly = toolWorld({ level: 'read' });
  const r3 = await readOnly.registry.invoke('c1', 's1', 'browser_request_credentials', {});
  assert.equal(r3.error.code, 'read_only');
  assert.deepEqual(readOnly.handoff.list(), []);
});
