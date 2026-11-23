// Chrome's side panel sidebar, main's end (capabilities/browser/chromePanel.cjs, app/chromePanel.cjs): projects, scheduled tasks, pinning (the app's own flag, shown in its windows), archived chats, a new chat in a project, and opening the app's Scheduled page.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ChromePanel } = require('../electron/capabilities/browser/chromePanel.cjs');
const { createChromePanel, projectsFileOf } = require('../electron/app/chromePanel.cjs');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mopilot-panel-sidebar-'));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

test('the router: projects, scheduled tasks, pin, archived chats, a start in a project, and only the pages it knows', async () => {
  const calls: any[] = [];
  const panel = new ChromePanel({
    recent: async (limit: number, archived: boolean) => (calls.push(['recent', limit, archived]), []),
    turn: () => undefined,
    projects: () => [{ id: 'p1', name: 'Travel' }],
    scheduled: async () => [{ id: 't1', name: 'Brief', next: 1 }],
    pin: (chatId: string, pinned: boolean) => (calls.push(['pin', chatId, pinned]), chatId !== 'gone'),
    harnesses: async () => [],
    usable: async () => true,
    start: async (o: any) => (calls.push(['start', o]), 'c1'),
    open: async (...a: any[]) => calls.push(['open', ...a]),
  });
  const ask = (method: string, params: any) => new Promise<any>((resolve) => void panel.handle({ id: 1, method, params }, resolve));
  assert.deepEqual((await ask('projects', {})).result, { projects: [{ id: 'p1', name: 'Travel' }] });
  assert.deepEqual((await ask('scheduled', {})).result, { tasks: [{ id: 't1', name: 'Brief', next: 1 }] });
  await ask('recent', { limit: 200, archived: true });
  await ask('recent', { archived: 'yes' });
  // each asks for one row more than the page, to learn whether another page follows
  assert.deepEqual(calls.slice(-2), [
    ['recent', 201, true],
    ['recent', 21, false],
  ]);
  assert.deepEqual((await ask('pin', { chatId: 'c1', pinned: true })).result, { pinned: true });
  assert.deepEqual((await ask('pin', { chatId: 'c1' })).result, { pinned: false });
  assert.equal((await ask('pin', { chatId: 'gone', pinned: true })).error, "That chat isn't in MoPilot.");
  assert.deepEqual(calls.slice(-3), [
    ['pin', 'c1', true],
    ['pin', 'c1', false],
    ['pin', 'gone', true],
  ]);
  await ask('start', { harness: 'claude', text: 'hi', projectId: 'p1' });
  assert.deepEqual(calls.at(-1), [
    'start',
    { harness: 'claude', text: 'hi', projectId: 'p1', model: null, effort: null, attachments: [], skills: [] },
  ]);
  assert.equal((await ask('start', { harness: 'claude', text: 'hi', projectId: '../x' })).error, "That project isn't in MoPilot.");
  await ask('open', { page: 'scheduled' });
  await ask('open', { page: 'settings', chatId: 'c1' });
  assert.deepEqual(calls.slice(-2), [
    ['open', null, 'scheduled'],
    ['open', 'c1', undefined],
  ]);
});

