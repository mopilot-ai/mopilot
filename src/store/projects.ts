// Projects, worktrees, new-chat targets and per-chat config. @store-slice: tests' store stub replaces it whole (tests/support/stubs.ts).

import type { AppState, SavedProject } from './state';
import { threadProjectIdField } from '../harness/registry';
import { codexApi } from '../harness/adapters/codexApi';
import { native, type LocalProject, type WorktreeCopy } from '../lib/native';
import type { IssueSource, PullRequestSource } from '../lib/native/git';
import type { LinearSource } from '../lib/native/linear';
import { errorText, noteIgnored } from '../lib/ignored';
import type { ChatConfig } from '../lib/chatMeta';
import { basename, isUnder, samePath, sameDirectory, splitPath } from '../lib/paths';
import { machineFolderKey } from '../lib/machineFolder';
import { resolveEnvironment, type ResolvedEnvironment } from '../lib/environments';
import { worktreeRootOf, projectlessFolderOf, type Thread } from './types';
import type { ProjectCreateResponse } from '../protocol/v2/ProjectCreateResponse';
import { get, set, setPrefs, toast, upsertThread, patchRuntime } from './core';
import { permissionParams, rememberRunOn } from './chats';
import { held } from './threads';
import { dropNewChatHost } from './repositoryDraft';

/**
 * Where the next new chat goes: a folder on another machine, a folder picked outside any project, else a saved project
 * (picked, or newChatProject's default); null for a projectless chat. newChatTarget names it and the sidebar marks its row
 * (src/components/sidebar/homeTarget.ts), so the home page and the sidebar cannot disagree.
 */
export function newChatGoal(s: AppState = get()) {
  const pick = newChatHostPick(s);
  if (pick) return { kind: 'machine', pick } as const;
  if (s.newChatCwd && s.newChatProjectId === null) return { kind: 'folder', path: s.newChatCwd } as const;
  const project = newChatProject(s);
  return project ? ({ kind: 'project', project } as const) : null;
}

/**
 * What the next new chat targets, for display: a project, an explicitly chosen folder, or a folder on another machine
 * (named with the machine; its path is '' because it is no path on this Mac, so nothing here looks inside it).
 */
export function newChatTarget(): { name: string; path: string; projectId: string | null } | null {
  const goal = newChatGoal(get());
  if (goal?.kind === 'machine') {
    const { pick } = goal;
    return { name: pick.path ? `${basename(pick.path)} · ${pick.name}` : pick.name, path: '', projectId: null };
  }
  if (goal?.kind === 'folder') return { name: basename(goal.path), path: goal.path, projectId: null };
  return goal ? { name: goal.project.name, path: goal.project.roots[0]?.path ?? '', projectId: goal.project.id } : null;
}

/** The folder the draft's Worktree switch and branch chip are for: a project's or picked folder on this Mac by its path, a picked folder on a machine by its folder key (`machineFolderKey`); null when there is none, a machine picked with no folder yet included. */
export function newChatFolderKey(s = get()): string | null {
  const pick = newChatHostPick(s);
  return pick ? (pick.path ? machineFolderKey(pick.id, pick.path) : null) : newChatTarget()?.path || null;
}

/** The folder on a remote machine picked for the next new chat, while nothing else was picked after it (a project or a local folder replaces it). */
export function newChatHostPick(s = get()): NonNullable<AppState['newChatHost']> | null {
  return s.newChatProjectId === null && s.newChatCwd === null ? s.newChatHost : null;
}

/**
 * Choose the next chat's device. Reselecting a machine preserves its draft. Another machine recalls its last folder.
 * This Mac clears the machine pick and returns null. A machine picked, from anywhere, drops a Codex Cloud environment.
 */
export function pickNewChatHost(m: { id: string; name: string }): NonNullable<AppState['newChatHost']> | null {
  const s = get();
  const kept = newChatHostPick(s);
  rememberRunOn(m);
  if (m.id === 'local') {
    if (kept) dropNewChatHost(kept);
    return null;
  }
  const pick = kept?.id === m.id ? kept : { id: m.id, name: m.name, path: s.prefs.hostFolders[m.id] ?? '', before: targetBefore(s, kept) };
  setHostPick(pick);
  return pick;
}

