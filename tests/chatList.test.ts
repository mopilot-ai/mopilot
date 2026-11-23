// list_sidebar (#1724): the user's projects and chats as the sidebar shows them, read-only, for a chat on any harness:
// electron/capabilities/tools/chatList.cjs (the listing and the tool) and electron/app/ipc/chatList.cjs (its sources).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { listChats, registerChatListTool, titleOf } = require('../electron/capabilities/tools/chatList.cjs');
const { register, chatSources, fresh, FRESH_MS } = require('../electron/app/ipc/chatList.cjs');
const { Registry } = require('../electron/capabilities/contract/registry.cjs');
const { registerPeerTools } = require('../electron/capabilities/contract/peerMessages.cjs');

const PROJECTS = [
  { id: 'p1', name: 'mopilot', path: '/Users/me/src/mopilot' },
  { id: 'p2', name: 'site', path: '/Users/me/src/site/' },
];
const rec = (kind: string, meta: Record<string, unknown> = {}, more: string[] = []) => ({
  segments: [{ kind }, ...more.map((k) => ({ kind: k }))],
  meta: { archived: null, projectId: null, worktreeOf: null, ...meta },
});
const H = 3600_000;

/** A chat per harness: one switched from Codex to Claude Code (its Claude session is a later segment), one archived in MoPilot, one in Codex. */
function world() {
  const records = new Map<string, any>([
    ['cx1', rec('codex', { projectId: 'p1' })],
    ['cx2', rec('codex', {}, ['claude'])],
    ['claude:s1', rec('claude', { archived: 5 })],
    ['claude:s2', rec('claude', { worktreeOf: '/Users/me/src/site' })],
  ]);
  const natives: [string, string[]][] = [
    ['cx1', ['cx1']],
    ['cx2', ['cx2', 'claude:s9']],
    ['claude:s1', ['claude:s1']],
    ['claude:s2', ['claude:s2']],
  ];
  const sessions = {
    codex: [
      { key: 'cx1', title: 'Fix the sidebar', cwd: '/Users/me/src/mopilot', at: 5 * H },
      { key: 'cx2', title: 'Switched chat', cwd: '/old', at: 1 * H },
      { key: 'cx3', title: null, cwd: '/Users/me/src/site', at: 2 * H, archived: true },
    ],
    claude: [
      { key: 'claude:s9', title: 'switched segment title', cwd: '/new', at: 6 * H },
      { key: 'claude:s1', title: 'Old', cwd: '/x', at: 7 * H },
      { key: 'claude:s2', title: 'Site work', cwd: '/Users/me/.mopilot/worktrees/site-1', at: 4 * H },
    ],
    acp: [{ key: 'acp:kimi:a1', title: 'Kimi chat', cwd: '/tmp/k', at: 3 * H, harness: 'acp:kimi' }],
  };
  return { projects: PROJECTS, records, natives, sessions };
}

test('the sidebar newest first: titles, harness, project (by id, folder or worktree), folder; archived ones left out', () => {
  const out = listChats(world(), {});
  // the saved projects, then the folders chats ran in that the sidebar shows as projects until they are saved
  assert.deepEqual(out.projects, [
    { name: 'mopilot', folder: '/Users/me/src/mopilot', saved: true },
    { name: 'site', folder: '/Users/me/src/site/', saved: true },
    { name: 'new', folder: '/new', saved: false },
    { name: 'k', folder: '/tmp/k', saved: false },
  ]);
  assert.deepEqual(
    out.chats.map((c: any) => [c.id, c.title, c.harness, c.project, c.folder, c.archived, c.lastActivity]),
    [
      // a switched chat: its own first session's title, its current harness, its latest session's folder and time
      ['cx2', 'Switched chat', 'claude', 'new', '/new', false, new Date(6 * H).toISOString()],
      ['cx1', 'Fix the sidebar', 'codex', 'mopilot', '/Users/me/src/mopilot', false, new Date(5 * H).toISOString()],
      ['claude:s2', 'Site work', 'claude', 'site', '/Users/me/.mopilot/worktrees/site-1', false, new Date(4 * H).toISOString()],
      // no record yet: the session's own harness
      ['acp:kimi:a1', 'Kimi chat', 'acp:kimi', 'k', '/tmp/k', false, new Date(3 * H).toISOString()],
    ],
  );
  assert.equal(out.more, undefined);
  assert.equal(out.unavailable, undefined);
});

