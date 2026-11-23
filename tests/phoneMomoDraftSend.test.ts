// A draft the user sent on the Mac, as the classic phone shows it (mobile/src/screens/MomoDraft.tsx over the note row): the Mac's note keeps how far the send got (shared/chatNotes.mjs, chromePanelLive.cjs rows), the phone reads it checked, and the card is read only, with the account and one line per step ("Asked to send", "You chose Send", the sent line) and no button left; the phone itself never sends. The words are in both catalogs.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { momoRuntime, mountMomo, snapshotOf } from './support/phone/momo-kit';

const require = createRequire(import.meta.url);
const { rowsOf } = require('../electron/capabilities/browser/chromePanelLive.cjs');
const { withChatNotes } = require('../shared/chatNotes.mjs');

const enPath = '../mobile/src/ui/i18n/locales/en';
const zhPath = '../mobile/src/ui/i18n/locales/zh-Hans';
const en = (await import(enPath)).default;
const zh = (await import(zhPath)).default;
const contractPath = '../mobile/src/momo/stateContract';
const { sendOfRow } = await import(contractPath);

const DRAFT = { to: ['sam@example.com'], subject: 'Re: lunch', body: 'Friday works.' };
const FROM = { id: 'home', label: 'Test mail (home)', account: 'home@mail.test' };
const send = (state: string, from: any = FROM) => ({ state, from, at: 5 });
const row = (s?: any) => ({ role: 'note', text: 'Draft · Re: lunch', draft: DRAFT, ...(s ? { send: s } : {}) });
const chat = (rows: any[]) =>
  momoRuntime({
    'machine.hello': () => ({ v: 1, capabilities: { momo: true, methods: ['momo.state.get', 'momo.prefs.get', 'momo.prefs.set'] } }),
    'momo.chat.follow': () => ({ ...snapshotOf([], rows), itemsShape: 'rows' }),
    'momo.chat.unfollow': () => ({}),
    'momo.brain.get': () => ({ brain: null }),
    'momo.routines.list': () => ({ proposals: [], routines: [] }),
    'momo.sources.status': () => ({ calendar: true, reminders: true }),
    'momo.state.get': () => ({ name: 'MoMo', status: 'online', needsYou: 0 }),
    'momo.prefs.get': () => ({ paused: false, proactivity: 'default', quietHours: null, levels: [{ id: 'default' }] }),
  });
const card = () => document.querySelector('[aria-label="Draft"]') as HTMLElement | null;
afterEach(() => undefined);

test("the Mac's rows carry a draft's send, checked; a send that is not one is dropped", () => {
  const note = (extra: object) => ({
    id: 'd1',
    kind: 'draft',
    text: 'Draft · Re: lunch',
    turnId: 'ct-1',
    turn: 0,
    at: 1,
    draft: DRAFT,
    ...extra,
  });
  const turns = [{ id: 'ct-1', items: [{ type: 'agentMessage', id: 'i1', text: 'Here is a draft.' }] }];
  const placed = withChatNotes(turns, [note({ send: send('sent') })]);
  assert.deepEqual(placed[0].items.at(-1).send, send('sent'));
  assert.equal('send' in withChatNotes(turns, [note({})])[0].items.at(-1), false);
  assert.deepEqual(rowsOf(placed).rows[1].send, send('sent'));
  assert.equal('send' in rowsOf(withChatNotes(turns, [note({})])).rows[1], false);
  assert.equal('send' in rowsOf(withChatNotes(turns, [note({ send: { state: 'later' } })])).rows[1], false);
});

test("the phone reads a row's send checked, for a note row only", () => {
  assert.deepEqual(sendOfRow(row(send('chose'))), send('chose'));
  assert.equal(sendOfRow(row()), null);
  assert.equal(sendOfRow({ ...row(send('sent')), role: 'assistant' }), null);
  assert.equal(sendOfRow(row({ state: 'sent' })), null);
  assert.equal(sendOfRow(null), null);
});

test('a sent draft is read only: the account and the three lines, no Edit, Copy or Open in Mail', async () => {
  const view = await mountMomo(chat([row(send('sent'))]));
  const c = card()!;
  assert.deepEqual(
    [...c.querySelectorAll('button')].map((b) => b.textContent),
    [],
  );
  assert.match(c.textContent!, /Fromhome@mail\.test/);
  assert.match(c.textContent!, /Asked to sendYou chose SendSent from home@mail\.test/);
  assert.match(c.textContent!, /Friday works\./);
  await view.unmount();
});

test('a send that is only asked says so, and one the Mac is not sure of names where to look', async () => {
  const asked = await mountMomo(chat([row(send('asked'))]));
  assert.match(card()!.textContent!, /Asked to send$/);
  await asked.unmount();
  const chose = await mountMomo(chat([row(send('chose', { ...FROM, account: '' }))]));
  assert.match(card()!.textContent!, /FromTest mail \(home\)Asked to sendYou chose Send$/);
  await chose.unmount();
  const unsure = await mountMomo(chat([row(send('unsure'))]));
  assert.match(card()!.textContent!, /Not sure this was sent\. Check Sent mail in home@mail\.test\./);
  await unsure.unmount();
});

test('with Reduce Motion the lines still show, with no arrival', async () => {
  (globalThis as any).__phoneReduceMotion = true;
  const view = await mountMomo(chat([row(send('chose'))]));
  assert.match(card()!.textContent!, /Asked to sendYou chose Send$/);
  await view.unmount();
  (globalThis as any).__phoneReduceMotion = false;
});

test('a draft with no send keeps its three buttons', async () => {
  const view = await mountMomo(chat([row()]));
  assert.deepEqual(
    [...card()!.querySelectorAll('button')].map((b) => b.textContent),
    ['Edit', 'Copy', 'Open in Mail'],
  );
  await view.unmount();
});

test('the words are in both catalogs, with the account in its hole', () => {
  for (const [name, c] of [
    ['en', en],
    ['zh-Hans', zh],
  ] as const) {
    for (const key of ['from', 'sendAsked', 'sendChose', 'sendSent', 'sendUnsure']) assert.ok(c.momoDraft[key], `${name} ${key}`);
    assert.match(c.momoDraft.sendSent, /\{\{from\}\}/);
    assert.match(c.momoDraft.sendUnsure, /\{\{from\}\}/);
  }
});