/** The folder picked on `host` for the next new chat; its agent stays when the machine is the one already picked. */
export function setNewChatHostFolder({ id, name, scope }: { id: string; name: string; scope?: string }, path: string) {
  const s = get();
  const kept = newChatHostPick(s);
  const sameHost = kept?.id === id && (scope === undefined || kept.scope === undefined || kept.scope === scope);
  setHostPick({ ...(sameHost ? kept : {}), id, name, path, ...(scope !== undefined && { scope }), before: targetBefore(s, kept) });
}

function setHostPick(newChatHost: NonNullable<AppState['newChatHost']>) {
  set({ newChatProjectId: null, newChatCwd: null, newChatHost, newChatCloudEnv: null, newChatRepositoryGroup: undefined });
}

/** What the new chat targeted before any machine was picked: a pick already in place carries it from the first one. */
const targetBefore = (s: AppState, kept: AppState['newChatHost']) =>
  kept ? kept.before : { projectId: s.newChatProjectId, cwd: s.newChatCwd };

/** A machine was removed: its remembered folder and starting picks go (one added again under its id picks a folder anew), and so does a new chat's pick of it. */
export function forgetHostMachine(id: string) {
  const s = get();
  if (id in s.prefs.hostFolders || id in s.prefs.hostPicks) {
    const { [id]: _gone, ...rest } = s.prefs.hostFolders;
    const { [id]: _picked, ...picks } = s.prefs.hostPicks;
    setPrefs({ hostFolders: rest, hostPicks: picks });
  }
  const kept = newChatHostPick(s);
  if (kept?.id === id) dropNewChatHost(kept);
}

/** Machines that were listed and are gone (removed elsewhere): a new chat's pick of one goes, as when it was removed here. */
export function dropGoneHostPick(gone: readonly string[]) {
  const kept = newChatHostPick();
  if (kept && gone.includes(kept.id)) dropNewChatHost(kept);
}

/**
 * Where the next new chat runs, as far as it is known before its send: a folder picked outside any project, else the
 * new-chat project's first root. `cwd` is '' when the send makes the chat its own projectless folder.
 */
export function newChatBase(s = get()): { explicitCwd: string | null; proj: SavedProject | null; cwd: string } {
  const explicitCwd = s.newChatCwd && s.newChatProjectId === null ? s.newChatCwd : null;
  const proj = explicitCwd ? null : newChatProject();
  return { explicitCwd, proj, cwd: explicitCwd ?? (proj ? proj.roots[0].path : '') };
}

/** Project selected for the next new chat (null = projectless): the picked one, else the newest chat's, else the first saved. */
export function newChatProject(s: AppState = get()): SavedProject | null {
  if (s.newChatProjectId === 'none') return null;
  if (s.newChatProjectId) {
    const p = s.savedProjects.find((x) => x.id === s.newChatProjectId);
    if (p) return p;
  }
  // default: project of the most recent chat, else the first project
  for (const id of s.threadOrder) {
    const t = s.threads[id];
    const p = t && projectForThread(t, s.savedProjects);
    if (p) return p;
  }
  return s.savedProjects[0] ?? null;
}

/** Match one project-id namespace without letting list order mix local and native identities. */
function projectById(projects: SavedProject[], id: string | null | undefined, field: 'id' | 'codexId'): SavedProject | null {
  if (!id) return null;
  return projects.find((p) => p[field] === id) ?? null;
}