test("filters: archived ones too (MoPilot's archive or the harness's), one project by name or folder, and a limit", () => {
  const all = listChats(world(), { include_archived: true });
  assert.deepEqual(
    all.chats.filter((c: any) => c.archived).map((c: any) => [c.id, c.title, c.project]),
    [
      ['claude:s1', 'Old', 'x'],
      ['cx3', 'New chat', 'site'],
    ],
  );
  const site = listChats(world(), { project: 'SITE', include_archived: true });
  assert.deepEqual(site.projects, [{ name: 'site', folder: '/Users/me/src/site/', saved: true }]);
  assert.deepEqual(
    site.chats.map((c: any) => c.id),
    ['claude:s2', 'cx3'],
  );
  assert.deepEqual(
    listChats(world(), { project: '/Users/me/src/mopilot/' }).chats.map((c: any) => c.id),
    ['cx1'],
  );
  // a folder no saved project has: the chats that ran there
  const folder = listChats(world(), { project: '/tmp/k' });
  assert.deepEqual(folder.projects, [{ name: 'k', folder: '/tmp/k', saved: false }]);
  assert.deepEqual(
    folder.chats.map((c: any) => c.id),
    ['acp:kimi:a1'],
  );
  const one = listChats(world(), { limit: 1 });
  assert.equal(one.chats.length, 1);
  assert.equal(one.more, 3);
  assert.equal(listChats(world(), { limit: 0 }).chats.length, 1, 'at least one');
  assert.equal(listChats(world(), { limit: 1.5 }).chats.length, 4, 'not an integer: the default');
});

test('a harness whose list fails is named, and the others still answer', () => {
  const w = world();
  const out = listChats({ ...w, sessions: { ...w.sessions, claude: new Error('Claude Code is not installed') } }, {});
  assert.deepEqual(out.unavailable, [{ harness: 'claude', error: 'Claude Code is not installed' }]);
  assert.deepEqual(
    out.chats.map((c: any) => c.id),
    ['cx1', 'acp:kimi:a1', 'cx2'],
  );
});

test('titles as the sidebar shows them: the first non-empty line, at most 80 characters', () => {
  assert.equal(titleOf('\n  Look at   my\tsidebar \nsecond line'), 'Look at my sidebar');
  assert.equal(titleOf('x'.repeat(90)), `${'x'.repeat(79)}…`);
  assert.equal(titleOf(''), null);
  assert.equal(titleOf(null), null);
});

test('the tool: read-only (observe), the calling chat must own its segment, and each source gets the archive flag', async () => {
  const registry = new Registry();
  const asked: any[] = [];
  const w = world();
  registerChatListTool(registry, {
    owner: (ctx: any) => (ctx.chatId === 'cx1' ? 'cx1' : null),
    projects: () => w.projects,
    records: () => w.records,
    natives: () => w.natives,
    sources: {
      codex: async (archived: boolean) => (asked.push(['codex', archived]), w.sessions.codex),
      claude: async () => {
        throw 'not a real error';
      },
    },
  });
  assert.equal(registry.list().find((t: any) => t.name === 'list_sidebar').policy, 'observe');
  const res = await registry.invoke('cx1', 'cx1', 'list_sidebar', { include_archived: true, limit: 2 });
  assert.equal(res.ok, true);
  const out = JSON.parse(res.content[0].text);
  assert.deepEqual(
    out.chats.map((c: any) => c.id),
    ['cx1', 'cx3'],
  );
  assert.deepEqual(out.unavailable, [{ harness: 'claude', error: 'not a real error' }]);
  assert.deepEqual(asked, [['codex', true]]);
  const stranger = await registry.invoke('other', 'other', 'list_sidebar', {});
  assert.deepEqual(stranger.error, { code: 'no_owner', message: 'The caller does not own this chat segment' });
  const bad = await registry.invoke('cx1', 'cx1', 'list_sidebar', { limit: 'ten' });
  assert.equal(bad.error.code, 'bad_args');
});

