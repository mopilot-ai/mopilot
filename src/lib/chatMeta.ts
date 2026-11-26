// The store's per-chat maps (pinned, unread, worktreeOf, claudeArchived, claudeChats, chatNotes, segments) and
// prefs, as main keeps them: one v2 record per chat (electron/platform/chats.cjs) and prefs merged
// per key. A window sends only what changed, so two windows never overwrite each other (#39).
import { recordValue, setRecordValue } from '../../shared/recordProperties.mjs';
import { isJsonRecord } from '../../shared/jsonRecord.mjs';
import { isMomoMeta, momoModelOf } from '../../shared/momoChat.mjs';
import type { Segment } from '../../shared/model/harness';
import type { AuthoredInput } from './authoredInput';

export interface ChatMeta {
  /** A linked session's initial task title, written by main before announcement; native titles take precedence. */
  initialTitle?: string | null;
  rewoundAt?: number | null;
  archived: number | null;
  pinned: boolean;
  unread: boolean;
  projectId: string | null;
  worktreeOf: string | null;
  account: ChatAccountRecord | null;
  config: unknown;
  goalHeld: unknown;
  notes: unknown[];
  /** Stable user-message navigation IDs, independent of whole-chat pins. */
  navigationBookmarks?: string[];
  /** the chat this one was forked from (src/session/harness/forkSwitched.ts) */
  forkOf?: string | null;
  /** apps this chat may control (Allow in this chat): electron/capabilities/grants.cjs */
  computerGrants: { bundleId: string; name: string; level: string; at: number }[];
  /** who controls each surface on the chat's current segment: electron/session/controllerPlan.cjs */
  controllerPlan?: { key: string | null; iab: string | null; cu: string | null; bu: string | null } | null;
  /** when the chat was last restored from the archive: automatic archiving counts it as use (main sets it) */
  activeAt?: number | null;
  /** MoMo's own chat ('main' or 'previous'): main sets it, and no list of chats shows it (shared/momoChat.mjs) */
  momo?: string | null;
  /** the Claude Code model a MoMo chat's brain names: main sets it, and every Claude turn of the chat runs on it (#2304) */
  momoModel?: string | null;
  /** how each input main sent that no human wrote is shown, by its client id (electron/session/authoredInput.cjs) */
  authored?: Record<string, AuthoredInput> | null;
}
export interface ChatView {
  /** set only when the chat spans several native sessions */
  segments: Segment[] | null;
  /** the kind of the chat's first segment, the native session its own id names ('codex', 'claude', 'acp:<harness>') */
  kind?: string;
  meta: ChatMeta;
}
export interface ChatsSnapshot {
  chats: Record<string, ChatView>;
  /** chats written by a newer version: shown read-only */
  newer: string[];
}

export interface ChatMaps {
  /** Initial task titles from main, never sent back by a window. */
  chatInitialTitles?: Record<string, string>;
  chatRewoundAt?: Record<string, number>;
  pinned: Record<string, boolean>;
  unread: Record<string, boolean>;
  worktreeOf: Record<string, string>;
  /** chat id -> the saved project it was started in (meta.projectId): the link that survives a cwd no root matches */
  chatProject: Record<string, string>;
  claudeArchived: Record<string, number>;
  claudeChats: Record<string, ChatAccountRecord>;
  chatNotes: Record<string, ChatNote[]>;
  chatConfig: Record<string, ChatConfig>;
  navigationBookmarks?: Record<string, string[]>;
  chatForkOf?: Record<string, string>;
  /** MoMo's chats (meta.momo, lib/momoChats.ts): main writes it, so it is never sent back as a change */
  momoChats?: Record<string, string>;
  /** the Claude Code model each MoMo chat's brain names (meta.momoModel): main writes it, never sent back */
  momoModels?: Record<string, string>;
  /** inputs no human wrote (meta.authored, lib/authoredInput.ts): main writes it, so it is never sent back as a change */
  authoredInputs?: Record<string, Record<string, AuthoredInput>>;
  segments: Record<string, Segment[]>;
}
const MAP_KEYS = [
  'pinned',
  'unread',
  'worktreeOf',
  'chatProject',
  'claudeArchived',
  'claudeChats',
  'chatNotes',
  'chatConfig',
  'navigationBookmarks',
  'chatForkOf',
] as const;
/** store map -> meta key */
const META_OF = {
  pinned: 'pinned',
  unread: 'unread',
  worktreeOf: 'worktreeOf',
  chatProject: 'projectId',
  claudeArchived: 'archived',
  claudeChats: 'account',
  chatNotes: 'notes',
  chatConfig: 'config',
  navigationBookmarks: 'navigationBookmarks',
  chatForkOf: 'forkOf',
} as const;

