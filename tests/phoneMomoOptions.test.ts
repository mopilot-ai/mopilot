// The answer chips on the phone's path (issue #5021, shared/momoOptions.mjs): in a MoMo chat a reply's last `Options: A | B | C` line leaves the text and comes as `options`, in the saved rows (open and paging back) and in the live items (a snapshot and the events), the same for a Claude and a Codex chat; any other chat, a chat of a Mac with MoMo off and a reply with no valid line are sent as they are, with no `options` key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { withOptions } from '../shared/momoOptions.mjs';

const require = createRequire(import.meta.url);
const { recentRowsOf, olderRowsOf } = require('../electron/capabilities/browser/chromePanelLive.cjs');
const { phoneMessageItems } = require('../electron/app/phoneMessageItems.cjs');
const { isPhoneMomoChat } = require('../electron/app/phoneMomoChat.cjs');
const { openPhoneItems } = require('../electron/app/chromePanelPhones.cjs');
const { createPanelOlder } = require('../electron/app/chromePanelOlder.cjs');
const { createOpenReads } = require('../electron/app/chromePanelOpenRead.cjs');

const QUESTION = 'Shall I move your 3 pm?\nOptions: Yes | No | Not now';
const ASKED = { text: 'Shall I move your 3 pm?', options: ['Yes', 'No', 'Not now'] };
const turn = (items: any[]) => [{ id: 't', status: 'completed', items }];
const reply = (id: string, text: string, extra: any = {}) => ({ type: 'agentMessage', id, text, ...extra });

test('withOptions: the same object without a valid line, else the text without it and the labels', () => {
  const plain = { id: 'a', text: 'Hello' };
  assert.equal(withOptions(plain), plain);
  assert.equal(withOptions({ text: 'Options: a | b' }).text, 'Options: a | b', 'only the line: left as written');
  assert.deepEqual(withOptions({ id: 'a', text: QUESTION }), { id: 'a', ...ASKED });
});

test('saved rows: a MoMo chat’s question carries its options and no line; other rows and other chats do not', () => {
  const items = [
    { type: 'userMessage', id: 'u', content: [{ type: 'text', text: 'Options: a | b' }] },
    reply('a1', QUESTION),
    reply('a2', 'Plain answer'),
    reply('a3', 'Hm?\nOptions: only'),
  ];
  const momo = recentRowsOf(turn(items), { momo: true }).rows;
  assert.deepEqual(
    momo.map((r: any) => [r.role, r.text, r.options]),
    [
      ['user', 'Options: a | b', undefined],
      ['assistant', ASKED.text, ASKED.options],
      ['assistant', 'Plain answer', undefined],
      ['assistant', 'Hm?\nOptions: only', undefined],
    ],
  );
  assert.equal(momo.filter((r: any) => 'options' in r).length, 1, 'absent, never empty');
  const other = recentRowsOf(turn(items), {}).rows;
  assert.deepEqual(other[1].text, QUESTION);
  assert.equal(
    other.some((r: any) => 'options' in r),
    false,
  );
  // a very long reply keeps saying it was cut
  const long = recentRowsOf(turn([reply('l', `${'x'.repeat(21_000)}\nOptions: a | b`)]), { momo: true }).rows[0];
  assert.equal(long.truncated, true);
  assert.deepEqual(long.options, ['a', 'b']);
});

test('a Codex row and a Claude row give the same options, in the saved rows and as live items', () => {
  const codex = reply('m1', QUESTION, { phase: 'final_answer', memoryCitation: null });
  const claude = reply('m2', QUESTION, { claudeMessageId: 'msg_1' });
  const rows = recentRowsOf(turn([codex, claude]), { momo: true }).rows;
  assert.deepEqual([rows[0].options, rows[1].options], [ASKED.options, ASKED.options]);
  assert.deepEqual([rows[0].text, rows[1].text], [ASKED.text, ASKED.text]);
  const live = phoneMessageItems([codex, claude], 'tu', true);
  assert.deepEqual(
    live.map((i: any) => [i.text, i.options, i.phase ?? i.claudeMessageId]),
    [
      [ASKED.text, ASKED.options, 'final_answer'],
      [ASKED.text, ASKED.options, 'msg_1'],
    ],
  );
});

