// Renderer selections sent to main inherit a saved linked chat's config; a retired send failure cannot erase its newer ownership receipt.
import type { AppState } from '../../../shared/model/window';
import { claudeOwnOf } from './own';
import type { ClaudeOwn } from '../../../shared/model/native';

type OwnInputs = Pick<AppState, 'runtime' | 'chatConfig' | 'claudeChats' | 'claude'> & Pick<Partial<AppState>, 'momoModels' | 'segments'>;

/** Adds the ids whose entry in `a` is not the entry in `b` (by reference); a whole new map counts every id it has. */
function addChanged(ids: Set<string>, a: Record<string, unknown> | undefined, b: Record<string, unknown> | undefined) {
  if (a === b) return;
  for (const id in a) if (a[id] !== b?.[id]) ids.add(id);
  for (const id in b) if (!(a && id in a)) ids.add(id);
}

/** The ids whose own pick could differ between two states, or null when every chat's could. */
function changedIds(s: OwnInputs, prev: OwnInputs): Set<string> | null {
  // the model list decides every chat's model
  if (s.claude.models !== prev.claude.models) return null;
  const ids = new Set<string>();
  if (s.runtime !== prev.runtime) {
    // a streamed delta rewrites the entry but not its settings, the only part of it a pick reads
    for (const id in s.runtime) if (s.runtime[id]?.settings !== prev.runtime[id]?.settings) ids.add(id);
    for (const id in prev.runtime) if (!(id in s.runtime)) ids.add(id);
  }
  addChanged(ids, s.chatConfig, prev.chatConfig);
  addChanged(ids, s.claudeChats, prev.claudeChats);
  addChanged(ids, s.momoModels, prev.momoModels);
  // a harness switch rewrites the chat's segments: familyOf reads them, so a chat that just became Claude's is looked at
  addChanged(ids, s.segments, prev.segments);
  return ids;
}

export function createOwnSettingsSync({
  familyOf,
  send,
}: {
  familyOf(id: string): string;
  send(id: string, own: ClaudeOwn): Promise<unknown>;
}) {
  const sent = new Map<string, string>();
  const one = (s: OwnInputs, id: string) => {
    if (familyOf(id) !== 'claude') return;
    const own = claudeOwnOf(s, id);
    const key = JSON.stringify(own);
    if (sent.get(id) === key) return;
    sent.set(id, key);
    send(id, own).catch(() => {
      if (sent.get(id) === key) sent.delete(id);
    });
  };
  /** With `prev` (the state before this write) only the chats whose inputs changed are looked at; without it, all of them. */
  return (s: OwnInputs, prev?: OwnInputs) => {
    const ids =
      (prev && changedIds(s, prev)) ??
      new Set([...Object.keys(s.runtime), ...Object.keys(s.chatConfig), ...Object.keys(s.claudeChats), ...Object.keys(s.momoModels ?? {})]);
    for (const id of ids) one(s, id);
  };
}
