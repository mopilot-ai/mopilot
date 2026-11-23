// The Cmd+K chat list: one result list from every place a chat can be found. Pure, so the merge
// is tested without the app (tests/chatSearch.test.ts).
import { byActivity } from './chatActivity';
import { isMomoChat, type MomoChats } from './momoChats';

export interface Searchable {
  id: string;
  updatedAt: number;
  recencyAt?: number | null;
  ephemeral?: boolean;
  parentThreadId?: string | null;
}

/** Current canonical ownership and actual rows; metadata alone never creates a search result. */
export interface SearchIdentity<T extends Searchable> {
  segments?: Record<string, readonly { nativeId: string }[]>;
  knownChats?: Record<string, T>;
  archived?: Record<string, number>;
  excluded?: (id: string) => boolean;
  /** MoMo's chats, which no search or picker offers (lib/momoChats.ts) */
  momoChats?: MomoChats;
}

/** Later-session aliases are hidden when ownership is ambiguous, rather than guessed. */
export function chatSearchOwners(segments: SearchIdentity<Searchable>['segments']) {
  const owners = new Map<string, string | null>();
  for (const [owner, list] of Object.entries(segments ?? {}))
    for (const segment of list) {
      if (segment.nativeId === owner) continue;
      const before = owners.get(segment.nativeId);
      owners.set(segment.nativeId, before === undefined || before === owner ? owner : null);
    }
  return owners;
}

const allowed = <T extends Searchable>(t: T, s: SearchIdentity<T>) =>
  !t.ephemeral && !t.parentThreadId && !s.archived?.[t.id] && !s.excluded?.(t.id) && !isMomoChat(s.momoChats, t.id);

/** Recheck a rendered selection against current ownership and an actual current/cached canonical row. */
export function canSelectChatSearch<T extends Searchable>(id: string, s: SearchIdentity<T>, returned: readonly T[]): boolean {
  if (chatSearchOwners(s.segments).has(id)) return false;
  const row = s.knownChats?.[id] ?? returned.find((t) => t.id === id);
  return !!row && allowed(row, s);
}

export interface SearchSources<T extends Searchable> extends SearchIdentity<T> {
  /** chats the window already knows (every harness), matched on their title */
  local: T[];
  /** Codex thread/search and thread/list(searchTerm) hits */
  codex?: T[];
  /** Claude sessions whose title or transcript matches */
  claude?: T[];
  /** basic-tier chats whose title or Sage transcript matches */
  sage?: T[];
  titleOf: (t: T) => string;
  term: string;
  limit: number;
  /** only chats whose title holds the term (the composer's @ list, as Claude Desktop matches sessions), not ones matched inside */
  titleOnly?: boolean;
}

/**
 * Chats that match `term`, each once: title matches first, then matches found inside the chat,
 * newest first within each. Archived chats are left out. With no term, the local order (the
 * sidebar's) is kept.
 */
export function mergeChatSearch<T extends Searchable>(s: SearchSources<T>): T[] {
  const ql = s.term.trim().toLowerCase();
  const owners = chatSearchOwners(s.segments);
  const lists = [s.local, s.codex ?? [], s.claude ?? [], s.sage ?? []];
  const known = new Map(Object.entries(s.knownChats ?? {}));
  // An independently returned canonical row is evidence too; an alias row is never relabeled as its owner.
  for (const list of lists) for (const t of list) if (!owners.has(t.id) && !known.has(t.id)) known.set(t.id, t);
  const seen = new Map<string, { t: T; title: boolean }>();
  const add = (hit: T, local: boolean) => {
    const owner = owners.get(hit.id);
    const t = owner === undefined ? hit : owner === null ? undefined : known.get(owner);
    if (!t || owners.has(t.id) || !allowed(t, s)) return;
    // titleOnly: the chat's own title, not the title of one of its parts' sessions
    const title = !ql || (!s.titleOnly && s.titleOf(hit).toLowerCase().includes(ql)) || s.titleOf(t).toLowerCase().includes(ql);
    if ((local || s.titleOnly) && !title) return;
    const prev = seen.get(t.id);
    if (!prev) seen.set(t.id, { t, title });
    else if (title) prev.title = true;
  };
  for (const t of s.local) add(t, true);
  for (const list of [s.codex, s.claude, s.sage]) for (const t of list ?? []) add(t, false);
  const all = [...seen.values()];
  if (ql) all.sort((a, b) => Number(b.title) - Number(a.title) || byActivity(a.t, b.t));
  return all.map((x) => x.t).slice(0, s.limit);
}

/**
 * Every page of a list that is read in pages (the SDK's session list is capped per call): stops on
 * a short page or at `max` rows, and keeps what was read when a later page fails (`cut.truncated` says so).
 */
export async function readAllPages<R>(
  page: (offset: number, limit: number) => Promise<R[]>,
  size: number,
  max: number,
  cut: { truncated: boolean } = { truncated: false },
): Promise<R[]> {
  const out: R[] = [];
  while (out.length < max) {
    let rows: R[];
    try {
      rows = await page(out.length, Math.min(size, max - out.length));
    } catch (e) {
      if (!out.length) throw e;
      cut.truncated = true;
      break;
    }
    for (const row of rows.slice(0, max - out.length)) out.push(row);
    if (rows.length < size) break;
  }
  return out;
}

/**
 * Archived Claude chat ids the session list did not return (it is paged and capped, and empty while
 * Claude is signed out), so the archive can read each from its own file (D-38).
 */
export function archivedClaudeMissing(
  archived: Record<string, number>,
  known: { has(id: string): boolean },
  isClaude: (id: string) => boolean,
): string[] {
  return Object.keys(archived).filter((id) => isClaude(id) && !known.has(id));
}