const empty = (): ChatMaps => ({
  chatInitialTitles: {},
  chatRewoundAt: {},
  pinned: {},
  unread: {},
  worktreeOf: {},
  chatProject: {},
  claudeArchived: {},
  claudeChats: {},
  chatNotes: {},
  chatConfig: {},
  navigationBookmarks: {},
  chatForkOf: {},
  momoChats: {},
  momoModels: {},
  authoredInputs: {},
  segments: {},
});

/** Put one chat's view into the maps (a copy of each map it touches). */
export function applyChat(maps: ChatMaps, id: string, chat: ChatView | null): ChatMaps {
  return updateChatMaps(maps, id, chat, true);
}

/** Snapshot construction owns fresh maps; incremental updates must copy the maps they touch. */
function updateChatMaps(maps: ChatMaps, id: string, chat: ChatView | null, copy: boolean): ChatMaps {
  const out = copy ? { ...maps } : maps;
  const put = <K extends keyof ChatMaps>(k: K, v: unknown) => {
    const map = (maps[k] ?? {}) as Record<string, unknown>;
    const cur = recordValue(map, id);
    if (v === null || v === undefined || v === false) {
      if (!Object.hasOwn(map, id)) return;
      const { [id]: _drop, ...rest } = map;
      out[k] = rest as ChatMaps[K];
    } else if (cur !== v && JSON.stringify(cur) !== JSON.stringify(v)) {
      if (copy) out[k] = { ...(maps[k] as object), [id]: v } as ChatMaps[K];
      // Chat ids are opaque: even __proto__ must be an ordinary own property.
      else setRecordValue(map, id, v);
    }
  };
  const m = chat?.meta;
  put('chatInitialTitles', typeof m?.initialTitle === 'string' ? m.initialTitle.trim() || null : null);
  put('chatRewoundAt', typeof m?.rewoundAt === 'number' && Number.isFinite(m.rewoundAt) && m.rewoundAt > 0 ? m.rewoundAt : null);
  put('pinned', m?.pinned);
  put('unread', m?.unread);
  put('worktreeOf', m?.worktreeOf);
  put('chatProject', m?.projectId);
  put('claudeArchived', typeof m?.archived === 'number' ? m.archived : null);
  put('claudeChats', m?.account);
  put('chatNotes', Array.isArray(m?.notes) && m.notes.length ? m.notes : null);
  put('chatConfig', m?.config && typeof m.config === 'object' ? m.config : null);
  put('navigationBookmarks', Array.isArray(m?.navigationBookmarks) && m.navigationBookmarks.length ? m.navigationBookmarks : null);
  put('chatForkOf', typeof m?.forkOf === 'string' ? m.forkOf : null);
  put('momoChats', isMomoMeta(m) ? m!.momo : null);
  put('momoModels', momoModelOf(m));
  put('authoredInputs', m?.authored && typeof m.authored === 'object' && Object.keys(m.authored).length ? m.authored : null);
  put('segments', chat?.segments);
  return out;
}

// where saved notes go back among the turns: shared with Chrome's side panel (shared/chatNotes.mjs)
export { sameTurn, withChatNotes } from '../../shared/chatNotes.mjs';
import type { ChatAccountRecord, ChatConfig, ChatNote } from '../../shared/model/window';
export type { ChatAccountRecord, ChatConfig, ChatNote } from '../../shared/model/window';

export function mapsFromSnapshot(snap: ChatsSnapshot | null | undefined): ChatMaps {
  const maps = empty();
  // These maps are private until return: do not copy every growing map for each chat.
  for (const [id, chat] of Object.entries(snap?.chats ?? {})) updateChatMaps(maps, id, chat, false);
  return maps;
}

