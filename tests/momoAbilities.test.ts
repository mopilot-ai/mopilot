// MoMo says only what it can reach now (#5803): the turn's context names the connected sources and accounts, and with no mail source it is told it cannot read or reply to mail, so it never offers to.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { abilitiesNote, momoBlock } = await import('../shared/momoContext.mjs');
const { memoryContextProvider } = require('../electron/momo/contract/context.cjs');
const { reachableNow } = require('../electron/momo/sources/index.cjs');

const NO_MAIL = /No mail source is connected: you can't read, search, watch or reply to the user's email/;
const emptyStore = { summary: () => ({ persona: '', aboutYou: '', facts: [] }), available: () => true };

test('with nothing connected MoMo names no sources and is told it has no mail', () => {
  const note = abilitiesNote({ sources: [], readsMail: false });
  assert.match(note, /What you can reach for the user now: no connected sources, plus the tools in this chat\./);
  assert.match(note, NO_MAIL);
  // a malformed answer reads as nothing connected and no mail
  assert.equal(abilitiesNote(null), note);
  assert.equal(abilitiesNote({ sources: 'Calendar' as any, readsMail: 'yes' as any }), note);
});

test('connected sources are named once each, and a mail source drops the no-mail line', () => {
  const note = abilitiesNote({ sources: [' Calendar ', 'Reminders', 'Calendar', '', 7], readsMail: false });
  assert.match(note, /now: Calendar, Reminders, plus the tools/);
  assert.match(note, NO_MAIL);
  const mail = abilitiesNote({ sources: ['Gmail'], readsMail: true });
  assert.match(mail, /now: Gmail, plus/);
  assert.doesNotMatch(mail, /No mail source/);
});

test('the block carries the note only when the caller passes what MoMo can reach', () => {
  const withIt = momoBlock({ name: 'MoMo', abilities: { sources: ['Calendar'], readsMail: false } }) as string;
  assert.match(withIt, NO_MAIL);
  assert.ok(withIt.indexOf('You are MoMo') < withIt.indexOf('What you can reach'), 'after who MoMo is');
  // on its own it is still a block (a MoMo chat with no memory yet still learns what it can do)
  assert.match(momoBlock({ abilities: { sources: [], readsMail: false } }) as string, NO_MAIL);
  // a caller that does not know (the Host's home today) says nothing about it
  assert.doesNotMatch(momoBlock({ name: 'MoMo' }) as string, /What you can reach/);
});

test('the provider asks what MoMo can reach at each turn, and a failing answer reads as nothing connected', () => {
  let reach: any = { sources: ['Calendar'], readsMail: false };
  const fn = memoryContextProvider({
    store: emptyStore,
    allowed: () => true,
    isMomoChat: () => true,
    name: () => 'MoMo',
    abilities: () => {
      if (reach instanceof Error) throw reach;
      return reach;
    },
  });
  assert.match(fn('momo-main', { query: '' }), /now: Calendar, plus/);
  reach = { sources: ['Calendar', 'Gmail'], readsMail: true };
  const connected = fn('momo-main', { query: '' });
  assert.match(connected, /now: Calendar, Gmail, plus/);
  assert.doesNotMatch(connected, /No mail source/);
  reach = new Error('sources not made yet');
  const failed = fn('momo-main', { query: '' });
  assert.match(failed, /no connected sources/);
  assert.match(failed, NO_MAIL);
  // no abilities given: no note
  const plain = memoryContextProvider({ store: emptyStore, allowed: () => true, isMomoChat: () => true, name: () => 'MoMo' });
  assert.doesNotMatch(plain('momo-main', { query: '' }), /What you can reach/);
});

test('reachableNow names ready sources and live accounts, and only a read of mail counts as reading mail', () => {
  const hub = {
    list: () => [
      { id: 'calendar', label: 'Calendar', connected: true },
      { id: 'reminders', label: 'Reminders', connected: true, needsGrant: true },
      { id: 'files', label: 'Files', connected: false },
    ],
  };
  const sendOnly = { label: 'Test mail (home)', connected: true, tools: [{ name: 'send_mail', kind: 'change' }] };
  const lost = { label: 'Old mail', connected: true, needsReconnect: true, tools: [{ name: 'read_mail', kind: 'read' }] };
  const notion = { label: 'Notion', connected: true, tools: [{ name: 'search', kind: 'read' }] };
  const off = { label: 'Gmail', connected: false, tools: [{ name: 'gmail_search', kind: 'read' }] };
  assert.deepEqual(reachableNow({ hub, connectorHub: { list: () => [sendOnly, lost, notion, off] } }), {
    sources: ['Calendar', 'Test mail (home)', 'Notion'],
    readsMail: false,
  });
  const gmail = { ...off, connected: true };
  assert.deepEqual(reachableNow({ hub, connectorHub: { list: () => [gmail] } }), { sources: ['Calendar', 'Gmail'], readsMail: true });
});