test('live items: only a MoMo chat’s agent messages change; images, other items and other chats keep their shape', () => {
  const user = {
    type: 'userMessage',
    id: 'u',
    content: [
      { type: 'text', text: QUESTION },
      { type: 'localImage', path: '/p' },
    ],
  };
  const step = { type: 'commandExecution', id: 'c', text: QUESTION };
  const ask = reply('a', QUESTION);
  const [u, s, a] = phoneMessageItems([user, step, ask], 'tu', true);
  assert.equal(u.content[0].text, QUESTION, 'a person’s words are never read for options');
  assert.deepEqual(u.content[1], { type: 'image' });
  assert.equal(s.text, QUESTION);
  assert.equal(a.options.length, 3);
  const [, , plain] = phoneMessageItems([user, step, ask], 'tu');
  assert.equal(plain, ask);
  assert.equal('options' in plain, false);
});

test('which chats are MoMo’s for a phone: MoMo is on and the record says so', () => {
  const records = new Map<string, any>([
    ['m', { meta: { momo: 'main' } }],
    ['c', { meta: {} }],
  ]);
  const on = { momo: {}, chats: { records } };
  assert.equal(isPhoneMomoChat(on, 'm'), true);
  assert.equal(isPhoneMomoChat(on, 'c'), false);
  assert.equal(isPhoneMomoChat(on, 'gone'), false);
  assert.equal(isPhoneMomoChat({ chats: { records } }, 'm'), false, 'MoMo off: nothing of it is read');
  assert.equal(isPhoneMomoChat({ momo: {} }, 'm'), false);
});

test('opening a chat and paging back give MoMo rows their options, and never another chat’s', async () => {
  const records = new Map<string, any>([
    ['m', { meta: { momo: 'main' } }],
    ['c', { meta: {} }],
  ]);
  const items = [reply('a', QUESTION), reply('b', 'Next'), reply('c', 'Last')];
  const historyOf: any = async () => ({ turns: turn(items) });
  historyOf.recent = async () => ({ turns: turn(items) });
  const live = (momo: boolean) => ({
    ...(momo && { momo: {} }),
    chats: { records },
    controller: { state: { get: () => ({ turn: null }) } },
  });
  const rowsOf = async (chatId: string, on = true) =>
    createOpenReads({ live: live(on), reachable: () => true, historyOf }).rows(chatId, 10);
  assert.deepEqual((await rowsOf('m'))[0].options, ASKED.options);
  assert.equal('options' in (await rowsOf('c'))[0], false);
  assert.equal('options' in (await rowsOf('m', false))[0], false, 'MoMo off');
  const last = recentRowsOf(turn(items), { momo: true }).rows[2].id;
  const older = (chatId: string, on = true) => createPanelOlder({ live: live(on), reachable: () => true, historyOf })(chatId, last, 10);
  assert.deepEqual((await older('m')).rows[0].options, ASKED.options);
  assert.equal('options' in (await older('c')).rows[0], false);
  assert.equal(olderRowsOf(turn(items), last, 10, true).rows[0].text, ASKED.text);
  assert.equal(olderRowsOf(turn(items), last, 10).rows[0].text, QUESTION);
});

