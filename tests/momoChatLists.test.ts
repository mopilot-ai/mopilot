// MoMo's chats are in no list of chats (#2139): list_sidebar and the Chrome side panel (listChats), the store maps every
// window builds its lists from, Cmd+K and the @ picker (chatSearch), and a whole-repository guard: every source that
// enumerates chats either skips MoMo's (isMomoMeta in main, isMomoChat in a window) or is listed here with why it may not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { applyChat, mapsFromSnapshot, chatChanges } from '../src/lib/chatMeta.ts';
import { mergeChatSearch, canSelectChatSearch } from '../src/lib/chatSearch.ts';
import { isMomoChat, momoOwned } from '../src/lib/momoChats.ts';

export const GUARDS = ['electron/', 'shared/', 'src/'];

const require = createRequire(import.meta.url);
const { listChats } = require('../electron/capabilities/tools/chatList.cjs');

const ROOT = path.join(import.meta.dirname, '..');

test('list_sidebar and the Chrome side panel skip MoMo’s chats, and MoMo’s workspace is no project', () => {
  const records = new Map<string, any>([
    ['cx1', { segments: [{ kind: 'codex' }], meta: { archived: null, projectId: null, worktreeOf: null } }],
    // MoMo's chat after a switch: its later Claude session is listed by Claude Code
    ['th-momo', { segments: [{ kind: 'codex' }, { kind: 'claude' }], meta: { archived: null, momo: 'main' } }],
    ['claude:old', { segments: [{ kind: 'claude' }], meta: { archived: 5, momo: 'previous' } }],
  ]);
  const { chats, projects } = listChats(
    {
      projects: [],
      home: '/Users/me',
      prefs: {},
      records,
      natives: [
        ['cx1', ['cx1']],
        ['th-momo', ['th-momo', 'claude:s9']],
        ['claude:old', ['claude:old']],
      ],
      sessions: {
        codex: [
          { key: 'cx1', title: 'Fix it', cwd: '/Users/me/src/a', at: 1 },
          { key: 'th-momo', title: 'MoMo', cwd: '/Users/me/.mopilot/momo/workspace', at: 3 },
        ],
        claude: [
          { key: 'claude:s9', title: 'MoMo on Claude', cwd: '/Users/me/.mopilot/momo/workspace', at: 4 },
          { key: 'claude:old', title: 'Old MoMo', cwd: '/Users/me/.mopilot/momo/workspace', at: 2 },
        ],
      },
    },
    { include_archived: true },
  );
  assert.deepEqual(
    chats.map((c: any) => c.id),
    ['cx1'],
  );
  assert.ok(!JSON.stringify(projects).includes('momo'));
});

test('a window keeps MoMo’s chats in a map of their own, read from main and never sent back as a change', () => {
  const meta = (m: any) => ({ segments: null, meta: { archived: null, pinned: false, unread: false, ...m } }) as any;
  const maps = mapsFromSnapshot({ chats: { a: meta({}), m: meta({ momo: 'main', unread: true }) }, newer: [] });
  assert.deepEqual(maps.momoChats, { m: 'main' });
  const later = applyChat(maps, 'm', meta({ momo: 'previous', unread: true }));
  assert.deepEqual(later.momoChats, { m: 'previous' });
  assert.deepEqual(applyChat(later, 'm', meta({ momo: null })).momoChats, {});
  // only what a window changed goes back to main: MoMo's tag isn't one of those
  assert.deepEqual(chatChanges(maps, later), { meta: {}, segments: {} });
  assert.equal(isMomoChat(later.momoChats, 'm'), true);
  for (const [map, id] of [
    [later.momoChats, 'a'],
    [later.momoChats, null],
    [undefined, 'm'],
    [{ ['__proto__']: 'x' } as any, 'toString'],
  ] as const)
    assert.equal(isMomoChat(map, id), false);
  // a later native session of a MoMo chat, listed by its harness under its own id, is MoMo's too
  const segments = { m: [{ nativeId: 'm' }, { nativeId: 's9' }], a: [{ nativeId: 'a' }, { nativeId: 's1' }] };
  assert.equal(momoOwned({ m: 'main' }, segments, 's9'), true);
  assert.equal(momoOwned({ m: 'main' }, segments, 'm'), true);
  assert.equal(momoOwned({ m: 'main' }, segments, 's1'), false);
  assert.equal(momoOwned({ m: 'main' }, undefined, 's9'), false);
  assert.equal(momoOwned(undefined, segments, 's9'), false);
});