test("each harness's list: Codex pages (and its archive on request), Claude Code pages, ACP chats", async () => {
  const pages: any[] = [];
  const live = {
    codex: {
      threadList: async (p: any) => {
        pages.push([p.archived, p.cursor]);
        if (p.archived) return { data: [{ id: 'z', name: '', preview: 'Archived one', cwd: '/z', updatedAt: 2 }], nextCursor: null };
        return p.cursor
          ? { data: [{ id: 'b', name: null, preview: 'second', updatedAt: 1 }], nextCursor: null }
          : { data: [{ id: 'a', name: 'First', preview: 'x', cwd: '/a', updatedAt: 3 }], nextCursor: 'n1' };
      },
    },
    acpHost: { list: async () => [{ id: 'acp:kimi:k', harness: 'kimi', name: null, preview: 'hi', cwd: undefined, updatedAt: 9 }] },
  };
  const offsets: number[] = [];
  const claude = {
    listSessions: async (limit: number, offset: number) => {
      offsets.push(offset);
      if (offset === 0)
        return Array.from({ length: limit }, (_, i) => ({
          sessionId: `s${i}`,
          // the sidebar names it by its first prompt over Claude's summary (src/session/harness/claude/threads.ts)
          firstPrompt: 'p',
          summary: 'Claude summary',
          lastModified: i,
          cwd: i ? '/c' : undefined,
        }));
      return [
        { sessionId: 'last', customTitle: 'Named', summary: 'sum', cwd: '/c', lastModified: 1 },
        // no name and no first prompt (a new session Claude Code only summarized): its summary
        { sessionId: 'summed', summary: 'Rain on tin roof', cwd: '/c', lastModified: 2 },
      ];
    },
  };
  const s = chatSources(live, claude);
  assert.deepEqual(await s.codex(false), [
    { key: 'a', title: 'First', cwd: '/a', at: 3000, archived: false },
    { key: 'b', title: 'second', cwd: null, at: 1000, archived: false },
  ]);
  assert.deepEqual(pages, [
    [false, null],
    [false, 'n1'],
  ]);
  const withArchive = await s.codex(true);
  assert.deepEqual(withArchive.at(-1), { key: 'z', title: 'Archived one', cwd: '/z', at: 2000, archived: true });
  const cl = await s.claude();
  assert.deepEqual(offsets, [0, 500]);
  assert.equal(cl.length, 502);
  assert.deepEqual(cl[0], { key: 'claude:s0', title: 'p', cwd: null, at: 0 });
  assert.deepEqual(cl.at(-2), { key: 'claude:last', title: 'Named', cwd: '/c', at: 1 });
  assert.deepEqual(cl.at(-1), { key: 'claude:summed', title: 'Rain on tin roof', cwd: '/c', at: 2 });
  assert.deepEqual(await s.acp(), [{ key: 'acp:kimi:k', title: 'hi', cwd: null, at: 9, harness: 'acp:kimi' }]);
});