export function projectForThread(
  t: Pick<Thread, 'id' | 'projectId' | 'cwd'>,
  projects: SavedProject[],
  resolve = (p: string) => p,
): SavedProject | null {
  const field = threadProjectIdField(t.id);
  const remembered = get().chatProject[t.id];
  const assigned =
    projectById(projects, t.projectId, field) ??
    projectById(projects, remembered, 'id') ??
    projectById(projects, t.projectId, field === 'id' ? 'codexId' : 'id') ??
    projectById(projects, remembered, 'codexId');
  if (assigned) return assigned;
  const cwd = resolve(t.cwd || '');
  const home = resolve(get().home);
  let best: SavedProject | null = null;
  let bestDepth = -1;
  for (const p of projects)
    for (const r of p.roots.filter((r) => !sameDirectory(resolve(r.path), home))) {
      const root = resolve(r.path);
      const depth = splitPath(root).length;
      if (isUnder(cwd, root) && depth > bestDepth) {
        best = p;
        bestDepth = depth;
      }
    }
  return best;
}

export function currentCwdForNewChat(): string {
  const s = get();
  const base = s.newChatCwd && s.newChatProjectId === null ? s.newChatCwd : (newChatProject()?.roots[0]?.path ?? s.home);
  // a workspace picked for that folder is where the chat will run: its files and commands are the ones to offer
  return s.newChatWorkspace?.root === base ? s.newChatWorkspace.path : base;
}

export const fromLocal = (p: LocalProject): SavedProject => ({
  id: p.id,
  name: p.name,
  roots: [{ path: p.path }],
  source: p.source,
  codexId: p.codexId,
});

export async function loadProjects() {
  try {
    const r = await native.projects.list();
    set({ savedProjects: r.projects.map(fromLocal) });
    return r;
  } catch (error) {
    // the list stays as last loaded; projects:changed brings the next one
    noteIgnored('list the projects', error);
    return null;
  }
}

/** Codex is connected, so its project API can be called. */
const codexProjectsReady = () => get().conn === 'ready';

/**
 * Bring Codex's projects into the local list: once on the first connect (recorded in projects.json;
 * a failure is retried on a later connect), then on every connect and project/changed. One way only.
 */
export async function syncCodexProjects() {
  // Codex isn't running (left for first use): the first import asks a short-lived app-server in main
  if (get().conn === 'idle') {
    // not imported: a later connect imports them
    const snap = await native.projects
      .importCodexBackground()
      .catch((error) => (noteIgnored("import Codex's projects without Codex running", error), null));
    if (snap) set({ savedProjects: snap.projects.map(fromLocal) });
    return;
  }
  if (!codexProjectsReady()) return;
  try {
    const r = await codexApi.projectList();
    const snap = await native.projects.importCodex(r.data ?? []);
    set({ savedProjects: snap.projects.map(fromLocal) });
  } catch (e) {
    // recorded in projects.json (an older app-server has no project API); the next launch tries again
    // unrecorded, the import is simply tried again on the next connect
    native.projects.importFailed(errorText(e)).catch((error) => noteIgnored("record that importing Codex's projects failed", error));
  }
}

/** Show a removed Claude folder in Projects again (it was added back, or a chat started there). */
export function unhideFolder(path: string) {
  const hidden = get().prefs.hiddenFolders ?? [];
  if (hidden.includes(path)) setPrefs({ hiddenFolders: hidden.filter((p) => p !== path) });
}

export async function createProject(path: string, name?: string) {
  const existing = get().savedProjects.find((p) => p.roots.some((r) => samePath(r.path, path)));
  if (existing) {
    unhideFolder(path);
    return existing.id;
  }
  try {
    // Local persistence admits the operation before another harness is allowed to create a copy.
    const id = await native.projects.add({ path, name });
    if (!id) return null;
    unhideFolder(path);
    if (codexProjectsReady()) {
      try {
        const r = await codexApi.projectCreate(name ?? basename(path), path);
        const codexId = (r.project?.id ?? (r as ProjectCreateResponse & { id?: string }).id) as string | undefined;
        if (codexId) await native.projects.linkCodex(id, codexId);
      } catch (error) {
        // The durable local project remains usable if its optional native copy cannot be made or linked.
        noteIgnored('create the matching Codex project', error);
      }
    }
    const latest = await loadProjects();
    if (!latest) {
      toast('Project saved, but its list could not be refreshed. Try again.', 'error');
      return null;
    }
    return latest.projects.some((p) => p.id === id) ? id : null;
  } catch (e) {
    toast(`Couldn't add project: ${errorText(e)}`, 'error');
    return null;
  }
}