test('Cmd+K and the @ picker never offer MoMo’s chats, found locally or by a harness search', () => {
  const t = (id: string, updatedAt: number) => ({ id, updatedAt, title: id });
  const pool = mergeChatSearch({
    local: [t('a', 2), t('m', 3)],
    codex: [t('m', 3), t('b', 1)],
    momoChats: { m: 'main' },
    titleOf: (x: any) => x.title,
    term: '',
    limit: 10,
  } as any);
  assert.deepEqual(
    pool.map((x: any) => x.id),
    ['a', 'b'],
  );
  assert.equal(canSelectChatSearch('m', { knownChats: { m: t('m', 3) }, momoChats: { m: 'main' } }, []), false);
  assert.equal(canSelectChatSearch('a', { knownChats: { a: t('a', 2) }, momoChats: { m: 'main' } }, []), true);
});

/* -- the guard ---------------------------------------------------------- */

/** Main code that walks the saved chats (ChatsStore records), however it spells it; a lookup by id isn't a list. */
const STORE_LISTS = /\b(?:chats|store)\??\.records\b(?!\s*\.(?:get|has|set|delete)\b)/;
/** A `records` handed in and walked, in a file that handles chat records. */
const PASSED_LISTS = /(?:\bof|\[\.\.\.|Array\.from\()\s*records\b|\brecords\??\.(?:forEach|values|keys|entries)\(/;
/** Each harness's own list of its sessions, which knows nothing of chat meta. */
const HARNESS_LISTS = /\b(?:threadList|listSessions)\(|\bacpHost\??\.list\(/;
/** Window code that walks the chats it knows, its archive, or searches them. */
const WINDOW_LISTS =
  /\bthreadOrder\b|Object\.(?:values|keys|entries)\((?:[^()]|\(\))*\b(?:threads|unread|pinned|archived|claudeArchived)\b|\b(?:s|st|get\(\))\.archived\b|\.archived\.(?:filter|map|find|some|forEach)\(|\barchived: \[|\bmergeChatSearch\(|\bcanSelectChatSearch\(/;
const SKIPS_MOMO = /\bisMomoMeta\b|\bisMomoChat\b|\bmomoOwned\b|\bmomoChats\b/;
/** How far from an occurrence the predicate may be: the expression or the function around it. */
const NEAR = 12;

/** Each line of `text` that enumerates chats with no MoMo predicate near it. */
function unfiltered(file: string, text: string) {
  const lines = text.split('\n');
  const main = !file.startsWith('src/');
  const chatFile = /chats\??\.records|ChatsStore|nativeIdsOf|segmentAliases/.test(text);
  const out: { line: number; code: string }[] = [];
  lines.forEach((code, i) => {
    const hit = main
      ? STORE_LISTS.test(code) || (chatFile && PASSED_LISTS.test(code)) || HARNESS_LISTS.test(code)
      : WINDOW_LISTS.test(code);
    if (hit && !SKIPS_MOMO.test(lines.slice(Math.max(0, i - NEAR), i + NEAR + 1).join('\n'))) out.push({ line: i + 1, code: code.trim() });
  });
  return out;
}

const SOURCE = 'loads chats from where they live, a source the lists filter';
const ORDER = "keeps the store's order of every chat the window knows (MoMo's page needs its chat there); the lists filter it";
const OWNER = 'finds the chat that owns a native session or a tool call, not a list';
const ARCHIVE_WRITE = "writes the window's archive; Archived chats filters it where it renders (momoOwned)";
/**
 * Occurrences that enumerate chats without skipping MoMo's, each with why: [file, the code (a part of the line), why].
 * Each one covers every line of its file that contains that code.
 */
const ALLOWED: [string, string, string][] = [
  [
    'src/store/sidebarSnapshot.ts',
    'threadOrder',
    "seeds the order the saved snapshot had (it never holds MoMo's chats: snapshotOf skips them) and drops rows after their list answered",
  ],
  ['src/store/sidebarSnapshot.ts', 'Object.entries(s.threads)', 'drops the rows a list no longer has; lists nothing'],
  ['electron/app/autoArchive.cjs', 'codex.threadList(', SOURCE + ' (AutoArchive.inactive keeps MoMo chats)'],
  ['electron/app/autoArchive.cjs', 'claude.listSessions(', SOURCE + ' (AutoArchive.inactive keeps MoMo chats)'],
  ['electron/app/autoArchive.cjs', 'acpHost.list()', SOURCE + ' (AutoArchive.inactive keeps MoMo chats)'],
  ['electron/app/ipc/chatList.cjs', 'codex.threadList(', SOURCE + ' (listChats)'],
  ['electron/app/ipc/chatList.cjs', 'claude.listSessions(', SOURCE + ' (listChats)'],
  ['electron/app/ipc/chatList.cjs', 'acpHost.list()', SOURCE + ' (listChats)'],
  ['electron/app/ipc/chatList.cjs', 'records: () => live.chats.records', 'the records listChats filters'],
  ['electron/app/ipc/chatList.cjs', 'nativeIdsOf(live.chats.records)', 'segment ids for listChats to find owners'],
  ['electron/app/ipc/chatList.cjs', 'ownerOf(live.chats?.records', OWNER],
  ['electron/capabilities/tools/agentUiWiring.cjs', 'ownerOf(live.chats?.records', OWNER],
  [
    'electron/capabilities/tools/agentUiWiring.cjs',
    'records: () => live.chats.records',
    'the sidebar tools read one chat record by id (records().get), never walk the map',
  ],
  ['electron/app/chromePanelRecent.cjs', 'records: live.chats.records', 'the records listChats filters'],
  ['electron/app/chromePanelRecent.cjs', 'nativeIdsOf(live.chats.records)', 'segment ids for listChats to find owners'],
  ['electron/app/automations.cjs', 'chatOwning(live.chats?.records', OWNER],
  ['electron/app/routines.cjs', 'ownerOf(live.chats?.records', OWNER],
  ['electron/app/ipc/prMonitor.cjs', 'ownerOf(live.chats.records', OWNER],
  ['electron/app/ipc/prStack.cjs', 'ownerOf(live.chats.records', OWNER],
  ['electron/session/peerRuntime.cjs', 'ownerOf(chats.records', OWNER],
  ['electron/session/controller.cjs', 'nativeIdsOf(this.chats.records)', OWNER],
  ['electron/platform/chats.cjs', 'for (const [id, rec] of records) yield', OWNER + ' (nativeIdsOf)'],
  ['electron/app/appState.cjs', 'of chats.records)', 'seeds per-chat native permission ownership after loading, not a visible list'],
  [
    'electron/platform/chats.cjs',
    '...this.archiveEpochs.keys()',
    'retires asynchronous identity claims for every record, not a visible list',
  ],
  [
    'electron/app/ipc/chats.cjs',
    '...live.chats.archiveEpochs.keys()',
    'copies identity generations into an isolated reload candidate, not a visible list',
  ],
  [
    'electron/session/orchestration/childSetup.cjs',
    '[...orch.o.chats.records].some',
    'keeps shared notes while any live record references them, including MoMo',
  ],
  [
    'electron/session/orchestration/childSetup.cjs',
    'of orch.o.chats.records)',
    'retires deleted notes references in every saved configuration, not a visible list',
  ],
  [
    'src/store/familyArchive.ts',
    'result.archived.some',
    'checks whether a completion still owns an archive receipt before its toast, not a list',
  ],
  ['electron/session/autoArchive.cjs', '...records.keys()', "the sweep's candidates; inactive() keeps MoMo chats"],
  [
    'electron/capabilities/browser/chatFolders.cjs',
    'chats?.records?.keys()',
    'whether another chat shares a browser-storage folder name (a yes or no), not a list',
  ],
  [
    'electron/capabilities/browser/chatFolders.cjs',
    'of chats?.records ?? []',
    "names each chat's browser-storage folder to keep or clear (archived or live), not a list anyone sees",
  ],
  ['electron/session/chatDeletion.cjs', '[...store.records]', 'finds the chats a deletion removes, by id'],
  ['electron/session/chatDeletion.cjs', '[...records]', 'finds the chats a deletion removes, by id'],
  ['electron/session/chatDeletion.cjs', 'aliasIndex(this.store.records)', OWNER],
  [
    'electron/session/chatFolderGuard.cjs',
    'for (const [id, record] of [...store.records])',
    'repairs exact-folder repository provenance from saved owners, including hidden chats, without exposing a chat list',
  ],
  [
    'electron/capabilities/computerUse.cjs',
    'of o.chats.records',
    "Settings lists the apps each chat may control so the user can revoke them: a grant MoMo's chat holds stays revocable",
  ],
  ['electron/harness/claude/index.cjs', "'claude:list'", SOURCE + ' (Claude Code sessions to the window)'],
  ['electron/harness/claude/transcripts.cjs', 'listSessions(', SOURCE + " (Claude Code's own list)"],
  ['electron/harness/claude/sessionList.cjs', 'listSessions(', SOURCE + " (Claude Code's own list, in pages)"],
  ['electron/harness/codexApi.cjs', 'threadList(p', SOURCE + " (Codex's own list)"],
  ['src/store/core.ts', 'threadOrder', ORDER],
  ['src/store/core.ts', 'archived: []', "the archive's empty start"],
  ['src/store/connection.ts', 'threadOrder', ORDER],
  ['src/session/harness/claude/threads.ts', 'threadOrder', ORDER],
  [
    'src/session/harness/claude/threads.ts',
    'Object.keys(getState().claudeArchived)',
    'whether the archive holds a chat this window can\u2019t show yet (a yes or no), not a list',
  ],
  ['src/session/harness/acp.ts', 'threadOrder', ORDER],
  ['src/lib/chatActivity.ts', 'threadOrder', ORDER],
  ['src/store/actions.ts', 'threadOrder', ORDER],
  ['src/store/notifications.ts', 'threadOrder', ORDER],
  ['src/store/remoteArchive.ts', 'threadOrder', ORDER],
  ['src/store/deletionVisibility.ts', 'threadOrder', 'hides deleted chats from the order'],
  ['src/store/deletionVisibility.ts', 'archived.filter', 'hides deleted chats from the archive'],
  ['src/store/actions.ts', 'archived', ARCHIVE_WRITE],
  ['src/store/remoteArchive.ts', 'archived', ARCHIVE_WRITE],
  ['src/store/projects.ts', 'for (const id of s.threadOrder)', "the new chat's default project: MoMo's workspace is no saved project"],
  ['src/store/projects.ts', 'Object.values(threads)', 'the folders open chats use (git refresh), not a list anyone sees'],
  ['src/store/prewarm.ts', 's.threadOrder', "notices the new chat's default project may have changed"],
  ['src/components/pages/Home.tsx', 's.threadOrder', "follows the new chat's default project"],
  [
    'src/components/sidebar/homeTarget.ts',
    's.threadOrder',
    "the new chat's default project may have changed (a memo key); nothing is listed",
  ],
  ['src/session/chatRunning.ts', 'Object.values(s.threads)', "whether a chat runs in a folder; MoMo's workspace is no user folder"],
  ['src/lib/chatSearch.ts', 'Object.keys(archived)', 'archived Claude ids for search, whose results allowed() filters'],
  ['src/App.tsx', 's.threadOrder.length', 'a changed chat count re-reads which chats run on machines; nothing is listed'],
  ['src/lib/settingsSearch.ts', "archived: ['Archive'", 'Settings search words, not chats'],
];

function sources(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== 'node_modules' && e.name !== 'chrome-extension') sources(rel, out);
    } else if (/\.(?:c?js|mjs|ts|tsx)$/.test(e.name) && !/\.d\.m?ts$/.test(e.name)) out.push(rel);
  }
  return out;
}

test('every place that enumerates chats skips MoMo’s near it, or is listed with why it may not', () => {
  const left: string[] = [];
  const used = new Set<number>();
  for (const dir of ['electron', 'shared', 'src'])
    for (const file of sources(dir))
      for (const o of unfiltered(file, fs.readFileSync(path.join(ROOT, file), 'utf8'))) {
        const i = ALLOWED.findIndex(([f, code]) => f === file && o.code.includes(code));
        if (i < 0) left.push(`${file}:${o.line} ${o.code}`);
        else used.add(i);
      }
  assert.deepEqual(left, [], 'skip MoMo’s chats there (shared/momoChat.mjs, src/lib/momoChats.ts) or list the occurrence with why');
  // an entry that no longer matches anything comes off the list
  assert.deepEqual(
    ALLOWED.filter((_e, i) => !used.has(i)).map(([f, code]) => `${f} ${code}`),
    [],
  );
});

test('the guard flags the real lists that once showed MoMo’s chats, and passes them once the predicate is there', () => {
  // each as it was in the repository before the fix (#2161 review), with the predicate missing
  const before: [string, string][] = [
    ['src/components/pages/settings/Archived.tsx', 'export function Archived() {\n  const archived = useStore((s) => s.archived);'],
    ['src/store/remoteArchive.ts', 'archived: t ? [t, ...s.archived.filter((a) => a.id !== id)] : s.archived,'],
    [
      'src/store/actions.ts',
      'if (archivedThread) set((s) => ({ archived: [archivedThread, ...s.archived.filter((t) => t.id !== threadId)] }));',
    ],
    ['electron/session/peerRuntime.cjs', 'const all = [...this.chats.records]\n  .filter(([id]) => id !== source)'],
    [
      'electron/app/autoArchive.cjs',
      "const r = await live.codex.threadList({ limit: 100, cursor, sortKey: 'updated_at', archived: false });",
    ],
    ['electron/app/ipc/chatList.cjs', 'const list = await claude.listSessions(CLAUDE_PAGE, page * CLAUDE_PAGE);'],
    ['electron/app/chromePanel.cjs', 'const live = await live.acpHost.list();'],
    ['electron/x.cjs', 'for (const [id, rec] of Array.from(live.chats.records)) rows.push(id);'],
    ['electron/x.cjs', 'live.chats.records.forEach((rec, id) => rows.push(id));'],
    ['electron/x.cjs', 'const ids = [...live?.chats?.records].map(([id]) => id);'],
    ['electron/x.cjs', 'for (const rec of this.chats.records.values()) n++;'],
    ['electron/x.cjs', 'const store = new ChatsStore(dir);\nfunction rows(records) {\n  return [...records].map(([id]) => id);\n}'],
    ['src/lib/x.ts', 'const all = Object.values(state.threads);'],
    ['src/lib/x.ts', 'const ids = Object.keys(get().claudeArchived);'],
    ['src/lib/x.ts', 'const rows = st.archived.map((t) => t.id);'],
  ];
  for (const [file, code] of before) {
    assert.equal(unfiltered(file, code).length > 0, true, `${file}: ${code}`);
    // the same code with the predicate in its expression passes
    assert.deepEqual(unfiltered(file, `${code}\n  .filter((t) => !isMomoChat(momoChats, t.id));`), [], `${file}: ${code}`);
  }
  // a predicate far away (another function in the file) doesn't count: each occurrence is checked on its own
  const far = `import { isMomoChat } from './momoChats';\n${'\n'.repeat(NEAR + 2)}const all = Object.values(s.threads);`;
  assert.equal(unfiltered('src/lib/x.ts', far).length, 1);
  // lookups by id aren't lists
  for (const code of ['chats.records.get(id)', 'live.chats.records.has(id)', 's.threads[id]', 'records.has(id)'])
    assert.deepEqual(unfiltered(code.startsWith('s.') ? 'src/x.ts' : 'electron/x.cjs', `const ChatsStore = 1;\n${code}`), [], code);
});