test('the phone’s live path: a Claude and a Codex chat each send the reply as text and options, from the snapshot and from the events', async () => {
  const feedOf = (momo: boolean | undefined) => {
    const sent: any[] = [];
    const service = { attached: true, onFeedEvent: (e: any) => sent.push(e) };
    const phones = openPhoneItems({
      service: () => service,
      chatOf: (key: string) => key,
      rows: async () => [],
      ...(momo !== undefined && { momoChat: () => momo }),
    });
    return { phones, sent };
  };
  const claudeAnswer = (uuid: string, text: string) => ({
    type: 'assistant',
    uuid,
    message: { id: uuid, content: [{ type: 'text', text }] },
  });
  const run = {
    codex: (phones: any) =>
      phones.live('codex', {
        method: 'item/completed',
        params: { threadId: 'chat-codex', turnId: 'tu', item: { type: 'agentMessage', id: 'm', text: QUESTION } },
      }),
    claude: (phones: any) => {
      const key = 'chat-claude';
      phones.live('claude', { kind: 'turnStarting', key, turnId: 'ct', clientId: 'a', text: 'Plan my day' });
      phones.live('claude', { kind: 'message', key, msg: claudeAnswer('t1', QUESTION) });
      phones.live('claude', { kind: 'message', key, msg: { type: 'result', subtype: 'success' } });
    },
  };
  // a MoMo chat on each harness: the same options, from the snapshot and from the events; not MoMo's (or no answer about it): the line stays text
  for (const [harness, chatId] of [
    ['codex', 'chat-codex'],
    ['claude', 'chat-claude'],
  ] as const) {
    for (const momo of [true, false, undefined]) {
      const { phones, sent } = feedOf(momo);
      run[harness](phones);
      const snap = await phones.items(chatId, 10);
      assert.equal(snap.itemsShape, 'items');
      const shown = snap.items.find((i: any) => i.type === 'agentMessage');
      assert.equal(shown.text, momo ? ASKED.text : QUESTION, `${harness} ${momo}`);
      assert.equal('options' in shown, !!momo);
      if (momo) assert.deepEqual(shown.options, ASKED.options);
      const event = sent.find((e) => e.items?.some((i: any) => i.type === 'agentMessage'));
      const sentItem = event.items.find((i: any) => i.type === 'agentMessage');
      assert.equal('options' in sentItem, !!momo, `${harness} ${momo} event`);
      phones.forget(chatId);
    }
  }
});

test('the real panel wiring: a phone opening a MoMo chat on either harness reads the question as text and options; another chat reads it as written', async (t) => {
  const fs = await import('node:fs');
  const { setup } = await import('./support/controller/fixture.ts');
  const { createChromePanel, projectsFileOf } = require('../electron/app/chromePanel.cjs');
  for (const kind of ['claude', 'codex']) {
    const h = setup();
    t.after(() => fs.rmSync(h.chats.dir, { recursive: true, force: true }));
    h.chats.records.set('m', { id: 'm', segments: [{ kind, nativeId: 'm' }], meta: { momo: 'main' } } as any);
    h.chats.records.set('c', { id: 'c', segments: [{ kind, nativeId: 'c' }], meta: {} } as any);
    const turns = [{ id: 't', status: 'completed', items: [reply('a', QUESTION)] }];
    const open = (live: any) =>
      createChromePanel({
        live,
        sources: {},
        home: h.chats.dir,
        projectsFile: projectsFileOf(h.chats.dir),
        prefs: () => ({}),
        usable: async () => true,
        starter: {},
        send: async () => {},
        open: () => {},
      });
    const base = { chats: h.chats, controller: h.c, peerRuntime: { readHistory: async () => ({ turns }) } };
    const on = open({ ...base, momo: { mainChat: { usable: () => true } } });
    const read = async (panel: any, id: string) => (await panel.service.ops.items(id, 10)).items[0];
    const first = await read(on, 'm');
    assert.deepEqual([first.text, first.options], [ASKED.text, ASKED.options], kind);
    assert.equal((await read(on, 'c')).text, QUESTION, `${kind}: another chat`);
    // MoMo off: the chat is not reachable at all, so there is nothing to read (and no options to send)
    await assert.rejects(read(open(base), 'm'), /isn't in MoPilot/, `${kind}: MoMo off`);
  }
});
