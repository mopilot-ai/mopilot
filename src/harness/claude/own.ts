// What a window tells main about a Claude chat's own pick (main runs its turns with it, electron/harness/claude/adapter.cjs setOwn).
import type { ClaudeOwn } from '../../../shared/model/native';
export type { ClaudeOwn } from '../../../shared/model/native';

type OwnState = {
  runtime: Record<string, { settings?: { model?: string | null; effort?: string | null } } | undefined>;
  claudeChats: Record<string, { id?: string | null } | undefined>;
  claude: { models: { id: string }[] };
  momoModels?: Record<string, string>;
  segments?: Record<string, unknown>;
  chatConfig?: Record<string, { model?: string | null; effort?: string | null } | undefined>;
};

/** An absent runtime model is still unread; a saved model, including an explicit clear, fills it. */
export function knownClaudeSettings(
  runtime: { model?: string | null; effort?: string | null } | null | undefined,
  saved: { model?: string | null; effort?: string | null } | null | undefined,
) {
  if (saved?.model === null) return { ...runtime, ...saved };
  return runtime?.model === undefined ? saved : runtime;
}

type Own = { model?: string | null; effort?: string | null } | null | undefined;

/**
 * A Claude chat's own model or effort where it has one: a key that is there, even null (the model's default), wins over
 * the new-chat default, which another chat's pick moves (as a Codex chat's, codexSettings.ts).
 */
export const ownSetting = <T>(own: Own, k: 'model' | 'effort', fallback: T): string | null | T =>
  own && k in own ? (own[k] ?? null) : fallback;

/**
 * The chat's own model and effort (from its session, or chosen in it) and the login it runs on. Until this window knows the
 * chat's model (its settings unread, the model list not in yet: a reload), only the login: main keeps the model it has
 * rather than take a null that puts the chat back on the default model and switches its live session there (#2304).
 */
export function claudeOwnOf(s: OwnState, id: string): ClaudeOwn {
  const ts = knownClaudeSettings(s.runtime[id]?.settings, s.chatConfig?.[id]);
  const account = s.claudeChats[id]?.id ?? null;
  // a MoMo chat's is its brain's (main runs it whatever this says): its effort goes with that model
  const picked = s.momoModels?.[id] ?? ts?.model;
  if (picked === undefined || !s.claude.models.length) return { account };
  const model = picked && s.claude.models.some((m) => m.id === picked) ? picked : null;
  return { model, effort: ts?.model === model ? (ts?.effort ?? null) : null, account };
}

/** Whether what claudeOwnOf reads changed between two states. */
export const ownInputsChanged = (s: OwnState, prev: OwnState) =>
  s.runtime !== prev.runtime ||
  s.chatConfig !== prev.chatConfig ||
  s.claudeChats !== prev.claudeChats ||
  s.momoModels !== prev.momoModels ||
  s.segments !== prev.segments ||
  s.claude.models !== prev.claude.models;
