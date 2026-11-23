// A side chat made through the real panel is read back whole (#5202): its turns come from what the phone feed kept, with no phone attached, through `read` (the panel's) and `items` (a phone's snapshot), and a chat that is not a side chat still reads its saved history.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { setup } from './support/controller/fixture.ts';

const require = createRequire(import.meta.url);
const { createChromePanel, projectsFileOf } = require('../electron/app/chromePanel.cjs');

function wired(t: any) {
  const h = setup();
  t.after(() => fs.rmSync(h.chats.dir, { recursive: true, force: true }));
  h.chats.records.set('claude:parent', { id: 'claude:parent', segments: [{ kind: 'claude', nativeId: 'parent' }], meta: {} });
  const registered: any[] = [];
  const live: any = {
    chats: h.chats,
    controller: h.c,
    peerRuntime: { readHistory: async () => ({ turns: [], earlierContentOmitted: false }) },
    claudeTurns: { own: new Map(), sessions: new Map(), registerSession: (...a: any[]) => registered.push(a), setOwn: () => undefined },
  };
  const panel = createChromePanel({
    live,
    sources: {},
    home: h.chats.dir,
    projectsFile: projectsFileOf(h.chats.dir),
    prefs: () => ({}),
    usable: async () => true,
    starter: {},
    send: async () => ({ action: 'started', id: 'panel-input' }),
    open: () => {},
    cwdOf: async () => null,
  });
  const ask = (method: string, params: any) =>
    new Promise<any>((resolve) => {
      void panel.handle({ id: 1, method, params }, resolve);
    });
  /** One turn of the fork as the real Claude stream gives it: the phone's message goes out through the panel's send, the stream has the reply and the result and no user message. */
  const turn = async (key: string, id: string, question: string, answer: string) => {
    const reply = { type: 'assistant', uuid: `r-${id}`, message: { id: `r-${id}`, content: [{ type: 'text', text: answer }] } };
    await panel.o.send({ chatId: key, text: question, attachments: [], skills: [] });
    live.controller.onLiveEvent('claude', { kind: 'message', key, msg: reply });
    live.controller.onLiveEvent('claude', { kind: 'message', key, msg: { type: 'result', subtype: 'success' } });
  };
  return { panel, ask, turn, registered };
}
const textsOf = (rows: any[]) => rows.map((r) => String(r.text ?? ''));
const count = (rows: any[], word: string) => textsOf(rows).filter((x) => x.includes(word)).length;

test('a side chat read back by the panel and by a phone’s snapshot holds every turn once, though no phone was attached while it ran', async (t) => {
  const { panel, ask, turn, registered } = wired(t);
  assert.equal(panel.service.attached, false, 'no phone is attached');
  const id = await panel.o.sideChat('claude:parent');
  assert.match(id, /^claude:/);
  assert.equal(registered.length, 1);
  await turn(id, 'ct-a', 'What is the code word?', 'The code word is MANGO42');
  await turn(id, 'ct-b', 'And the second word?', 'The second word is KIWI7');
  const read = await ask('read', { chatId: id });
  assert.equal(read.error, undefined, JSON.stringify(read.error));
  for (const word of ['What is the code word?', 'MANGO42', 'And the second word?', 'KIWI7'])
    assert.equal(count(read.result.rows, word), 1, `${word} in ${JSON.stringify(textsOf(read.result.rows))}`);
  // a phone's snapshot: the turns before the live one as history, the live one as live items, each reply once
  const snap = await panel.o.items(id, 50);
  const shown = [...(snap.history ?? []), ...(snap.items ?? [])].map((x: any) => JSON.stringify(x));
  assert.equal(shown.filter((x) => x.includes('MANGO42')).length, 1);
  assert.equal(shown.filter((x) => x.includes('KIWI7')).length, 1);
});

test('asking again answers the same side chat, and a chat that is not one reads its saved history as before', async (t) => {
  const { panel, ask } = wired(t);
  const id = await panel.o.sideChat('claude:parent');
  assert.equal(await panel.o.sideChat('claude:parent'), id);
  const parent = await ask('read', { chatId: 'claude:parent' });
  assert.equal(parent.error, undefined, JSON.stringify(parent.error));
  assert.deepEqual(parent.result.rows, [], 'the parent has nothing saved here, and none of the fork’s rows');
});
