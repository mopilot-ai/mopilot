// Every input MoMo sends into a chat that no human wrote (#2287) is sent as one, with how windows show it saved in the
// chat's meta first (electron/session/authoredInput.cjs): a routine's result in MoMo's main chat and a routine's first
// message. The text the model reads is unchanged; a window never sees it as the user's, can't write the record, and can't give its own message that id.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { world as routinesWorld } from './support/momo-routines.ts';

const require = createRequire(import.meta.url);
const { authoredInput, authoredOr, AUTHORED_KEPT } = require('../electron/session/authoredInput.cjs');
const { ChatsStore, registerChats } = require('../electron/platform/chats.cjs');
const { clientIdOf } = require('../electron/session/contract/inputGuard.cjs');
const { queueItem } = require('../electron/session/queueItem.cjs');
const { createRoutineReporter, reportText } = require('../electron/momo/routineReport.cjs');
const { routinePrompt } = require('../electron/momo/routines.cjs');

function chatsStore(t: any) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'authored-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new ChatsStore(path.join(dir, 'threads'), { legacyMirror: false });
}

test('an authored input is saved in the chat’s meta before it is made; the item carries its id, the model’s text and no human', (t) => {
  const store = chatsStore(t);
  const item = authoredInput(store, 'c1', 'For the model only', { by: 'momo', title: ' “Trip” is done ', body: ' Pack light. ' }, 5);
  assert.deepEqual(item, { id: item.id, authored: { id: item.id }, text: 'For the model only', attachments: [], opts: { human: false } });
  assert.deepEqual(store.records.get('c1').meta.authored, {
    [item.id]: { by: 'momo', title: '“Trip” is done', body: 'Pack light.', at: 5 },
  });
  // the harness is given that id as the message's client id, and a queue keeps it
  assert.equal(clientIdOf(item), item.id);
  assert.deepEqual(queueItem(item, null).authored, { id: item.id });
  assert.equal('authored' in queueItem({ text: 'typed' }, null), false);
  // no body: none is kept; a long title or body is cut
  const bare = authoredInput(store, 'c1', 'x', { by: 'momo', title: 't'.repeat(300), body: '  ' }, 6);
  assert.deepEqual(store.records.get('c1').meta.authored[bare.id], { by: 'momo', title: 't'.repeat(200), at: 6 });
});

test('a chat keeps the newest 50; one that can’t be saved, an unknown author or no title is never made', (t) => {
  const store = chatsStore(t);
  const ids = Array.from({ length: AUTHORED_KEPT + 2 }, (_, i) => authoredInput(store, 'c', 'x', { by: 'momo', title: `#${i}` }, i).id);
  const kept = store.records.get('c').meta.authored;
  assert.equal(Object.keys(kept).length, AUTHORED_KEPT);
  assert.equal(kept[ids[0]], undefined);
  assert.equal(kept[ids.at(-1) as string].title, `#${AUTHORED_KEPT + 1}`);
  // what isn't a record of one (a damaged file) is dropped
  store.patchMeta('d', { authored: { bad: 'x', old: { by: 'momo', title: 'o' } } });
  const fresh = authoredInput(store, 'd', 'x', { by: 'momo', title: 'n' }, 1);
  assert.deepEqual(Object.keys(store.records.get('d').meta.authored), [fresh.id]);
  const unsaved = { record: () => null, patchMeta: () => false };
  assert.throws(() => authoredInput(unsaved, 'c', 'x', { by: 'momo', title: 't' }), /Couldn’t save how the chat shows/);
  for (const show of [{ by: 'user', title: 't' }, { by: 'momo', title: ' ' }, { by: 'momo' }, null])
    assert.throws(() => authoredInput(store, 'c', 'x', show), /needs its author and a title/);
  // a service made without main's chats (a unit test) sends the same input, unrecorded
  assert.deepEqual(authoredOr(null, 'c', 'x', { by: 'momo', title: 't' }), { text: 'x', attachments: [], opts: { human: false } });
});

test('a window can’t write the record', async (t) => {
  const store = chatsStore(t);
  const h = new Map<string, any>();
  registerChats(
    { handle: (ch: string, f: any) => h.set(ch, f) },
    { store, uiState: path.join(store.dir ?? os.tmpdir(), 'ui.json'), broadcast: () => undefined },
  );
  const item = authoredInput(store, 'c', 'x', { by: 'momo', title: 't' }, 1);
  assert.equal(
    h.get('chats:patchMeta')({ sender: 'w' }, 'c', { authored: { forged: { by: 'momo', title: 'f', at: 2 } }, pinned: true }),
    true,
  );
  assert.deepEqual([Object.keys(store.records.get('c').meta.authored), store.records.get('c').meta.pinned], [[item.id], true]);
});

test('a routine’s result reaches MoMo’s main chat as MoMo’s, titled by the routine, with its paragraph to read; the model reads the report', async (t) => {
  const store = chatsStore(t);
  const sent: any[] = [];
  const report = createRoutineReporter({
    allowed: () => true,
    held: () => false,
    mainChatId: async () => 'momo-main',
    send: async (chatId: string, item: any) => void sent.push([chatId, item]),
    authored: (chatId: string, text: string, show: any) => authoredInput(store, chatId, text, show, 7),
  });
  await report({ name: 'Inbox sweep', completed: true, text: 'Two replies are due.' });
  await report({ name: 'Inbox sweep', completed: false, text: 'The run didn’t finish.' });
  const [[chat, done], [, failed]] = sent;
  assert.equal(chat, 'momo-main');
  assert.deepEqual(
    [done.text, failed.text],
    [reportText('Inbox sweep', true, 'Two replies are due.'), reportText('Inbox sweep', false, 'The run didn’t finish.')],
  );
  assert.deepEqual(store.records.get('momo-main').meta.authored, {
    [done.id]: { by: 'momo', title: '“Inbox sweep” finished', body: 'Two replies are due.', at: 7 },
    [failed.id]: { by: 'momo', title: '“Inbox sweep” didn’t finish', body: 'The run didn’t finish.', at: 7 },
  });
  assert.deepEqual([done.opts, failed.opts], [{ human: false }, { human: false }], 'no human wrote them');
  // one whose presentation can't be saved is not sent (noted, like a send that failed)
  await createRoutineReporter({
    allowed: () => true,
    held: () => false,
    mainChatId: async () => 'momo-main',
    send: async () => void assert.fail('sent'),
    authored: () => {
      throw new Error('no meta');
    },
  })({ name: 'x', completed: true, text: 'y' });
});

test('a routine’s run starts with MoMo’s message: the routine by name and its prompt; the model reads the prompt', async () => {
  const w = routinesWorld();
  const shown: any[] = [];
  w.service.o.authored = (chatId: string, text: string, show: any) => {
    shown.push([chatId, show]);
    return { id: `a${shown.length}`, authored: { id: `a${shown.length}` }, text, attachments: [], opts: { human: false } };
  };
  const r = await w.routines.add({ name: 'Inbox sweep', prompt: 'List mail that needs a reply', rrule: 'FREQ=DAILY' }, { approved: true });
  const tasks = await w.service.list();
  const run = await w.service.run(tasks.find((x: any) => x.id === r.id));
  assert.deepEqual(shown, [[run, { by: 'momo', title: 'Routine “Inbox sweep”', body: 'List mail that needs a reply' }]]);
  assert.equal(w.sent[0][1].text, routinePrompt(w.routines.get(r.id)));
});