const codexIdOf = (projectId: string | null) => (projectId ? get().savedProjects.find((p) => p.id === projectId)?.codexId : undefined);

export async function renameProject(projectId: string, name: string) {
  const codexId = codexIdOf(projectId);
  await native.projects.rename(projectId, name);
  await loadProjects();
  if (codexId && codexProjectsReady())
    // Codex's copy is a one-way mirror; the project itself is renamed
    codexApi.projectUpdate(codexId, name).catch((error) => noteIgnored('rename the matching Codex project', error));
}

export async function deleteProject(projectId: string) {
  const codexId = codexIdOf(projectId);
  await native.projects.remove(projectId);
  await loadProjects();
  if (codexId && codexProjectsReady())
    // Codex's copy is a one-way mirror; the project itself is removed
    codexApi.projectDelete(codexId).catch((error) => noteIgnored('delete the matching Codex project', error));
}

export async function moveProject(projectId: string, beforeProjectId: string | null) {
  const codexId = codexIdOf(projectId);
  const beforeCodexId = codexIdOf(beforeProjectId);
  await native.projects.move(projectId, beforeProjectId);
  await loadProjects();
  if (codexId && (beforeCodexId || !beforeProjectId) && codexProjectsReady())
    // Codex's copy is a one-way mirror; the project itself is moved
    codexApi.projectMove(codexId, beforeCodexId ?? null).catch((error) => noteIgnored('move the matching Codex project', error));
}

/**
 * Run the project's setup or cleanup script (environment.toml, else Conductor's, as main resolves it) in a worktree; a
 * failure is reported, not fatal.
 */
export async function runEnvironmentScript(kind: 'setup' | 'cleanup', repo: string, dir: string) {
  let env: ResolvedEnvironment;
  try {
    env = await resolveEnvironment(repo);
  } catch (e) {
    // an environment.toml that is there but can't be read: say so, and the worktree goes on without its script
    return toast(`Couldn't read the ${kind} script: ${errorText(e)}`, 'error');
  }
  // Conductor config that is there but can't be read: say so, and run what could be read
  if (env.notice) toast(env.notice, 'error');
  const script = kind === 'setup' ? env.setup : env.cleanup;
  if (!script) return;
  const r = await native.env.runScript(dir, script);
  if (r.exitCode !== 0)
    toast(`${kind === 'setup' ? 'Setup' : 'Cleanup'} script failed (exit ${r.exitCode}): ${r.output.trim().split('\n').pop()}`, 'error');
}

/** Say what a new or restored worktree did not get of its repository's ignored files (nothing when it got them all). */
export function noteWorktreeCopy(copy: WorktreeCopy | undefined) {
  if (copy?.notice) toast(copy.notice, 'error');
}

/** A pull request picked to start from, found again and its head fetched (native.git.fetchPullRequest). */
export type FetchedPullRequest = Extract<PullRequestSource, { ok: true }>;

/** Pull request `number` of cwd's origin repository, found again and its head fetched; throws why not. */
export async function fetchedPullRequest(cwd: string, number: number): Promise<FetchedPullRequest> {
  const pr = await native.git.fetchPullRequest(cwd, number);
  if (!pr.ok) throw new Error(pr.error);
  return pr;
}

/** Issue `number` of cwd's origin repository, found again with its text quoted for the agent; throws why not. */
export async function fetchedIssue(cwd: string, number: number): Promise<Extract<IssueSource, { ok: true }> & { context: string }> {
  const issue = await native.git.issue(cwd, number);
  if (!issue.ok) throw new Error(issue.error);
  if (typeof issue.context !== 'string') throw new Error('GitHub returned incomplete issue data. Try again.');
  return { ...issue, context: issue.context };
}

