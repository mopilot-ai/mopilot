// list_sidebar: the user's MoPilot projects and chats (title, harness, project, archived, last activity), read-only, for a chat on any harness (#1724).
//
// "Look at my sidebar" is answered from what the sidebar is built from, never by computer use on MoPilot's own
// window (which it never controls): the saved projects, each chat's record (its project, archive and segments) and each
// harness's own session list (title, folder, last activity), read the way automatic archiving reads them. It changes
// nothing. A harness whose list can't be read is named in `unavailable`, so a partial answer is never taken for the whole.
const { createHash } = require('node:crypto');
const { ToolError } = require('../contract/registry.cjs');
const { segmentAliases } = require('../../../shared/segmentAlias.mjs');
const { prefixUnits } = require('../../../shared/textPrefix.mjs');
const { basename, projectHints } = require('../../../shared/paths.mjs');
const { isMomoMeta } = require('../../../shared/momoChat.mjs');

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * A harness session as its own list has it.
 * @typedef {{ key: string, title: string | null, cwd: string | null, at: number, archived?: boolean, harness?: string }} Session
 *   `key`: the segment key a chat record names (a bare Codex id, claude:<id>, acp:<harness>:<id>); `at`: last change (ms);
 *   `archived`: archived in the harness itself; `harness`: the session's harness when no record names it
 */

/** The id of an unsaved folder group: a short hash of its folder key, stable across calls and free of the path itself. */
const folderId = (/** @type {string} */ folder) => `folder:${createHash('sha256').update(folderKey(folder)).digest('hex').slice(0, 12)}`;

/** A title as the sidebar shows it: its first line, at most 80 characters. */
function titleOf(t) {
  const line = String(t ?? '')
    .split('\n')
    .find((l) => l.trim());
  const s = (line ?? '').replace(/\s+/g, ' ').trim();
  return s.length > 80 ? `${prefixUnits(s, 79)}…` : s || null;
}