/**
 * What changed between two states of the maps, per chat: meta patches (only the keys that
 * changed) and segment lists (null: back to a single segment).
 */
export function chatChanges(prev: ChatMaps, next: ChatMaps) {
  const meta: Record<string, Partial<ChatMeta>> = {};
  const segments: Record<string, Segment[] | null> = {};
  for (const k of MAP_KEYS) {
    if (prev[k] === next[k]) continue;
    const a = (prev[k] ?? {}) as Record<string, unknown>;
    const b = (next[k] ?? {}) as Record<string, unknown>;
    for (const id of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const before = recordValue(a, id);
      const v = recordValue(b, id);
      if (before === v) continue;
      // main writes a chat's config and notes too: the window sends only what it changed, merged there onto main's (#2520)
      const [key, val] =
        k === 'chatConfig'
          ? ['configKeys', configDelta(before, v)]
          : k === 'chatNotes'
            ? ['notesAdded', notesAdded(before, v)]
            : [META_OF[k], k === 'pinned' || k === 'unread' ? !!v : k === 'navigationBookmarks' ? (v ?? []) : (v ?? null)];
      if (val === undefined || ((k === 'pinned' || k === 'unread') && !!before === val)) continue;
      let patch = recordValue(meta, id);
      if (!patch) {
        patch = {};
        setRecordValue(meta, id, patch);
      }
      (patch as Record<string, unknown>)[key] = val;
    }
  }
  if (prev.segments !== next.segments)
    for (const id of new Set([...Object.keys(prev.segments), ...Object.keys(next.segments)])) {
      const value = recordValue(next.segments, id);
      if (recordValue(prev.segments, id) !== value) setRecordValue(segments, id, value ?? null);
    }
  return { meta, segments };
}

/** A chat config's keys the window changed (`set`) or removed (`unset`); undefined when none did. */
function configDelta(before: unknown, after: unknown) {
  const d = prefsDelta(isJsonRecord(before) ? before : {}, isJsonRecord(after) ? after : {});
  return d.empty ? undefined : { set: d.set, unset: d.unset };
}

/** The notes the window added to a chat (by id); undefined when it added none. */
function notesAdded(before: unknown, after: unknown) {
  const had = new Set((Array.isArray(before) ? (before as ChatNote[]) : []).map((n) => n?.id));
  const added = (Array.isArray(after) ? (after as ChatNote[]) : []).filter((n) => !had.has(n?.id));
  return added.length ? added : undefined;
}

/** The prefs keys that changed: `set` for new or different values, `unset` for removed keys. */
export function prefsDelta(prevPrefs: object, nextPrefs: object) {
  const prev = prevPrefs as Record<string, unknown>;
  const next = nextPrefs as Record<string, unknown>;
  const set: Record<string, unknown> = {};
  const unset: string[] = [];
  for (const k of Object.keys(next)) {
    const before = recordValue(prev, k);
    if (before !== next[k] && JSON.stringify(before) !== JSON.stringify(next[k])) setRecordValue(set, k, next[k]);
  }
  for (const k of Object.keys(prev)) if (!Object.hasOwn(next, k)) unset.push(k);
  return { set, unset, empty: Object.keys(set).length === 0 && unset.length === 0 };
}

/** Another window's prefs delta applied to ours. */
export function applyPrefsDelta<T extends object>(
  prefs: T,
  d: { set?: Record<string, unknown>; unset?: string[]; binding?: { id: string; key?: string | null } },
): T {
  const out: Record<string, unknown> = { ...prefs, ...(d.set ?? {}) };
  for (const k of d.unset ?? []) delete out[k];
  if (d.binding) {
    const bindings = { ...(out.keybindings as Record<string, string | null>) };
    if (d.binding.key === undefined) delete bindings[d.binding.id];
    else Object.defineProperty(bindings, d.binding.id, { value: d.binding.key, enumerable: true, configurable: true, writable: true });
    out.keybindings = bindings;
  }
  return out as T;
}