/** Linear issue `key`, read again with its text quoted for the agent; throws why not. */
export async function fetchedLinear(key: string): Promise<Extract<LinearSource, { ok: true }> & { context: string }> {
  const issue = await native.linear.issue(key);
  if (!issue.ok) throw new Error(issue.error);
  if (typeof issue.context !== 'string') throw new Error('Linear returned incomplete issue data. Try again.');
  return { ...issue, context: issue.context };
}

/**
 * A managed worktree for `cwd`'s repo from `base` (else origin's default branch; a fetched pull request's own branch), with the project's setup script run in
 * it before any harness starts there; `unsupported` says why the folder can't hold one (not a repository, or no commits).
 */
export async function newWorktree(
  cwd: string,
  base: string | null = null,
  pr: FetchedPullRequest | null = null,
  /** a branch named for the chat's task (a Linear issue's suggested one), made from `base` */
  named: string | null = null,
): Promise<{ path: string; branch: string } | { unsupported: string }> {
  const { prefs, home } = get();
  const wt = await native.git.worktreeAdd(cwd, {
    prefix: prefs.branchPrefix,
    root: worktreeRootOf(prefs, home),
    // a fetched pull request's worktree works on its branch, which merges into its base
    ...(pr ? { branch: pr.base, checkout: pr.checkout, ...(pr.own ? {} : { pullRequest: pr.number }) } : base ? { branch: base } : {}),
    ...(!pr && named ? { newBranch: named } : {}),
  });
  if (!wt.ok && wt.unsupported) return { unsupported: wt.error! };
  if (!wt.ok) throw new Error(`Couldn't create worktree: ${wt.error}`);
  noteWorktreeCopy(wt.copy);
  await runEnvironmentScript('setup', wt.repo!, wt.worktree!);
  return { path: wt.path!, branch: wt.branch! };
}

/** Codex pages read past the sidebar's when retiring a worktree (100 chats each); more than this and nothing is pruned. */
const CHAT_PAGES_MAX = 200;

/**
 * Every open chat's folder: the loaded ones, and the Codex chats past the sidebar's loaded pages (the sidebar
 * reads Codex 100 chats at a time). Null when they can't all be listed.
 */
async function openChatFolders(): Promise<string[] | null> {
  const { threads, threadsCursor } = get();
  const out = Object.values(threads).flatMap((t) => (t.cwd ? [t.cwd] : []));
  let cursor = threadsCursor;
  for (let page = 0; cursor; page++) {
    if (page === CHAT_PAGES_MAX) return null;
    try {
      const r = await codexApi.threadList({ limit: 100, cursor, sortKey: 'updated_at' });
      // a chat archived in MoPilot's meta is not open, even when Codex still lists it
      const { claudeArchived } = get();
      for (const t of r.data as Thread[]) if (t.cwd && !claudeArchived[t.id]) out.push(t.cwd);
      cursor = r.nextCursor;
    } catch (error) {
      noteIgnored('list the chats past the loaded pages before pruning worktrees', error);
      return null;
    }
  }
  return out;
}

/**
 * A chat in a managed worktree was archived or deleted: run the project's cleanup script there; an archive with "Delete
 * branch on archive" on then removes the worktree and its branch when nothing on them is lost (restoring the worktree
 * makes the branch again). Then, with auto-delete on, prune the oldest worktrees no open chat uses. A worktree another open
 * chat still works in (a fork, or a chat started in the same folder) is left as it is, and so is one adopted in place.
 */
