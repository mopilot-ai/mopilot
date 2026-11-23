// The new-chat composer's prewarm (#1664). While Home shows a new chat, this tells main what that chat's first send
// would start (electron/session/contract/prewarm.cjs), and that send takes it. Each family's spec comes from the same folder
// and params the send uses. Main works out the rest itself (account, model, permission).
import { native } from '../lib/native';
import { noteIgnored } from '../lib/ignored';
import type { HarnessFamily } from '../harness/family';
import type { AppState } from '../store/state';
import { get, useStore } from './core';
import { newChatBasic, newChatFamily, newChatWorktreeOn } from './chats';
import { codexThreadParams, newChatBase } from './projects';

/** What a new chat's first send would start: its harness kind, and the folder or thread/start params where known. */
export type PrewarmSpec = { kind: string; cwd?: string; params?: ReturnType<typeof codexThreadParams> | null };

/** A shown composer tells main again this often, so main keeps what it warmed (it lets an entry go after 3 minutes). */
export const HEARTBEAT_MS = 60_000;
/** Changes settle this long before main hears of them: typing a folder or flipping a picker warms once. */
export const SETTLE_MS = 250;

/** The folder the send runs in when it is known now: not one it makes itself (a projectless chat, a worktree). */
function knownFolder(s: AppState): { cwd: string; codexProjectId: string | null } | null {
  const base = newChatBase(s);
  // a picked workspace is there already: the send runs in it
  if (base.cwd && s.newChatWorkspace?.root === base.cwd)
    return { cwd: s.newChatWorkspace.path, codexProjectId: base.proj?.codexId ?? null };
  if (!base.cwd || (newChatWorktreeOn(s) && (base.proj || base.explicitCwd))) return null;
  return { cwd: base.cwd, codexProjectId: base.proj?.codexId ?? null };
}

/** Each family's spec: a Claude CLI needs its folder; Codex warms its app-server even without one; ACP warms its process. */
const SPECS: Record<HarnessFamily, (s: AppState) => PrewarmSpec | null> = {
  claude: (s) => {
    const f = knownFolder(s);
    return f ? { kind: 'claude', cwd: f.cwd } : null;
  },
  codex: (s) => {
    const f = knownFolder(s);
    return { kind: 'codex', params: f ? codexThreadParams(s.prefs, { cwd: f.cwd, projectId: f.codexProjectId }) : null };
  },
  acp: (s) => ({ kind: `acp:${newChatBasic(s)}` }),
};

/** What this window's new chat would start now, or null (no new chat on screen, or a temporary one, which isn't warmed). */
export function prewarmSpec(s: AppState = get()): PrewarmSpec | null {
  if (s.route.name !== 'home' || s.newChatTemporary) return null;
  return SPECS[newChatFamily(s)](s);
}

/** The first send of a new Claude chat in `cwd`: `{ sid }` of the CLI main warmed for it, or `{}` to start one. */
export async function takeClaudeSession(cwd: string): Promise<{ sid?: string }> {
  const r = (await native.session.prewarmTake({ kind: 'claude', cwd }).catch((error) => {
    noteIgnored('take the prewarmed Claude Code session', error);
    return null;
  })) as { id?: unknown } | null;
  return typeof r?.id === 'string' ? { sid: r.id } : {};
}

/** The slices a spec reads: a change in any of them may change what the new chat would start. */
const inputsOf = (s: AppState) => [
  s.route,
  s.prefs,
  s.newChatCwd,
  s.newChatProjectId,
  s.newChatWorktree,
  s.newChatWorkspace,
  s.newChatTemporary,
  s.savedProjects,
  s.threadOrder,
  // which harness the new chat runs on: Codex's connection, Claude's status, the basic harnesses' admission
  s.conn,
  s.claude.status,
  s.basicHarnesses,
  s.claudeAccounts,
  s.accounts,
  s.focused,
];

/**
 * Follow this window's new-chat composer. A spec goes to main when it changes, and again every HEARTBEAT_MS while
 * the window is in front. Leaving Home sends null, so main lets go of what it warmed.
 * @returns the unsubscribe (tests)
 */
export function startPrewarm() {
  let sent: string | null = null;
  let sentAt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    timer = undefined;
    const s = get();
    const spec = prewarmSpec(s);
    const text = JSON.stringify(spec);
    // the same spec again only while the window is in front: a window left behind lets main's entry go idle
    if (text === sent && !(spec && s.focused && Date.now() - sentAt >= HEARTBEAT_MS)) return;
    sent = text;
    sentAt = Date.now();
    native.session.prewarm(spec);
  };
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(flush, SETTLE_MS);
  };
  let last = inputsOf(get());
  const stop = useStore.subscribe((s) => {
    const next = inputsOf(s);
    if (next.every((v, i) => v === last[i])) return;
    last = next;
    schedule();
  });
  const beat = setInterval(schedule, HEARTBEAT_MS);
  schedule();
  return () => {
    stop();
    clearInterval(beat);
    clearTimeout(timer);
  };
}
