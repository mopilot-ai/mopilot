// Chrome's side panel, main's end: the request router (capabilities/browser/chromePanel.cjs), its wiring to chats and harnesses (app/chromePanel.cjs), the projectless folder it starts chats in, and the extension's connection carrying it.
import { test, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { extensionWorld, emptyChromeFolder, memoryPairing } from './support/chrome-extension-kit.ts';
import { until } from './support/chrome-relay-kit.ts';

const require = createRequire(import.meta.url);
const { ChromePanel } = require('../electron/capabilities/browser/chromePanel.cjs');
const { createChromePanel, projectsFileOf } = require('../electron/app/chromePanel.cjs');
const appRelay = require('../electron/app/chromeRelay.cjs');
const { PanelLink } = await import('../electron/chrome-extension/src/panelLink.mjs');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mopilot-panel-'));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

/** The router on fakes; each reply is kept. */
function router(o: any = {}) {
  const calls: any[] = [];
  const panel = new ChromePanel({
    recent: async (limit: number) => (calls.push(['recent', limit]), o.chats ?? []),
    turn: (id: string) => o.turns?.[id],
    harnesses: async () => o.harnesses ?? [{ id: 'claude', label: 'Claude Code' }],
    usable: async (id: string) => (o.harnesses ?? [{ id: 'claude' }]).some((h: any) => h.id === id),
    start: async (s: any) => (calls.push(['start', s]), 'chat-1'),
    open: async (id: string | null) => calls.push(['open', id]),
  });
  const replies: any[] = [];
  const ask = async (method: string, params?: any, id: any = replies.length + 1) => {
    await panel.handle({ type: 'panel', id, method, params }, (r: any) => replies.push(r));
    return replies.at(-1);
  };
  return { panel, calls, replies, ask };
}

test('the panel router answers each request by its id, and says why it refused one', async () => {
  const { calls, replies, ask, panel } = router({
    chats: [
      { id: 'a', title: 'A', harness: 'codex', at: 1 },
      { id: 'b', title: 'B', harness: 'claude', at: 2 },
      { id: 'c', title: 'C', harness: 'acp:gemini', at: 3 },
    ],
    turns: { a: 'running', b: 'awaitingUser' },
  });
  // the newest chats, each with its turn as the panel reads it; the limit is kept between 1 and 200 (20 by default),
  // and the panel asks for one more row than that to learn whether another page follows
  assert.deepEqual(
    (await ask('recent', { limit: 5 })).result.chats.map((c: any) => c.state),
    ['running', 'waiting', 'idle'],
  );
  await ask('recent', { limit: 0 });
  await ask('recent', { limit: 900 });
  await ask('recent', { limit: 'x' });
  await ask('recent');
  assert.deepEqual(
    calls.map((c) => c[1]),
    [6, 2, 201, 21, 21],
  );
  assert.deepEqual((await ask('harnesses')).result, { harnesses: [{ id: 'claude', label: 'Claude Code' }] });
  assert.deepEqual(await ask('open', { chatId: 'a' }, 7), { type: 'panel', id: 7, result: { opened: true } });
  await ask('open', { chatId: '' });
  await ask('open', null);
  assert.deepEqual(calls.slice(-3), [
    ['open', 'a'],
    ['open', null],
    ['open', null],
  ]);
  assert.deepEqual(await ask('nope', {}, 9), { type: 'panel', id: 9, error: 'Unknown side panel request: nope' });
  // a message without a usable id gets no answer
  const before = replies.length;
  await panel.handle({ type: 'panel', method: 'recent' }, (r: any) => replies.push(r));
  await panel.handle(null, (r: any) => replies.push(r));
  await panel.handle({ id: 1.5, method: 'recent' }, (r: any) => replies.push(r));
  assert.equal(replies.length, before);
});

test('a new chat from the panel: a harness it offers, a message, and the Chrome tab as a line of the message', async () => {
  const { calls, ask } = router({
    harnesses: [
      { id: 'claude', label: 'Claude Code' },
      { id: 'acp:gemini', label: 'Gemini' },
    ],
  });
  const refused = async (params: any, error: string) => assert.equal((await ask('start', params)).error, error, JSON.stringify(params));
  await refused({ harness: 'bash', text: 'hi' }, 'Pick a harness for the new chat.');
  await refused({ text: 'hi' }, 'Pick a harness for the new chat.');
  await refused({ harness: 'claude', text: '   ' }, 'Type a message first.');
  await refused({ harness: 'claude', text: 7 }, 'Type a message first.');
  await refused({ harness: 'claude', text: 'x'.repeat(100_001) }, 'The message is too long.');
  // a harness that isn't usable now (signed out, switched off): refused here, not left to fail in the harness
  await refused({ harness: 'codex', text: 'hi' }, "That harness can't start a chat now.");
  assert.equal(calls.length, 0);
  const tab = { url: 'https://news.ycombinator.com/', title: '  Hacker \n News ' };
  assert.deepEqual((await ask('start', { harness: 'acp:gemini', text: ' Top stories? ', tab })).result, { chatId: 'chat-1' });
  assert.deepEqual(calls.at(-1), [
    'start',
    // the page's own title never goes in the user's message: only the address
    {
      harness: 'acp:gemini',
      text: 'Top stories?\n\n[Chrome tab: https://news.ycombinator.com/]',
      tab,
      projectId: null,
      model: null,
      effort: null,
      attachments: [],
      skills: [],
    },
  ]);
  await ask('start', { harness: 'claude', text: 'hi', tab: { url: 'chrome://settings' } });
  assert.deepEqual(calls.at(-1), [
    'start',
    {
      harness: 'claude',
      text: 'hi',
      projectId: null,
      model: null,
      effort: null,
      attachments: [],
      skills: [],
      tab: { url: 'chrome://settings' },
    },
  ]);
});

/** createChromePanel on fakes: one Claude, one Codex and one basic harness, chats in a scratch folder. */
function wired(o: any = {}) {
  const calls: any[] = [];
  const records = new Map<string, any>([['th-1', { segments: [{ kind: 'codex', nativeId: 'th-1' }], meta: {} }]]);
  const live: any = {
    chats: {
      records,
      patchMeta: (id: string, patch: any) => {
        if (o.failMeta) return false;
        const record = records.get(id) ?? { meta: {} };
        records.set(id, { ...record, meta: { ...record.meta, ...patch } });
        return true;
      },
    },
    controller: { state: { get: (id: string) => (id === 'th-1' ? { turn: 'running' } : undefined), has: (id: string) => id === 'th-1' } },
    acpAdmission:
      o.admission === null
        ? undefined
        : {
            list: () => [
              { id: 'gemini', state: 'admitted', label: 'Gemini CLI' },
              { id: 'goose', state: 'admitted' },
              { id: 'qwen', state: 'missing' },
            ],
            admitted: (id: string) => id === 'gemini' || id === 'goose',
          },
  };
  const panel = createChromePanel({
    live,
    sources: {
      codex: async () => o.codex ?? [{ key: 'th-1', title: 'Fix the build', cwd: '/r', at: 2000 }],
      claude: async () => {
        throw new Error('claude is down');
      },
      acp: async () =>
        o.acpRejects ? Promise.reject('acp host gone') : [{ key: 'acp:gemini:x', title: null, cwd: null, at: 1000, harness: 'acp:gemini' }],
    },
    projectsFile: projectsFileOf(scratch),
    home: scratch,
    prefs: () => ({ projectlessFolder: o.root ?? path.join(scratch, 'chats') }),
    usable: async (kind: string) => {
      if (kind === 'codex' && o.codexThrows) throw new Error('no codex');
      return kind !== 'acp:goose';
    },
    starter: {
      prefs: () => ({}),
      codexThread: async ({ cwd }: any) => (calls.push(['codex', cwd]), { id: 'th-new' }),
      claudeSession: (key: string, info: any) => calls.push(['claude', key, info.cwd]),
      acpSession: (key: string, info: any) => calls.push(['acp', key, info.cwd]),
      chats: live.chats,
      started: () => undefined,
    },
    send: async (chatId: string, item: any) => {
      calls.push(['send', chatId, item]);
      return { action: 'started', id: 'panel-input' };
    },
    open: (id: string | null) => calls.push(['open', id]),
    ...(o.realClock ? {} : { now: () => new Date('2026-10-21T10:00:00Z') }),
  });
  const ask = (method: string, params: any = {}) => new Promise<any>((resolve) => void panel.handle({ id: 1, method, params }, resolve));
  return { panel, calls, ask, live };
}

test('main’s panel: recent chats from every harness that answers, harnesses usable now, open goes to the window', async () => {
  const { ask, calls } = wired();
  const { result } = await ask('recent', { limit: 10 });
  // a harness whose list fails leaves the others' chats
  assert.deepEqual(result.chats, [
    {
      id: 'th-1',
      title: 'Fix the build',
      harness: 'codex',
      at: 2000,
      project: 'r',
      projectId: 'folder:6588117f7b51',
      pinned: false,
      unread: false,
      state: 'running',
    },
    {
      id: 'acp:gemini:x',
      title: 'New chat',
      harness: 'acp:gemini',
      at: 1000,
      project: null,
      projectId: null,
      pinned: false,
      unread: false,
      state: 'idle',
    },
  ]);
  assert.deepEqual((await ask('harnesses')).result.harnesses, [
    { id: 'claude', label: 'Claude Code' },
    { id: 'codex', label: 'Codex' },
    { id: 'acp:gemini', label: 'Gemini CLI' },
  ]);
  await ask('open', { chatId: 'th-1' });
  assert.deepEqual(calls.at(-1), ['open', 'th-1']);
  // a list that fails with something that isn't an Error leaves the others' chats too
  assert.deepEqual(
    (await wired({ acpRejects: true }).ask('recent')).result.chats.map((c: any) => c.id),
    ['th-1'],
  );
  // a harness check that fails counts as not usable (noted, not thrown)
  const noAcp = wired({ codexThrows: true, admission: null });
  assert.deepEqual((await noAcp.ask('harnesses')).result.harnesses, [{ id: 'claude', label: 'Claude Code' }]);
  // a start checks only the harness picked: a basic one that isn't admitted is refused
  assert.equal((await noAcp.ask('start', { harness: 'acp:gemini', text: 'hi' })).error, "That harness can't start a chat now.");
  assert.equal((await wired().ask('start', { harness: 'acp:qwen', text: 'hi' })).error, "That harness can't start a chat now.");
});

test('main’s panel: recent chats page by offset, the archive pages alone, and a page of 200 can tell another follows', async () => {
  const many = Array.from({ length: 230 }, (_, i) => ({
    key: `n${i}`,
    title: `Chat ${i}`,
    cwd: null,
    at: 10_000 - i,
    archived: i % 10 === 0,
  }));
  const { ask } = wired({ codex: many });
  const idsOf = async (params: any) => (await ask('recent', params)).result.chats.map((c: any) => c.id);
  const first = await idsOf({ limit: 200 });
  assert.equal(first.length, 200);
  const rest = await idsOf({ limit: 200, offset: 200 });
  // 207 unarchived sessions plus the fixture's own record, th-1
  assert.equal(rest.length, 208 - 200, 'the pages hold every unarchived chat once');
  assert.equal(new Set([...first, ...rest]).size, 208);
  assert.deepEqual((await ask('recent', { limit: 200 })).result.more, true);
  assert.deepEqual((await ask('recent', { limit: 200, offset: 200 })).result.more, false);
  // the archive: 23 chats, in their own pages
  const archive = await idsOf({ limit: 10, archived: true, offset: 20 });
  assert.deepEqual(archive, ['n200', 'n210', 'n220']);
});

test('main’s panel starts the chat on the harness picked, in a projectless folder of its own, as the user’s own message', async () => {
  const { ask, calls } = wired();
  const chats = path.join(scratch, 'chats', '2026-10-21');
  const claude = (await ask('start', { harness: 'claude', text: 'Summarize this page.' })).result.chatId;
  assert.match(claude, /^claude:/);
  assert.deepEqual(calls.slice(-2), [
    ['claude', claude, path.join(chats, 'summarize-this-page')],
    ['send', claude, { text: 'Summarize this page.', attachments: [], opts: { human: true }, followUp: 'queue' }],
  ]);
  assert.equal((await ask('start', { harness: 'codex', text: 'Summarize this page.' })).result.chatId, 'th-new');
  assert.deepEqual(calls.at(-2), ['codex', path.join(chats, 'summarize-this-page-2')]);
  const acp = (await ask('start', { harness: 'acp:gemini', text: 'Find flights\nto Tokyo' })).result.chatId;
  assert.match(acp, /^acp:gemini:/);
  assert.deepEqual(calls.at(-2), ['acp', acp, path.join(chats, 'find-flights')]);
  // on the real clock, today's folder
  const today = wired({ realClock: true, root: path.join(scratch, 'today') });
  await today.ask('start', { harness: 'claude', text: 'hi' });
  assert.equal(today.calls[0][2], path.join(scratch, 'today', new Date().toISOString().slice(0, 10), 'hi'));
  // no folder, no chat: said, and nothing started
  fs.writeFileSync(path.join(scratch, 'not-a-folder'), '');
  const broken = wired({ root: path.join(scratch, 'not-a-folder') });
  assert.match((await broken.ask('start', { harness: 'claude', text: 'hi' })).error, /^Couldn't create the chat folder: /);
  assert.equal(broken.calls.length, 0);
});

test('a panel chat whose initial configuration cannot be persisted returns a failure before its user input is sent', async () => {
  const { ask, calls } = wired({ failMeta: true });
  const reply = await ask('start', { harness: 'codex', text: 'Do the assigned work' });
  assert.match(reply.error, /save the new chat/);
  assert.equal(reply.result, undefined);
  assert.equal(
    calls.some((row: any[]) => row[0] === 'send'),
    false,
  );
});

test('the extension’s connection carries the panel: a request reaches main’s router and its answer comes back', async () => {
  let link: any;
  const seen: any[] = [];
  const panel = new ChromePanel({
    recent: async () => [{ id: 'c1', title: 'One', harness: 'codex', at: 1 }],
    turn: () => 'awaitingUser',
    harnesses: async () => [],
    start: async () => 'x',
    open: async () => undefined,
  });
  const w = await extensionWorld({
    panel: (m: any, reply: any) => (seen.push(m), panel.handle(m, reply)),
    onPanel: (m: any) => link.receive(m),
  });
  try {
    link = new PanelLink({ send: (m: any) => w.client.send(m), connected: () => w.client.status === 'connected' });
    // main accepts the handshake before its welcome reaches the extension: wait until the extension's end is connected too
    await until(() => w.client.status === 'connected');
    const r = await link.request('recent', { limit: 3 });
    // `now` is the Mac's clock, which the phone's staleness line reads; the panel carries it unread
    assert.equal(typeof r.now, 'number');
    assert.deepEqual(
      { ...r, now: undefined },
      { chats: [{ id: 'c1', title: 'One', harness: 'codex', at: 1, state: 'waiting' }], more: false, now: undefined },
    );
    assert.deepEqual(seen[0], { type: 'panel', id: 1, method: 'recent', params: { limit: 3 } });
    // main's updates reach the extension's end too
    const events: any[] = [];
    link.o.event = (e: any) => events.push(e);
    w.channel.peer.send({ type: 'panel', event: { kind: 'turn', chatId: 'c1', state: 'running' } });
    await until(() => events.length === 1);
    assert.deepEqual(events[0], { kind: 'turn', chatId: 'c1', state: 'running' });
  } finally {
    w.stop();
  }
});

test('the relay tells the panel when a chat’s turn changes, on the extension channel only', async (ctx) => {
  emptyChromeFolder(ctx);
  const s = appRelay.setupChromeRelay({
    registry: { register: () => () => undefined },
    grants: {},
    token: () => null,
    profileDir: () => '',
    images: { fromBuffer: (b: Buffer) => b },
    isFlagEnabled: () => false,
    kind: 'extension',
    pairing: { get: () => null, forPort: (port: number) => ({ secret: 'E'.repeat(43), port, paired: false }), markPaired: () => undefined },
    panel: () => undefined,
  });
  try {
    const send = mock.fn();
    s.relay.peer = { send, open: true };
    s.onSessionPatch({ chatId: 'c1', patch: { turn: 'awaitingUser' } });
    s.onSessionPatch({ chatId: 'c1', patch: { plan: true } });
    s.onSessionPatch({ chatId: 'c1', patch: { turn: 'idle' } });
    const events = send.mock.calls.map((c: any) => c.arguments[0]).filter((m: any) => m.type === 'panel');
    assert.deepEqual(events, [
      { type: 'panel', event: { kind: 'turn', chatId: 'c1', state: 'waiting' } },
      { type: 'panel', event: { kind: 'turn', chatId: 'c1', state: 'idle' } },
    ]);
    // no extension connected: nothing to tell
    s.relay.peer = null;
    s.onSessionPatch({ chatId: 'c1', patch: { turn: 'running' } });
  } finally {
    s.stop();
  }
  const relay = appRelay.setupChromeRelay({
    registry: { register: () => () => undefined },
    grants: {},
    token: () => null,
    profileDir: () => '',
    images: { fromBuffer: (b: Buffer) => b },
    isFlagEnabled: () => false,
  });
  relay.onSessionPatch({ chatId: 'c1', patch: { turn: 'running' } });
  relay.stop();
});

test('the router reads and sends to a chat it names, and pushes updates on the connection that asked last', async () => {
  const calls: any[] = [];
  const panel = new ChromePanel({
    recent: async () => [],
    turn: () => undefined,
    harnesses: async () => [],
    usable: async () => true,
    start: async () => 'x',
    open: async () => undefined,
    read: async (chatId: string) => (calls.push(['read', chatId]), { chatId, rows: [] }),
    send: async (o: any) => calls.push(['send', o]),
  });
  // nobody asked yet: an update has nowhere to go
  panel.push({ kind: 'delta' });
  const got: any[] = [];
  const ask = (method: string, params: any) => panel.handle({ id: 1, method, params }, (r: any) => got.push(r)).then(() => got.at(-1));
  assert.deepEqual((await ask('read', { chatId: 'claude:abc-1' })).result, { chatId: 'claude:abc-1', rows: [] });
  for (const chatId of ['', 'has space', 7, 'x'.repeat(301)])
    assert.equal((await ask('read', { chatId })).error, "That chat isn't in MoPilot.");
  assert.deepEqual((await ask('send', { chatId: 'th-1', text: ' more ', tab: { url: 'https://a.example/' } })).result, { sent: true });
  assert.deepEqual(calls.at(-1), [
    'send',
    {
      chatId: 'th-1',
      text: 'more\n\n[Chrome tab: https://a.example/]',
      model: null,
      effort: null,
      attachments: [],
      skills: [],
      tab: { url: 'https://a.example/' },
    },
  ]);
  assert.equal((await ask('send', { chatId: 'th-1', text: '' })).error, 'Type a message first.');
  assert.equal((await ask('send', { text: 'hi' })).error, "That chat isn't in MoPilot.");
  panel.push({ kind: 'delta', chatId: 'th-1', text: 'Hi' });
  assert.deepEqual(got.at(-1), { type: 'panel', event: { kind: 'delta', chatId: 'th-1', text: 'Hi' } });
});

test('the extension’s settings page reads and changes this Chrome’s name and saved sites through the panel’s link', async () => {
  const { ask, live } = wired();
  const sites = new Map([['https://a.example', 'read']]);
  live.chromeRelay = { kind: 'extension', pairing: memoryPairing({ secret: 'S'.repeat(43), port: 1, paired: true }) };
  live.chromeGrants = {
    list: () => [...sites].map(([origin, level]) => ({ origin, level })),
    set: (origin: string, level: null) => (level === null ? sites.delete(origin) : sites.set(origin, level)),
  };
  assert.deepEqual((await ask('browserSettings')).result, { name: null, sites: [{ origin: 'https://a.example', level: 'read' }] });
  assert.deepEqual((await ask('browserSettings', { name: 'Work' })).result.name, 'Work');
  assert.deepEqual((await ask('browserSettings', { revoke: 'https://a.example' })).result.sites, []);
  assert.equal((await ask('browserSettings', { revoke: 'https://a.example' })).error, 'That site is no longer saved.');
});

test('an expired first panel send returns its created chat for retry without dispatching', async () => {
  const { ask, calls } = wired();
  const response = await ask('start', { harness: 'codex', text: 'Keep this', retainOnError: true, deadline: Date.now() - 1 });
  assert.equal(response.result.chatId, 'th-new');
  assert.match(response.result.error, /took too long/);
  assert.ok(!calls.some((c: any) => c[0] === 'send'));
  const legacy = await ask('start', { harness: 'codex', text: 'Legacy client', deadline: Date.now() - 1 });
  assert.match(legacy.error, /took too long/);
});

test('paired phones reach MoMo’s remote operations once main made them, and none before', () => {
  const { panel, live } = wired();
  // a chat deleted is let go of here too
  panel.forgetChat('never-followed');
  assert.equal(panel.service.momo(), null);
  live.momoRemote = { mainChatId: () => 'momo-main' };
  assert.equal(panel.service.momo(), live.momoRemote);
});
