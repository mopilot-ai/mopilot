// Panel history reads retain current saved notes across native awaits, and the actual tab marker round-trips through its display parser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { setup } from './support/controller/fixture.ts';
const require = createRequire(import.meta.url);
const { createChromePanel, projectsFileOf } = require('../electron/app/chromePanel.cjs');
const { tabLine } = require('../electron/capabilities/browser/chromePanel.cjs');
function wired(t: any) {
  const h = setup();
  t.after(() => fs.rmSync(h.chats.dir, { recursive: true, force: true }));
  h.chats.records.set('th-1', { id: 'th-1', segments: [{ kind: 'codex', nativeId: 'th-1' }], meta: {} });
  const live: any = { chats: h.chats, controller: h.c, peerRuntime: {} };
  const panel = createChromePanel({
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
  const ask = (method: string, params: any) =>
    new Promise<any>((resolve) => {
      void panel.handle({ id: 1, method, params }, resolve);
    });
  return { live, ask };
}
test('panel reads use the current saved notes when the record is replaced during a native history read', async (t) => {
  const { ask, live } = wired(t);
  let finish: any;
  live.peerRuntime = {
    readHistory: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  };
  const pending = ask('read', { chatId: 'th-1' });
  await new Promise((resolve) => setImmediate(resolve));
  const old = live.chats.records.get('th-1');
  live.chats.records.set('th-1', {
    ...old,
    meta: { notes: [{ id: 'new-note', kind: 'account', text: 'Account changed while reading', turn: 0, turnId: null, at: 1 }] },
  });
  finish({ turns: [{ id: 'turn', items: [{ type: 'agentMessage', text: 'Reply' }] }], earlierContentOmitted: false });
  const response = await pending;
  assert.equal(response.error, undefined);
  assert.deepEqual(
    response.result.rows.map((r: any) => r.text),
    ['Reply', 'Account changed while reading'],
  );
});

test('a phone pages back through saved history: the rows before a named row, more when earlier ones remain or were omitted, null for a row that is gone', async (t) => {
  const { ask, live } = wired(t);
  const turns = [
    {
      id: 'turn',
      items: [
        { id: 'u1', type: 'userMessage', content: [{ type: 'text', text: 'first' }] },
        { id: 'a1', type: 'agentMessage', text: 'second' },
        { id: 'u2', type: 'userMessage', content: [{ type: 'text', text: 'third' }] },
      ],
    },
  ];
  live.peerRuntime = { readHistory: async () => ({ turns, earlierContentOmitted: false }) };
  const { result: head } = await ask('read', { chatId: 'th-1' });
  const lastId = head.rows.at(-1).id;
  const page = await ask('read', { chatId: 'th-1', before: lastId, limit: 1 });
  assert.equal(page.error, undefined);
  assert.deepEqual(
    page.result.rows.map((r: any) => r.text),
    ['second'],
  );
  assert.deepEqual([page.result.more, page.result.omitted], [true, false]);
  const all = await ask('read', { chatId: 'th-1', before: lastId, limit: 10 });
  assert.equal(all.result.more, false);
  live.peerRuntime = { readHistory: async () => ({ turns, earlierContentOmitted: true }) };
  const omitted = (await ask('read', { chatId: 'th-1', before: lastId, limit: 10 })).result;
  assert.deepEqual([omitted.more, omitted.omitted], [false, true], 'older content the source dropped is said, not offered');
  assert.match((await ask('read', { chatId: 'th-1', before: 'nope', limit: 10 })).error, /Refresh it to read earlier messages/);
  live.chats.records.set('th-1', {
    ...live.chats.records.get('th-1'),
    meta: { notes: [{ id: 'n', kind: 'account', text: 'Account', turn: 0, turnId: null, at: 1 }] },
  });
  assert.ok((await ask('read', { chatId: 'th-1', before: lastId, limit: 10 })).result.rows.length >= 2, 'saved notes are rows too');
  assert.match((await ask('read', { chatId: 'gone-chat', before: 'x', limit: 1 })).error, /isn't in MoPilot|not in/i);
});

test('the real tab marker producer round-trips through the shared user-text parser', async () => {
  const { parseUserText } = await import('../shared/userText.mjs');
  for (const url of ['https://example.org/with a space', 'http://example.org/?x=1', 'chrome://settings', 'about:blank', 'file:///tmp/a']) {
    const line = tabLine({ url });
    const result = parseUserText('My question' + (line ? '\n\n' + line : ''));
    assert.equal(result.text, 'My question');
    assert.equal(result.chromeTab ?? null, line ? new URL(url).href : null);
  }
});

test('a harness switch during history loading cannot pair an old model and harness with the new account', async (t) => {
  const { ask, live } = wired(t);
  let finish: any;
  live.peerRuntime.readHistory = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  live.capsService = { accountLabel: () => 'new-account' };
  const pending = ask('read', { chatId: 'th-1' });
  await new Promise((resolve) => setImmediate(resolve));
  live.chats.records.set('th-1', { id: 'th-1', segments: [{ kind: 'claude', nativeId: 'new', model: 'new-model' }], meta: {} });
  finish({ turns: [], earlierContentOmitted: false });
  const response = await pending;
  assert.equal(response.result.harness, 'Claude Code');
  assert.equal(response.result.account, 'new-account');
});

for (const fail of [false, true])
  test(`a deleted chat during native history loading reports the panel's missing-chat outcome (reader fails ${fail})`, async (t) => {
    const { ask, live } = wired(t);
    let settle: any;
    live.peerRuntime.readHistory = () =>
      new Promise((resolve, reject) => {
        settle = () => (fail ? reject(new Error('chat_unavailable')) : resolve({ turns: [] }));
      });
    const pending = ask('read', { chatId: 'th-1' });
    await new Promise((resolve) => setImmediate(resolve));
    live.chats.records.delete('th-1');
    live.controller.state.chats.delete('th-1');
    settle();
    const { CHAT_GONE_TEXT } = await import('../electron/chrome-extension/src/panelErrors.mjs');
    assert.equal((await pending).error, CHAT_GONE_TEXT);
  });

test('a native history read failure for a reachable chat remains its own error', async (t) => {
  const { ask, live } = wired(t);
  live.peerRuntime.readHistory = async () => {
    throw new Error('Native history offline');
  };
  assert.equal((await ask('read', { chatId: 'th-1' })).error, 'Native history offline');
});

test('an unavailable account label cannot hide the actual conversation history', async (t) => {
  const { live, ask } = wired(t);
  live.peerRuntime.readHistory = async () => ({ turns: [{ items: [{ type: 'agentMessage', text: 'The answer' }] }] });
  live.capsService = {
    accountLabel: () => {
      throw new Error('Account instance retired');
    },
  };
  const reply = await ask('read', { chatId: 'th-1' });
  assert.equal(reply.error, undefined);
  assert.equal(reply.result.account, null);
  assert.equal(reply.result.rows[0].text, 'The answer');
});

for (const rejected of [false, true])
  test(`overlapping history reads share one current native operation and a later retry starts fresh (reject ${rejected})`, async (t) => {
    const { live, ask } = wired(t);
    let count = 0;
    let release: any;
    live.peerRuntime.readHistory = () => {
      count++;
      return new Promise((resolve, reject) => {
        release = () => (rejected ? reject(new Error('Native read failed')) : resolve({ turns: [] }));
      });
    };
    const pending = [ask('read', { chatId: 'th-1' }), ask('read', { chatId: 'th-1' })];
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(count, 1);
    release();
    const replies = await Promise.all(pending);
    assert.equal(replies[0].error, rejected ? 'Native read failed' : undefined);
    assert.equal(replies[1].error, replies[0].error);
    const retry = ask('read', { chatId: 'th-1' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(count, 2);
    release();
    await retry;
  });

test('an old native reader cannot reuse or clear a replacement source’s in-flight history', async (t) => {
  const { live, ask } = wired(t);
  const releases: any[] = [];
  const load = () => new Promise((resolve) => releases.push(() => resolve({ turns: [] })));
  live.peerRuntime.readHistory = load;
  const first = ask('read', { chatId: 'th-1' });
  await new Promise((resolve) => setImmediate(resolve));
  live.chats.records.get('th-1').segments.push({ kind: 'claude', nativeId: 'replacement' });
  const second = ask('read', { chatId: 'th-1' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(releases.length, 2);
  releases[0]();
  await first;
  const third = ask('read', { chatId: 'th-1' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(releases.length, 2);
  live.peerRuntime = { readHistory: load };
  const fourth = ask('read', { chatId: 'th-1' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(releases.length, 3);
  releases[1]();
  releases[2]();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(releases.length, 4);
  releases[3]();
  await Promise.all([second, third, fourth]);
});

for (const failed of [false, true])
  test(`a request following a newer event gets one trailing native snapshot after an older read (failure ${failed})`, async (t) => {
    const { live, ask } = wired(t);
    const releases: any[] = [];
    live.peerRuntime.readHistory = () => new Promise((resolve, reject) => releases.push({ resolve, reject }));
    const earlier = ask('read', { chatId: 'th-1' });
    await new Promise((resolve) => setImmediate(resolve));
    const later = [ask('read', { chatId: 'th-1' }), ask('read', { chatId: 'th-1' })];
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(releases.length, 1);
    if (failed) releases[0].reject(new Error('Old read failed'));
    else releases[0].resolve({ turns: [{ items: [{ type: 'agentMessage', text: 'Older snapshot' }] }] });
    await earlier;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(releases.length, 2);
    releases[1].resolve({ turns: [{ items: [{ type: 'agentMessage', text: 'Final answer' }] }] });
    for (const reply of await Promise.all(later)) assert.equal(reply.result.rows[0].text, 'Final answer');
  });

test('chat deletion during canonical metadata reading cannot revive a transcript from lingering session state', async (t) => {
  const { live, ask } = wired(t);
  live.peerRuntime.readHistory = async () => ({ turns: [] });
  live.codex = {
    chatName: () => {
      live.chats.records.delete('th-1');
      return 'Deleted title';
    },
  };
  const response = await ask('read', { chatId: 'th-1' });
  assert.match(response.error, /isn't in MoPilot/);
});

test('a failed optional menu owner leaves history readable, and an unknown native owner has no menu token', async (t) => {
  const { live, ask } = wired(t);
  live.peerRuntime.readHistory = async () => ({ turns: [{ items: [{ type: 'agentMessage', text: 'Keep this reply' }] }] });
  live.chats.records.set('th-1', { id: 'th-1', segments: [{ kind: 'claude', nativeId: 'c' }], meta: {} });
  live.claudeTurns = {
    settings: () => {
      throw new Error('Optional settings unavailable');
    },
  };
  const first = await ask('read', { chatId: 'th-1' });
  assert.equal(first.error, undefined);
  assert.equal(first.result.menuOwner, null);
  assert.equal(first.result.rows[0].text, 'Keep this reply');
  live.chats.records.get('th-1').segments = [];
  live.controller.ref = () => null;
  const unknown = await ask('read', { chatId: 'th-1' });
  assert.equal(unknown.error, undefined);
  assert.equal(unknown.result.menuOwner, null);
});

test('a hung snapshot expires and releases its trailing read; its late completion cannot replace a fresh snapshot', {
  timeout: 1000,
}, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { live, ask } = wired(t);
  let finish: any;
  let reads = 0;
  live.peerRuntime = {
    readHistory: () =>
      ++reads === 1
        ? new Promise((r) => {
            finish = r;
          })
        : Promise.resolve({ turns: [{ items: [{ type: 'agentMessage', text: 'Fresh' }] }] }),
  };
  const first = ask('read', { chatId: 'th-1' });
  await new Promise((r) => setImmediate(r));
  const trailing = ask('read', { chatId: 'th-1' });
  await new Promise((r) => setImmediate(r));
  assert.equal(reads, 1);
  t.mock.timers.tick(30_000);
  assert.match((await first).error, /took too long.*Try again/);
  assert.equal((await trailing).result.rows[0].text, 'Fresh');
  finish({ turns: [{ items: [{ type: 'agentMessage', text: 'Obsolete' }] }] });
  await new Promise((r) => setImmediate(r));
  assert.equal((await ask('read', { chatId: 'th-1' })).result.rows[0].text, 'Fresh');
});
