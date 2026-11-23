// A draft MoMo wrote, as the card in MoMo's chat on the classic phone (mobile/src/screens/MomoDraft.tsx over the Mac's note row): who it is for, its subject and words with Edit, Copy (the phone's clipboard) and Open in Mail (the phone's own mail link, built from the checked draft); a draft too long for a link says Copy it instead, no mail app is a short line, Edit changes this card only, and nothing is asked of or sent to the Mac; the words are in the catalog in both languages.
import { test, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { checkSecureKey, checkSecureValue } from './support/phone/secure-store-rules.ts';
import { click, flush, act } from './support/phone/component-kit';
import { momoRuntime, mountMomo, snapshotOf } from './support/phone/momo-kit';

// the phone's keychain, in memory: the draft-open pick is kept there (platform/draftPick.ts loads it on first use)
const require = createRequire(new URL('../mobile/package.json', import.meta.url));
const keychain = new Map<string, string>();
let keychainFails = false;
mock.module(require.resolve('expo-secure-store'), {
  namedExports: {
    getItemAsync: async (name: string) => (checkSecureKey(name), keychain.get(name) ?? null),
    setItemAsync: async (name: string, value: string) => {
      checkSecureKey(name);
      checkSecureValue(value);
      if (keychainFails) throw new Error('keychain locked');
      keychain.set(name, value);
    },
    deleteItemAsync: async (name: string) => (checkSecureKey(name), void keychain.delete(name)),
  },
});
const PICK = 'momo-draft-open';

const enPath = '../mobile/src/ui/i18n/locales/en';
const zhPath = '../mobile/src/ui/i18n/locales/zh-Hans';
const en = (await import(enPath)).default;
const zh = (await import(zhPath)).default;
const contractPath = '../mobile/src/momo/stateContract';
const { draftOfRow } = await import(contractPath);

const DRAFT = { to: ['sam@example.com', 'lee@example.com'], subject: 'Re: lunch', body: 'Friday works.' };
const ROW = { role: 'note', text: 'Draft · Re: lunch', draft: DRAFT };
const g = globalThis as any;
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
const label = (name: string) => document.querySelector(`[aria-label="${name}"]`) as HTMLElement | null;
async function type(name: string, value: string) {
  const el = label(name) as HTMLInputElement;
  assert.ok(el, `a field ${name}`);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
afterEach(() => {
  g.__openedUrls = [];
  g.__linkFails = false;
  g.__phoneSchemes = undefined;
  g.__phoneShared = undefined;
  g.__phoneShareFails = false;
  g.__phoneProbeFails = false;
  keychain.clear();
  keychainFails = false;
  g.__clipboard = undefined;
  g.__clipboardFails = false;
});

test('the card shows who it is for, its subject and words with Edit, Copy and Open in Mail, and nothing that sends', async () => {
  const m = chat([ROW, { role: 'assistant', text: 'Here is a draft.' }]);
  const view = await mountMomo(m);
  assert.match(view.text(), /DraftTo · 2sam@example\.com, lee@example\.comSubjectRe: lunchFriday works\./);
  for (const name of ['Edit', 'Copy', 'Open in Mail']) assert.ok(label(name), name);
  const card = label('Draft')!;
  assert.deepEqual(
    [...card.querySelectorAll('button')].map((b) => b.textContent),
    ['Edit', 'Copy', 'Open in Mail'],
    'the card has these three and no send control',
  );
  assert.match(view.text(), /Here is a draft\./);
  await view.unmount();
});

test('one recipient reads To, none reads No recipient, no subject reads No subject; a row that is not a draft is a quiet line', async () => {
  const one = await mountMomo(chat([{ ...ROW, draft: { to: ['sam@example.com'], subject: 'S', body: 'b' } }]));
  assert.match(one.text(), /DraftTosam@example\.comSubjectS/);
  await one.unmount();
  const none = await mountMomo(chat([{ ...ROW, draft: { to: [], subject: '', body: 'b' } }]));
  assert.match(none.text(), /No recipient/);
  assert.match(none.text(), /No subject/);
  await none.unmount();
  const plain = await mountMomo(chat([{ role: 'note', text: 'Draft · odd', draft: { to: ['nope'], body: 'x' } }]));
  assert.match(plain.text(), /Draft · odd/);
  assert.equal(label('Open in Mail'), null);
  await plain.unmount();
});

test('Copy puts the body on the phone’s clipboard and says so; a clipboard that refuses says so too', async () => {
  const view = await mountMomo(chat([ROW]));
  await click('Copy');
  assert.equal(g.__clipboard, 'Friday works.');
  assert.match(view.text(), /Copied/);
  g.__clipboardFails = true;
  await click('Copy');
  assert.match(view.text(), /Couldn’t copy/);
  await view.unmount();
});

test('Open in Mail opens the phone’s mail link and asks the Mac for nothing; a link the system refuses goes to the share sheet, and with none open it is a short line and the draft stays', async () => {
  const m = chat([ROW]);
  const view = await mountMomo(m);
  const calls = m.calls.length;
  await click('Open in Mail');
  assert.deepEqual(g.__openedUrls, ['mailto:sam@example.com,lee@example.com?subject=Re%3A%20lunch&body=Friday%20works.']);
  assert.equal(m.calls.length, calls, 'nothing was asked of the Mac');
  g.__linkFails = true;
  await click('Open in Mail');
  assert.equal(g.__phoneShared.length, 1, 'the share sheet carries it');
  assert.match(g.__phoneShared[0], /^To: sam@example\.com, lee@example\.com\n\nSubject: Re: lunch\n\nFriday works\./);
  assert.doesNotMatch(view.text(), /Couldn’t open a mail app\./);
  g.__phoneShareFails = true;
  await click('Open in Mail');
  assert.match(view.text(), /Couldn’t open a mail app\./);
  assert.match(view.text(), /Friday works\./);
  await view.unmount();
});

const picked = async (name: string) => {
  await click('Open with');
  await click(name);
};

test('with Gmail installed the person chooses once: the button asks, the pick opens, is remembered, and is the one tap next time', async () => {
  g.__phoneSchemes = ['googlegmail'];
  const view = await mountMomo(chat([ROW]));
  await flush();
  assert.ok(label('Open in…'));
  assert.equal(label('Open with'), null, 'no chevron before there is a pick');
  assert.deepEqual(g.__openedUrls, []);
  // the button opens the chooser, which offers each way; nothing opens until one is picked
  await click('Open in…');
  assert.ok(label('Gmail') && label('Mail') && label('Share…'));
  assert.deepEqual(g.__openedUrls, []);
  await click('Gmail');
  assert.deepEqual(g.__openedUrls, ['googlegmail:///co?to=sam%40example.com,lee%40example.com&subject=Re%3A%20lunch&body=Friday%20works.']);
  assert.equal(keychain.get(PICK), 'gmail');
  // now the button is the pick, and the chooser is behind the chevron
  assert.ok(label('Open in Gmail') && label('Open with'));
  assert.equal(label('Gmail'), null, 'the chooser closed');
  g.__openedUrls = [];
  await click('Open in Gmail');
  assert.equal(g.__openedUrls.length, 1);
  assert.match(g.__openedUrls[0], /^googlegmail:/);
  await view.unmount();
  // a new card on this phone starts from the pick
  const again = await mountMomo(chat([ROW]));
  await flush();
  assert.ok(label('Open in Gmail'));
  await again.unmount();
});

test('the chevron’s chooser changes the pick: Mail opens the mail link, Share opens the sheet, and each is remembered', async () => {
  g.__phoneSchemes = ['googlegmail'];
  keychain.set(PICK, 'gmail');
  const view = await mountMomo(chat([ROW]));
  await flush();
  await picked('Mail');
  assert.match(g.__openedUrls.at(-1), /^mailto:sam@example\.com,lee@example\.com\?subject=/);
  assert.equal(keychain.get(PICK), 'mail');
  assert.ok(label('Open in Mail'));
  await picked('Share…');
  assert.match(g.__phoneShared[0], /^To: sam@example\.com, lee@example\.com\n\nSubject: Re: lunch\n\nFriday works\./);
  assert.equal(keychain.get(PICK), 'share');
  assert.ok(label('Share'));
  // the chooser can be opened and closed again without picking
  await click('Open with');
  assert.ok(label('Gmail'));
  await click('Open with');
  assert.equal(label('Gmail'), null);
  await view.unmount();
});

test('a remembered Gmail that is no longer installed is forgotten and the default applies; a pick that fails to open is forgotten too', async () => {
  keychain.set(PICK, 'gmail');
  const gone = await mountMomo(chat([ROW]));
  await flush();
  assert.ok(label('Open in Mail'));
  assert.equal(label('Open with'), null);
  assert.equal(keychain.has(PICK), false, 'the pick is dropped');
  await gone.unmount();
  // installed, remembered, but the link is refused when tried: the others are tried, the pick is dropped
  g.__phoneSchemes = ['googlegmail'];
  keychain.set(PICK, 'gmail');
  const refused = await mountMomo(chat([ROW]));
  await flush();
  g.__linkFails = true;
  await click('Open in Gmail');
  assert.equal(g.__phoneShared.length, 1, 'it went to the share sheet');
  assert.equal(keychain.has(PICK), false);
  assert.ok(label('Open in…'));
  // a pick made in the chooser that could not open is not remembered, and another remembered pick stays
  keychain.set(PICK, 'mail');
  g.__phoneSchemes = ['googlegmail'];
  await refused.unmount();
  const other = await mountMomo(chat([ROW]));
  await flush();
  await picked('Gmail');
  assert.equal(keychain.get(PICK), 'mail');
  await other.unmount();
});

test('a keychain that will not keep the pick does not stop the draft opening', async () => {
  g.__phoneSchemes = ['googlegmail'];
  keychainFails = true;
  const view = await mountMomo(chat([ROW]));
  await flush();
  await click('Open in…');
  await click('Mail');
  assert.equal(g.__openedUrls.length, 1);
  assert.equal(keychain.size, 0);
  await view.unmount();
});

test('a phone that cannot be asked whether Gmail is installed offers the mail link', async () => {
  g.__phoneSchemes = ['googlegmail'];
  g.__phoneProbeFails = true;
  const view = await mountMomo(chat([ROW]));
  await flush();
  assert.ok(label('Open in Mail'));
  assert.equal(label('Open in Gmail'), null);
  await view.unmount();
});

test('a draft too long for a link says Share and hands the whole text to the share sheet; Copy still works', async () => {
  const view = await mountMomo(chat([{ ...ROW, draft: { to: [], subject: '', body: 'word '.repeat(600) } }]));
  assert.equal(label('Open in Mail'), null);
  assert.ok(label('Share'));
  await click('Copy');
  assert.equal(g.__clipboard, 'word '.repeat(600));
  assert.deepEqual(g.__openedUrls, []);
  await click('Share');
  assert.equal(g.__phoneShared[0], 'word '.repeat(600));
  assert.deepEqual(g.__openedUrls, []);
  await view.unmount();
  // with Gmail installed and a pick, a draft too long for a link is still shared, with no chooser, and the pick is kept
  g.__phoneSchemes = ['googlegmail'];
  keychain.set(PICK, 'gmail');
  const kept = await mountMomo(chat([{ ...ROW, draft: { to: [], subject: '', body: 'word '.repeat(600) } }]));
  await flush();
  assert.ok(label('Share'));
  assert.equal(label('Open with'), null);
  assert.equal(keychain.get(PICK), 'gmail');
  await kept.unmount();
});

test('Edit changes the subject and the words on this card only; Cancel puts them back; an empty or too long edit stays in the editor', async () => {
  const m = chat([ROW]);
  const view = await mountMomo(m);
  await click('Edit');
  assert.ok(label('Done') && label('Cancel'));
  assert.equal(label('Open in Mail'), null);
  await type('Draft text', 'changed');
  await click('Cancel');
  assert.match(view.text(), /Friday works\./);
  await click('Edit');
  await type('Draft text', '   ');
  await click('Done');
  assert.match(view.text(), /Add some text/);
  assert.ok(label('Done'), 'still editing');
  await type('Draft text', 'x'.repeat(100));
  await type('Subject', 'y'.repeat(300));
  await click('Done');
  assert.match(view.text(), /Too long/);
  await type('Subject', 'Re: Friday lunch');
  await type('Draft text', 'Noon works for me.');
  await click('Done');
  assert.match(view.text(), /Re: Friday lunchNoon works for me\./);
  await click('Open in Mail');
  assert.deepEqual(g.__openedUrls, ['mailto:sam@example.com,lee@example.com?subject=Re%3A%20Friday%20lunch&body=Noon%20works%20for%20me.']);
  await view.unmount();
});

test('the draft on a row is read as the Mac reads it, and the words are in both catalogs', () => {
  assert.deepEqual(draftOfRow(ROW), DRAFT);
  for (const v of [null, { role: 'assistant', draft: DRAFT }, { role: 'note' }, { role: 'note', draft: { body: '' } }])
    assert.equal(draftOfRow(v), null);
  assert.deepEqual(Object.keys(zh.momoDraft).sort(), Object.keys(en.momoDraft).sort());
  assert.equal(zh.momoDraft.openInMail, '在邮件中打开');
  assert.equal(en.momoDraft.openInMail, 'Open in Mail');
  // the draft's words are never a harness's name
  assert.doesNotMatch(JSON.stringify(en.momoDraft) + JSON.stringify(zh.momoDraft), /claude|codex|acp/i);
});