test('main’s sidebar: saved projects, the app’s pin shown in its windows, archived chats, a new chat in a project', async () => {
  const projectDir = path.join(scratch, 'travel');
  fs.mkdirSync(projectDir);
  const projectsFile = projectsFileOf(scratch);
  fs.writeFileSync(projectsFile, JSON.stringify({ version: 1, projects: [{ id: 'p1', name: 'Travel', path: projectDir }] }));
  const calls: any[] = [];
  const records = new Map<string, any>([
    ['th-1', { segments: [{ kind: 'codex', nativeId: 'th-1' }], meta: { pinned: true, unread: true } }],
    ['th-2', { segments: [{ kind: 'codex', nativeId: 'th-2' }], meta: { archived: 5 } }],
  ]);
  const live: any = {
    chats: {
      records,
      patchMeta: (id: string, patch: any) => {
        calls.push(['patchMeta', id, patch]);
        const rec = records.get(id);
        if (!rec) return false;
        const before = JSON.stringify(rec.meta);
        rec.meta = { ...rec.meta, ...patch };
        return JSON.stringify(rec.meta) !== before;
      },
      get: (id: string) => ({ id, meta: records.get(id)?.meta }),
    },
    controller: { state: { get: () => undefined, has: () => false }, chatOf: (k: string) => k, ref: () => undefined },
    acpAdmission: { list: () => [], admitted: () => false },
  };
  const panel = createChromePanel({
    live,
    claude: {},
    sources: {
      codex: async (archived: boolean) => [
        { key: 'th-1', title: 'Flights', cwd: projectDir, at: 3000 },
        ...(archived ? [{ key: 'th-2', title: 'Old trip', cwd: projectDir, at: 2000, archived: true }] : []),
      ],
    },
    projectsFile,
    home: scratch,
    prefs: () => ({}),
    usable: async () => true,
    starter: {
      prefs: () => ({}),
      claudeSession: (key: string, info: any) => calls.push(['claude', key, info.cwd]),
      // a new chat's record is made by its first meta, as the chat store does
      chats: {
        ...live.chats,
        patchMeta: (id: string, patch: any) => (
          records.has(id) || records.set(id, { segments: [], meta: {} }), live.chats.patchMeta(id, patch)
        ),
      },
      started: () => undefined,
    },
    send: async (chatId: string, item: any) => {
      calls.push(['send', chatId, item]);
      return { action: 'started', id: 'panel-input' };
    },
    open: () => undefined,
    scheduled: async () => [],
    broadcast: (channel: string, payload: any) => calls.push(['broadcast', channel, payload.id]),
  });
  const ask = (method: string, params: any) => new Promise<any>((resolve) => void panel.handle({ id: 1, method, params }, resolve));
  assert.deepEqual((await ask('projects', {})).result.projects, [{ id: 'p1', name: 'Travel', branch: null }]);
  assert.deepEqual((await ask('recent', { limit: 50 })).result.chats, [
    {
      id: 'th-1',
      title: 'Flights',
      harness: 'codex',
      at: 3000,
      project: 'Travel',
      projectId: 'p1',
      pinned: true,
      unread: true,
      state: 'idle',
    },
  ]);
  // the archive is its own list
  assert.deepEqual(
    (await ask('recent', { limit: 50, archived: true })).result.chats.map((c: any) => c.id),
    ['th-2'],
  );
  // a pin: the record's flag, then the windows hear of it; the same again changes nothing and tells no one
  await ask('pin', { chatId: 'th-2', pinned: true });
  assert.deepEqual(calls.slice(-2), [
    ['patchMeta', 'th-2', { pinned: true }],
    ['broadcast', 'chats:changed', 'th-2'],
  ]);
  await ask('pin', { chatId: 'th-1', pinned: false });
  assert.deepEqual(calls.slice(-2), [
    ['patchMeta', 'th-1', { pinned: null }],
    ['broadcast', 'chats:changed', 'th-1'],
  ]);
  await ask('pin', { chatId: 'th-1', pinned: false });
  assert.deepEqual(calls.at(-1), ['patchMeta', 'th-1', { pinned: null }]);
  assert.equal((await ask('pin', { chatId: 'nope', pinned: true })).error, "That chat isn't in MoPilot.");
  // a harness switch goes only to a chat main knows
  assert.equal((await ask('switch', { chatId: 'nope', harness: 'claude' })).error, "That chat isn't in MoPilot.");
  // a new chat in Travel: in its folder, filed under it
  const chatId = (await ask('start', { harness: 'claude', text: 'Find a ryokan', projectId: 'p1' })).result.chatId;
  assert.deepEqual(calls.at(-4), ['claude', chatId, projectDir]);
  // it keeps the new-chat model and effort as its own
  assert.deepEqual(calls.at(-3), ['patchMeta', chatId, { config: { model: null, effort: null } }]);
  assert.deepEqual(calls.at(-2), ['patchMeta', chatId, { projectId: 'p1' }]);
  assert.deepEqual(calls.at(-1)[2].opts, { human: true });
  // on the model and effort picked in the panel
  await ask('start', { harness: 'claude', text: 'Find a ryokan', projectId: 'p1', model: 'sonnet', effort: 'low' });
  assert.deepEqual(calls.at(-1)[2], {
    text: 'Find a ryokan',
    attachments: [],
    opts: { human: true, model: 'sonnet', effort: 'low' },
    followUp: 'queue',
  });
  assert.equal((await ask('start', { harness: 'claude', text: 'hi', projectId: 'p9' })).error, "That project isn't in MoPilot.");
  assert.deepEqual((await ask('scheduled', {})).result, { tasks: [] });
});
