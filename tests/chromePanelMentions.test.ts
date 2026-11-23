// The chats and tabs a Chrome side panel message @ mentions, in main (electron/app/chromePanelMentions.cjs and app/chromePanel.cjs): each chat read into the snapshot the window's composer attaches, every harness reading it the same way; the panel's tokens are the app's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createPanelMentions } = require('../electron/app/chromePanelMentions.cjs');
const { createChromePanel, projectsFileOf } = require('../electron/app/chromePanel.cjs');
const { buildClaudeMessage } = require('../electron/harness/claude/message.cjs');
const { buildInput } = require('../electron/harness/codexParams.cjs');
const { tabToken: sharedTabToken } = await import('../shared/tabMentions.mjs');
const { sessionToken } = await import('../shared/sessionMentions.mjs');
const { tabToken, chatToken } = await import('../electron/chrome-extension/src/panelMention.mjs');

const TURNS = [
  {
    id: 't1',
    items: [
      { type: 'userMessage', content: [{ type: 'text', text: 'Find a ryokan in Kyoto' }] },
      { type: 'agentMessage', phase: 'final_answer', text: 'Try Tawaraya.' },
    ],
  },
];

function mentions(o: { history?: Record<string, any>; known?: string[] } = {}) {
  const read: string[] = [];
  const m = createPanelMentions({
    peerRuntime: {
      readReference: async (id: string, assistantOnly: boolean) => {
        read.push(`${id}:${assistantOnly}`);
        return o.history?.[id] ?? { turns: TURNS, earlierContentOmitted: false };
      },
    },
    known: (id: string) => (o.known ?? ['c1', 'c2']).includes(id),
  });
  return { m, read };
}

test('a message’s chat mentions: each read once, in order, into the snapshot the window attaches', async () => {
  const { m, read } = mentions();
  const text = `Compare ${sessionToken('c1', 'Kyoto [trip]')} with ${sessionToken('c2', 'Osaka')} and ${sessionToken('c1', 'Kyoto [trip]')}`;
  const refs = await m.references(text);
  assert.deepEqual(read, ['c1:false', 'c2:false']);
  assert.deepEqual(
    refs.map((r: any) => [r.kind, r.path, r.name]),
    [
      ['session', 'c1', 'Kyoto [trip]'],
      ['session', 'c2', 'Osaka'],
    ],
  );
  assert.equal(refs[0].text, '# Kyoto [trip]\n\n## User\n\nFind a ryokan in Kyoto\n\n## Assistant\n\nTry Tawaraya.\n');
  assert.deepEqual(await m.references('no mentions here'), []);
});

test('a long chat keeps its recent end, and says so; one whose history was cut says so too', async () => {
  const long = {
    turns: [{ id: 'x', items: [{ type: 'agentMessage', phase: 'final_answer', text: `${'a'.repeat(40_000)}THE END` }] }],
    earlierContentOmitted: false,
  };
  const cut = { turns: TURNS, earlierContentOmitted: true };
  const { m } = mentions({ history: { c1: long, c2: cut } });
  const [a, b] = await m.references(`${sessionToken('c1', 'Long')} ${sessionToken('c2', 'Cut')}`);
  assert.ok(a.text.startsWith('[Earlier content omitted; recent conversation follows.]\n'));
  assert.ok(a.text.endsWith('THE END\n'));
  assert.ok(a.text.length < 33_000);
  assert.ok(b.text.startsWith('[Earlier content omitted; recent conversation follows.]\n# Cut'));
});