export async function retireWorktree(cwd: string | undefined, { archive = false } = {}) {
  const wt = cwd ? await native.git.worktreeInfo(cwd) : null;
  // an adopted worktree stays, and the tool that made it may still use it: the cleanup script is for one that is going away
  if (!wt || wt.adopted) return;
  const keep = await openChatFolders();
  if (keep?.some((c) => isUnder(c, wt.path))) return;
  await runEnvironmentScript('cleanup', wt.repo, wt.path);
  // without every open chat's folder, one still working there could lose its worktree
  if (archive && keep && get().prefs.deleteBranchOnArchive) {
    const r = await native.git.worktreeArchive(wt.path);
    if (!r.ok) toast(`Couldn't delete this chat's branch: ${r.error}`, 'error');
    else if (r.kept) toast(r.kept, 'info');
  }
  const { prefs, home } = get();
  // without every open chat's folder, one of theirs could be pruned
  if (prefs.autoDeleteWorktrees && keep) await native.git.worktreePrune(worktreeRootOf(prefs, home), prefs.autoDeleteLimit, keep);
}

/** Projectless chats get their own dated folder, like the official app (~/Documents/MoPilot/<date>/<slug>). */
export async function projectlessCwd(seed: string) {
  const s = get();
  const date = new Date().toISOString().slice(0, 10);
  const slug =
    seed
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 48) || 'chat';
  // made here rather than through Codex, which may not be installed; no chat starts in a missing folder
  const r = await native.fs.mkdirProjectless(projectlessFolderOf(s.prefs, s.home), date, slug);
  if (r.ok === false) throw new Error(`Couldn't create the chat folder: ${r.error}`);
  return r.path;
}

/** What thread/start gets for a new Codex chat: the one params builder for its send and its prewarm (src/store/prewarm.ts). */
export function codexThreadParams(
  prefs: Pick<ReturnType<typeof get>['prefs'], 'model' | 'permission' | 'serviceTier'>,
  opts: { cwd: string; ephemeral?: boolean; projectId?: string | null },
) {
  return {
    cwd: opts.cwd,
    projectId: opts.projectId ?? undefined,
    model: prefs.model,
    ...permissionParams(prefs.permission, opts.cwd),
    ephemeral: opts.ephemeral ?? false,
    serviceTier: prefs.serviceTier,
  };
}

export async function startThread(opts: {
  cwd: string;
  ephemeral?: boolean;
  projectId?: string | null;
  /** the saved project's own id, when projectId is its Codex id (which a project not synced to Codex lacks) */
  localProjectId?: string | null;
}): Promise<string> {
  // a chat started in a folder removed from Projects brings it back
  if (!opts.ephemeral) unhideFolder(opts.cwd);
  const { prefs } = get();
  const params = codexThreadParams(prefs, opts);
  // the thread main started while the composer was open (#1664), when it is what this one needs; else a new one
  const warm = opts.ephemeral
    ? null
    : ((await native.session
        .prewarmTake({ kind: 'codex', params })
        .catch((error) => (noteIgnored('take the prewarmed Codex thread', error), null))) as { thread?: Thread } | null);
  const t: Thread = warm?.thread ?? (await native.codex.startThread(params)).thread;
  held.add(t.id);
  upsertThread(t, true);
  rememberChatProject(t.id, opts.localProjectId ?? opts.projectId, opts.ephemeral);
  // the chat starts from the defaults and keeps its own from here on
  if (!opts.ephemeral) setChatConfig(t.id, { model: prefs.model, effort: prefs.effort, serviceTier: prefs.serviceTier });
  patchRuntime(t.id, () => ({ loaded: true, loading: false }));
  return t.id;
}

/** Keep the project a new chat was started in, so it stays there when its cwd matches no project root (a renamed or moved checkout). */
export function rememberChatProject(chatId: string, projectId: string | null | undefined, ephemeral?: boolean) {
  if (!projectId || ephemeral) return;
  set((s) => ({ chatProject: { ...s.chatProject, [chatId]: projectId } }));
}

/** A Codex chat's own model, effort or service tier. */
export function setChatConfig(chatId: string, patch: ChatConfig) {
  set((s) => ({ chatConfig: { ...s.chatConfig, [chatId]: { ...s.chatConfig[chatId], ...patch } } }));
}
export function copyChatConfig(from: string, to: string) {
  const c = get().chatConfig[from];
  if (c) setChatConfig(to, c);
}