/** A folder for comparing: forward slashes, no trailing one, one case. */
const folderKey = (p) =>
  String(p ?? '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase();

/** Whether folder key `f` is `root` or inside it. */
const under = (f, root) => !!root && (f === root || f.startsWith(`${root}/`));
/** A managed worktree's repo folder name (…/.mopilot/worktrees/<id>/<repo>/…, or the Codex app's …/.codex/worktrees/…). */
const worktreeRepo = (f) => /\/\.(?:codex|mopilot)\/worktrees\/[^/]+\/([^/]+)/.exec(f)?.[1] ?? null;

/**
 * The saved project a chat's folder belongs to, as the sidebar files it (src/components/sidebar/projectGroups.ts): the
 * deepest project folder holding it (a project at the home folder holds nothing), else the project of the repo a managed
 * worktree was made from.
 * @template {{ path: string }} P
 * @param {P[]} projects @param {string | null | undefined} cwd @param {string} home (a folder key)
 * @returns {P | null}
 */
function projectOf(projects, cwd, home) {
  const f = folderKey(cwd);
  if (!f) return null;
  /** @type {P | null} */
  let best = null;
  for (const p of projects) {
    const root = folderKey(p.path);
    if (root !== home && under(f, root) && (!best || root.length > folderKey(best.path).length)) best = p;
  }
  if (best) return best;
  const repo = worktreeRepo(f);
  return repo ? (projects.find((p) => folderKey(p.path).split('/').at(-1) === repo) ?? null) : null;
}

/** A Claude Code worktree of a folder (…/.claude/worktrees/<name>/…) is that folder. */
const foldClaudeWorktree = (p) => String(p ?? '').replace(/[\\/]\.claude[\\/]worktrees[\\/][^\\/]+.*$/, '');

/**
 * The folder group a chat with no saved project shows in, as the sidebar makes one from the folders chats ran in, or
 * null for a chat the sidebar lists among its recents: no folder, the home folder or a disk's root, a projectless chat's
 * own folder, a managed worktree, or a folder the user hid.
 * @param {string | null | undefined} cwd @param {{ home: string, projectless: string, hidden: string[] }} k folder keys
 */
function folderGroup(cwd, k) {
  const path = foldClaudeWorktree(cwd);
  const f = folderKey(path);
  if (!f || f === k.home || !f.includes('/') || /^[a-z]:$/.test(f) || under(f, k.projectless) || worktreeRepo(`${f}/`)) return null;
  return k.hidden.some((h) => h === f) ? null : path;
}

/**
 * Each chat's harness sessions folded into one row per MoPilot chat: its own first session's title, its latest activity
 * and folder. Shared by list_sidebar and list_chats, so both name a chat the same on every harness.
 * @param {Iterable<[string, Iterable<string>]>} natives each chat's segment keys in order (platform/chats.cjs nativeIdsOf)
 * @param {Record<string, Session[] | Error>} sessions each harness's sessions, or why they couldn't be read
 */
function foldSessions(natives, sessions) {
  const owners = segmentAliases(natives);
  const unavailable = [];
  /** @type {Map<string, { title: string | null, cwd: string | null, at: number, archived: boolean, harness: string }>} chat id -> what its sessions say, the newest last */
  const chats = new Map();
  for (const [family, list] of Object.entries(sessions)) {
    if (list instanceof Error) {
      unavailable.push({ harness: family, error: list.message });
      continue;
    }
    for (const s of list) {
      const id = owners.get(s.key) ?? s.key;
      const prev = chats.get(id);
      // the chat's own first session names it; a later segment (a switch) only moves its last activity and folder
      const own = s.key === id;
      chats.set(id, {
        title: (own ? s.title : null) ?? prev?.title ?? s.title,
        cwd: !prev || s.at >= prev.at ? s.cwd : prev.cwd,
        at: Math.max(prev?.at ?? 0, s.at),
        archived: (prev?.archived ?? false) || !!s.archived,
        harness: prev?.harness ?? s.harness ?? family,
      });
    }
  }
  return { chats, unavailable };
}

/**
 * The projects and chats the sidebar would show, filtered and newest first.
 * @param {object} o
 * @param {{ id: string, name: string, path: string }[]} o.projects the saved projects
 * @param {string} [o.home] the home folder (a project there holds no chat by its folder)
 * @param {{ projectlessFolder?: string | null, hiddenFolders?: string[], folderNames?: Record<string, string> }} [o.prefs]
 *   the sidebar's own settings: where projectless chats get folders, the folders it hides and the names given to folders
 * @param {Iterable<[string, { segments: { kind: string }[], meta: { archived?: number | null, projectId?: string | null, worktreeOf?: string | null } }]>} o.records
 * @param {Iterable<[string, Iterable<string>]>} o.natives each chat's segment keys in order (platform/chats.cjs nativeIdsOf)
 * @param {Record<string, Session[] | Error>} o.sessions each harness's sessions, or why they couldn't be read
 * @param {number} [o.maxLimit] the most chats one call returns (default 200, the bound the model-facing tool keeps)
 * @param {{ project?: string, include_archived?: boolean, only_archived?: boolean, limit?: number, offset?: number }} args `offset`: chats to skip (a page start); `only_archived`: the archive alone
 */
function listChats(o, args) {
  const limit = Math.max(1, Math.min(o.maxLimit ?? MAX_LIMIT, Number.isInteger(args.limit) ? Number(args.limit) : DEFAULT_LIMIT));
  const records = new Map(o.records);
  const { chats, unavailable } = foldSessions(o.natives, o.sessions);
  const byId = new Map(o.projects.map((p) => [p.id, p]));
  const home = folderKey(o.home ?? '');
  const prefs = o.prefs ?? {};
  const keys = {
    home,
    projectless: folderKey(prefs.projectlessFolder || (o.home ? `${o.home}/Documents/MoPilot` : '')),
    hidden: (prefs.hiddenFolders ?? []).map(folderKey),
  };
  const names = new Map(Object.entries(prefs.folderNames ?? {}).map(([k, v]) => [folderKey(k), v]));
  const want = args.project ? String(args.project).trim().toLowerCase() : null;
  /** the folders chats ran in that the sidebar shows as unsaved projects: folder key -> { name, folder } */
  const folders = new Map();
  const rows = [];
  for (const [id, c] of chats) {
    const rec = records.get(id);
    const meta = rec?.meta ?? {};
    // MoMo's chats are in no list, and its workspace is no project (shared/momoChat.mjs)
    if (isMomoMeta(meta)) continue;
    const saved = (meta.projectId && byId.get(meta.projectId)) || projectOf(o.projects, meta.worktreeOf ?? c.cwd, home);
    const path = saved ? null : folderGroup(meta.worktreeOf ?? c.cwd, keys);
    const project = saved
      ? { id: saved.id, name: saved.name, path: saved.path }
      : path
        ? { id: folderId(path), name: names.get(folderKey(path)) ?? basename(path), path }
        : null;
    const archived = typeof meta.archived === 'number' || c.archived;
    if (archived && args.include_archived !== true) continue;
    // the newest chat in a folder comes first, so its folder does too
    const k = path ? folderKey(path) : null;
    if (k && !archived && (folders.get(k)?.at ?? -1) < c.at) folders.set(k, { name: project?.name, folder: path, at: c.at });
    if (
      want &&
      !(project?.name.toLowerCase() === want || folderKey(project?.path) === folderKey(want) || under(folderKey(c.cwd), folderKey(want)))
    )
      continue;
    rows.push({
      id,
      title: c.title ?? 'New chat',
      harness: rec?.segments.at(-1)?.kind ?? c.harness,
      project: project?.name ?? null,
      // two projects can share a name, so a client groups by this: a saved project's id, or a hash of the folder's key (never the path)
      projectId: project?.id ?? null,
      folder: c.cwd,
      archived,
      lastActivity: new Date(c.at).toISOString(),
    });
  }
  // two projects of one name are told apart as the sidebar tells them: by the last parent folders of each (a project the list does not carry says nothing)
  const hints = projectHints([
    ...o.projects.map((p) => ({ id: p.id, name: p.name, path: p.path })),
    ...[...folders.values()].map((f) => ({ id: folderId(f.folder), name: f.name, path: f.folder })),
  ]);
  for (const r of rows) {
    const hint = r.projectId ? hints.get(r.projectId) : undefined;
    if (hint) r.projectHint = hint;
  }
  // a total order (the id breaks a tie in time): a phone reads the list a page at a time, each page a fresh listing
  rows.sort((a, b) => (a.lastActivity < b.lastActivity ? 1 : a.lastActivity > b.lastActivity ? -1 : a.id < b.id ? -1 : 1));
  const offset = Number.isInteger(args.offset) ? Math.max(0, Number(args.offset)) : 0;
  const shown = (args.only_archived === true ? rows.filter((r) => r.archived) : rows).slice(offset);
  const matches = (/** @type {{ name: string, folder: string }} */ p) =>
    !want || p.name.toLowerCase() === want || folderKey(p.folder) === folderKey(want);
  const projects = [
    ...o.projects.map((p) => ({ name: p.name, folder: p.path, saved: true })),
    // a folder chats ran in shows in the sidebar like a project until it is saved as one: the most recently used first
    ...[...folders.values()].sort((x, y) => y.at - x.at).map(({ name, folder }) => ({ name, folder, saved: false })),
  ].filter(matches);
  return {
    projects: projects.slice(0, limit),
    ...(projects.length > limit ? { moreProjects: projects.length - limit } : {}),
    chats: shown.slice(0, limit),
    ...(shown.length > limit ? { more: shown.length - limit } : {}),
    ...(unavailable.length ? { unavailable } : {}),
  };
}

/**
 * Registers list_sidebar.
 * @param {any} registry
 * @param {object} o
 * @param {(ctx: any) => string | null} o.owner the chat that called (the one owning the call's segment)
 * @param {() => { id: string, name: string, path: string }[]} o.projects the saved projects
 * @param {string} [o.home] the home folder
 * @param {() => any} [o.prefs] the sidebar's settings (projectlessFolder, hiddenFolders, folderNames)
 * @param {() => Map<string, any>} o.records the chat records
 * @param {() => Iterable<[string, Iterable<string>]>} o.natives each chat's segment keys in order
 * @param {Record<string, (archived: boolean) => Promise<Session[]>>} o.sources each harness's sessions (`archived`: the
 *   ones archived in the harness too)
 * @returns {() => void} removes the tool
 */
function registerChatListTool(registry, o) {
  return registry.register({
    name: 'list_sidebar',
    description:
      "List the user's MoPilot sidebar: its projects (name, folder) and chats (title, harness, project, folder, archived, last activity), newest first. Read-only. Use it to answer questions about the user's projects or chats instead of looking at MoPilot's window, which computer use never controls. (list_chats finds a chat to message.)",
    schema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: "Only this project's chats: its name or folder" },
        include_archived: { type: 'boolean', description: 'Include archived chats (default false)' },
        limit: {
          type: 'integer',
          description: `At most this many projects and this many chats (default ${DEFAULT_LIMIT}, at most ${MAX_LIMIT})`,
        },
      },
      required: [],
      additionalProperties: false,
    },
    policy: 'observe',
    handler: async (args, ctx) => {
      if (!o.owner(ctx)) throw new ToolError('The caller does not own this chat segment', 'no_owner');
      const archived = args.include_archived === true;
      const families = Object.keys(o.sources);
      // one harness failing leaves the others' chats, and says which one is missing
      const lists = await Promise.all(
        families.map((f) => o.sources[f](archived).catch((e) => (e instanceof Error ? e : new Error(String(e))))),
      );
      return listChats(
        {
          projects: o.projects(),
          home: o.home,
          prefs: o.prefs?.(),
          records: o.records(),
          natives: o.natives(),
          sessions: Object.fromEntries(families.map((f, i) => [f, lists[i]])),
        },
        args,
      );
    },
  });
}

module.exports = { registerChatListTool, listChats, foldSessions, titleOf };