test("wired in main: the saved projects read fresh from projects.json, the chat records, each harness's list", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatlist-'));
  try {
    const registry = new Registry();
    const records = new Map<string, any>([
      ['cx1', { segments: [{ kind: 'codex', nativeId: 'cx1' }], meta: { archived: null, projectId: 'p1' } }],
    ]);
    const live: any = {
      capabilities: registry,
      chats: { records },
      codex: {
        threadList: async () => ({
          data: [
            { id: 'cx1', name: 'Hello', cwd: '/w', updatedAt: 10 },
            // a projectless chat's own folder under the home folder main names, and one under the folder Settings set
            { id: 'cx2', name: 'Quick', cwd: `${dir}/home/Documents/MoPilot/2026-10-20/quick`, updatedAt: 9 },
            { id: 'cx3', name: 'Set', cwd: '/scratch/2026-10-20/set', updatedAt: 8 },
          ],
          nextCursor: null,
        }),
      },
      acpHost: { list: async () => [] },
    };
    const getPath = (name: string) => (name === 'home' ? `${dir}/home` : dir);
    // the sidebar's settings come from the windows' saved state, read at each call
    let prefs: any = {};
    register(null, { live, app: { getPath }, readState: () => ({ prefs }), claude: { listSessions: async () => [] } });
    const first = JSON.parse((await registry.invoke('cx1', 'cx1', 'list_sidebar', {})).content[0].text);
    // the default projectless folder is under the home folder main names
    assert.deepEqual(first.projects, [
      { name: 'w', folder: '/w', saved: false },
      { name: 'set', folder: '/scratch/2026-10-20/set', saved: false },
    ]);
    assert.deepEqual(
      first.chats.map((c: any) => [c.id, c.title, c.project]),
      [
        ['cx1', 'Hello', 'w'],
        ['cx2', 'Quick', null],
        ['cx3', 'Set', 'set'],
      ],
    );
    // a projectless folder and a folder name set in Settings, read at the next call
    prefs = { projectlessFolder: '/scratch', folderNames: { '/w': 'Work' } };
    const set = JSON.parse((await registry.invoke('cx1', 'cx1', 'list_sidebar', {})).content[0].text);
    assert.deepEqual(
      set.chats.map((c: any) => [c.id, c.project]),
      [
        ['cx1', 'Work'],
        ['cx2', 'quick'],
        ['cx3', null],
      ],
    );
    // at most `limit` projects too, the rest counted
    const one = JSON.parse((await registry.invoke('cx1', 'cx1', 'list_sidebar', { limit: 1 })).content[0].text);
    assert.deepEqual([one.projects, one.moreProjects, one.more], [[{ name: 'Work', folder: '/w', saved: false }], 1, 2]);
    prefs = {};
    // a project the windows add shows on the next call
    fs.writeFileSync(
      path.join(dir, 'projects.json'),
      JSON.stringify({ schemaVersion: 2, projects: [{ id: 'p1', name: 'w', path: '/w' }] }),
    );
    const next = JSON.parse((await registry.invoke('cx1', 'cx1', 'list_sidebar', {})).content[0].text);
    assert.deepEqual(next.projects, [
      { name: 'w', folder: '/w', saved: true },
      { name: 'set', folder: '/scratch/2026-10-20/set', saved: false },
    ]);
    assert.equal(next.chats[0].project, 'w');
    // no tool registry (a start without one): nothing to register
    register(null, { live: { capabilities: null }, app: { getPath } });
    // no saved state to read: the defaults
    const bare = new Registry();
    register(null, { live: { ...live, capabilities: bare }, app: { getPath }, claude: { listSessions: async () => [] } });
    assert.equal(JSON.parse((await bare.invoke('cx1', 'cx1', 'list_sidebar', {})).content[0].text).chats.length, 3);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('list_sidebar and the chat-messaging tools share one registry: no tool name is taken twice', () => {
  // the dev instance found it: a first name (list_chats) collided with the peer tool, and main could not start
  const registry = new Registry();
  registerPeerTools(registry, { service: {}, owner: () => null, directory: () => null, read: () => null });
  const none = () => [];
  registerChatListTool(registry, { owner: () => null, projects: none, records: () => new Map(), natives: none, sources: {} });
  assert.ok(registry.has('list_sidebar') && registry.has('list_chats'));
});

test('a chat is filed as the sidebar files it: the deepest project folder holding it, or a managed worktree’s repo', () => {
  // the dev instance found it: chats in a Claude Code worktree of a project (…/.claude/worktrees/<name>) read as unfiled
  const projects = [
    { id: 'home', name: 'home', path: '/Users/me' },
    { id: 'mp', name: 'mopilot', path: '/Users/me/src/mopilot' },
    { id: 'docs', name: 'docs', path: '/Users/me/src/mopilot/docs' },
    { id: 'site', name: 'site', path: '/Users/me/src/Site' },
  ];
  const at = (key: string, cwd: string) => ({ key, title: key, cwd, at: 1 });
  const out = listChats(
    {
      projects,
      home: '/Users/me',
      records: new Map(),
      natives: [],
      sessions: {
        codex: [
          at('wt', '/Users/me/src/mopilot/.claude/worktrees/nice-x'),
          at('deep', '/Users/me/src/mopilot/docs/sub'),
          at('managed', '/Users/me/.mopilot/worktrees/ab12/site/pkg'),
          at('codexwt', '/Users/me/.codex/worktrees/cd34/nowhere'),
          at('loose', '/Users/me/Downloads'),
          at('none', ''),
        ],
      },
    },
    {},
  );
  assert.deepEqual(
    out.chats.map((c: any) => [c.id, c.project]),
    // chats of one time come in id order
    [
      ['codexwt', null],
      ['deep', 'docs'],
      ['loose', 'Downloads'],
      ['managed', 'site'],
      ['none', null],
      ['wt', 'mopilot'],
    ],
  );
  // a project filter by folder takes every chat under it
  assert.deepEqual(
    listChats(
      { projects, home: '/Users/me', records: new Map(), natives: [], sessions: { codex: [at('wt', '/Users/me/src/mopilot/x')] } },
      { project: '/Users/me/src' },
    ).chats.map((c: any) => c.id),
    ['wt'],
  );
});

test("the folders chats ran in show as the sidebar's unsaved projects: not home, a projectless chat's folder, a managed worktree or a hidden folder", () => {
  // the VM run found it: a sidebar of folder groups only read as "no projects"
  const at = (key: string, cwd: string, archived = false) => ({ key, title: key, cwd, at: 1, archived });
  const out = listChats(
    {
      projects: [],
      home: '/Users/me',
      prefs: { hiddenFolders: ['/Users/me/hidden/'], folderNames: { '/Users/me/src/app': 'My app' } },
      records: new Map(),
      natives: [],
      sessions: {
        codex: [
          at('wt', '/Users/me/src/app/.claude/worktrees/x/sub'),
          at('home', '/Users/me'),
          at('root', '/'),
          at('drive', 'C:\\'),
          at('pl', '/Users/me/Documents/MoPilot/2026-10-20/hi'),
          at('managed', '/Users/me/.mopilot/worktrees/ab/app'),
          at('hidden', '/Users/me/hidden'),
          at('gone', '/Users/me/old', true),
        ],
      },
    },
    { include_archived: true },
  );
  assert.deepEqual(out.projects, [{ name: 'My app', folder: '/Users/me/src/app', saved: false }], 'an archived chat makes no group');
  assert.deepEqual(
    out.chats.map((c: any) => [c.id, c.project]),
    [
      ['drive', null],
      ['gone', 'old'],
      ['hidden', null],
      ['home', null],
      ['managed', null],
      ['pl', null],
      ['root', null],
      ['wt', 'My app'],
    ],
  );
  // a projectless folder set in Settings, and no home known
  const set = listChats(
    {
      projects: [],
      prefs: { projectlessFolder: '/scratch' },
      records: new Map(),
      natives: [],
      sessions: { codex: [at('a', '/scratch/x')] },
    },
    {},
  );
  assert.deepEqual(set.projects, []);
});

test('a harness list answers again for a short while (a model calls list_sidebar several times a turn); a failed read is not kept', async () => {
  let t = 0;
  const reads: any[] = [];
  let fail = false;
  const s = fresh(
    {
      codex: async (archived: boolean) => {
        reads.push(archived);
        if (fail) throw new Error('down');
        return [archived];
      },
    },
    () => t,
  );
  assert.deepEqual(await s.codex(false), [false]);
  assert.deepEqual(await s.codex(false), [false]);
  assert.deepEqual(await s.codex(true), [true], 'the archive flag is its own answer');
  assert.deepEqual(reads, [false, true]);
  t = FRESH_MS;
  fail = true;
  await assert.rejects(s.codex(false), /down/);
  fail = false;
  assert.deepEqual(await s.codex(false), [false], 'read again after the failure');
  assert.deepEqual(reads, [false, true, false, false]);
});

test('edge cases: a chat with no folder, a later segment older than the first, two chats in one folder, a failing list', async () => {
  const at = (key: string, cwd: string | null, when: number) => ({ key, title: key, cwd, at: when });
  const out = listChats(
    {
      projects: [{ id: 'p', name: 'p', path: '/p' }],
      home: '/h',
      records: new Map(),
      // c1's later segment (s2) is older than its first: the first's folder and time stay
      natives: [['c1', ['c1', 's2']]],
      sessions: {
        codex: [at('c1', '/new', 5), at('nofolder', null, 4), at('a', '/f', 3), at('b', '/f', 2)],
        claude: [at('s2', '/old', 1)],
      },
    },
    { project: '/elsewhere' },
  );
  assert.deepEqual(out.chats, [], 'a project filter no chat is in');
  const all = listChats(
    {
      projects: [],
      home: '/h',
      records: new Map(),
      natives: [['c1', ['c1', 's2']]],
      sessions: {
        codex: [at('c1', '/new', 5), at('nofolder', null, 4), at('a', '/f', 3), at('b', '/f', 2)],
        claude: [at('s2', '/old', 1)],
      },
    },
    {},
  );
  assert.deepEqual(
    all.chats.map((c: any) => [c.id, c.folder, c.project]),
    [
      ['c1', '/new', 'new'],
      ['nofolder', null, null],
      ['a', '/f', 'f'],
      ['b', '/f', 'f'],
    ],
  );
  assert.deepEqual(
    all.projects.map((p: any) => p.folder),
    ['/new', '/f'],
  );
  // a source that rejects with an Error keeps its message
  const registry = new Registry();
  registerChatListTool(registry, {
    owner: () => 'c',
    projects: () => [],
    records: () => new Map(),
    natives: () => [],
    sources: {
      codex: async () => {
        throw new Error('app-server down');
      },
    },
  });
  const res = JSON.parse((await registry.invoke('c', 'c', 'list_sidebar', {})).content[0].text);
  assert.deepEqual(res.unavailable, [{ harness: 'codex', error: 'app-server down' }]);
});