test('a chat MoPilot doesn’t have, or too many, refuse the message before any is read', async () => {
  const { m, read } = mentions();
  await assert.rejects(m.references(`see ${sessionToken('gone', 'Old trip')}`), /“Old trip” isn't a chat in MoPilot/);
  const many = Array.from({ length: 11 }, (_, i) => sessionToken(`k${i}`, `Chat ${i}`)).join(' ');
  await assert.rejects(m.references(many), /Mention up to 10 chats/);
  assert.deepEqual(read, []);
});

test('the panel writes the app’s own tokens, and every harness reads a mention its way', () => {
  const tab = { id: 42, title: 'Flights (cheap) [JP]', url: 'https://example.com/a?b=(c)' };
  assert.equal(tabToken(tab), sharedTabToken({ where: 'chrome', title: tab.title, url: tab.url, tabId: '42' }));
  assert.equal(chatToken('acp:kimi:(1)', 'My  [chat]'), sessionToken('acp:kimi:(1)', 'My  [chat]'));
  // a tab with no title is named by its address
  assert.match(tabToken({ id: 1, title: '', url: 'https://a.example/' }), /^\[https:\/\/a\.example\/\]/);
  const ref = { kind: 'session', path: 'c1', name: 'Kyoto', text: '# Kyoto' };
  const text = `What does ${tabToken(tab)} say? Also ${chatToken('c1', 'Kyoto')}`;
  // Claude Code: the tab in words, the chat as quoted context first
  const claude = buildClaudeMessage({ text, attachments: [ref] }).content as string;
  assert.match(claude, /^<sage-chat-context>/);
  assert.match(claude, /the open tab “Flights \(cheap\) \[JP\]” <https:\/\/example\.com\/a\?b=\(c\)> in my Chrome/);
  // Codex: the same context, and a Chrome tab with no browser id as words too
  const codex = buildInput(text, [ref]);
  assert.match(codex[0].text, /^<sage-chat-context>/);
  assert.match(codex[0].text, /the open tab “Flights \(cheap\) \[JP\]”/);
});

test('main: the chats mentioned go with the first message and a follow-up; one MoPilot doesn’t have makes no chat', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-mentions-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls: any[] = [];
  const records = new Map<string, any>([
    ['th-1', { segments: [{ kind: 'codex', nativeId: 'th-1' }], meta: {} }],
    ['c1', { segments: [{ kind: 'claude', nativeId: 'c1' }], meta: {} }],
  ]);
  const live: any = {
    chats: {
      records,
      patchMeta: (id: string, patch: any) => {
        const rec = records.get(id) ?? { id, meta: {} };
        records.set(id, { ...rec, meta: { ...rec.meta, ...patch } });
        return true;
      },
    },
    controller: { state: new Map(), ref: () => null, onLiveEvent: null },
    peerRuntime: { readReference: async () => ({ turns: TURNS, earlierContentOmitted: false }) },
  };
  const panel = createChromePanel({
    live,
    claude: { findBinary: async () => null, catalog: async () => null },
    sources: {},
    projectsFile: projectsFileOf(dir),
    home: dir,
    prefs: () => ({ projectlessFolder: path.join(dir, 'chats') }),
    usable: async () => true,
    starter: {
      prefs: () => ({}),
      codexThread: async () => (calls.push(['codex']), { id: 'th-new' }),
      claudeSession: () => undefined,
      acpSession: () => undefined,
      chats: live.chats,
      started: () => undefined,
    },
    send: async (chatId: string, item: any) => {
      calls.push(['send', chatId, item]);
      return { action: 'started', id: 'panel-input' };
    },
    open: () => undefined,
    cwdOf: async () => dir,
    now: () => new Date('2026-10-22T10:00:00Z'),
  });
  const ask = async (method: string, params: any) => {
    let out: any;
    await panel.handle({ id: 1, method, params }, (m: any) => (out = m));
    return out.error ?? out.result;
  };
  await ask('start', { harness: 'codex', text: `Plan from ${sessionToken('c1', 'Kyoto')}` });
  const first = calls.find((c) => c[0] === 'send')[2];
  assert.deepEqual(
    first.attachments.map((a: any) => [a.kind, a.path, a.name]),
    [['session', 'c1', 'Kyoto']],
  );
  await ask('send', { chatId: 'th-1', text: `and ${sessionToken('c1', 'Kyoto')}` });
  assert.equal(calls.at(-1)[2].attachments[0].path, 'c1');
  const before = calls.filter((c) => c[0] === 'codex').length;
  assert.equal(await ask('start', { harness: 'codex', text: `from ${sessionToken('gone', 'Old')}` }), "“Old” isn't a chat in MoPilot.");
  assert.equal(calls.filter((c) => c[0] === 'codex').length, before);
  assert.equal(fs.existsSync(path.join(dir, 'chats', '2026-10-22', 'from-old')), false);
});
