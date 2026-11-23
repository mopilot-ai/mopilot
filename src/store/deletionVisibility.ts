// Every renderer state write filters terminal chat identities, including aliases, independently of snapshot arrival order.
import type { Searchable, SearchSources } from '../lib/chatSearch';
import type { AppState } from './state';
import type { ChatDeletionReceipt } from '../lib/chatDeletion';

const MAPS = [
  'threads',
  'pinned',
  'unread',
  'worktreeOf',
  'chatProject',
  'claudeArchived',
  'claudeChats',
  'chatNotes',
  'chatConfig',
  'chatInitialTitles',
  'navigationBookmarks',
  'segments',
] as const;

export class DeletionVisibility {
  private readonly deleted = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private revision = 0;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  snapshot = () => this.revision;
  visible<T extends Searchable>(rows: T[]) {
    return rows.filter((row) => !this.has(row.id));
  }
  sources<T extends Searchable, S extends Partial<Pick<SearchSources<T>, 'local' | 'codex' | 'claude' | 'sage'>>>(sources: S) {
    return Object.fromEntries(Object.entries(sources).map(([key, rows]) => [key, this.visible(rows)])) as typeof sources;
  }
  has(id: string) {
    return this.deleted.has(id);
  }
  accept(value: unknown): string[] {
    const r = value as ChatDeletionReceipt | null;
    if (
      !r ||
      r.nativeDeleted !== true ||
      r.metadata !== 'retained' ||
      typeof r.chatId !== 'string' ||
      !r.chatId ||
      !Array.isArray(r.nativeKeys) ||
      !r.nativeKeys.includes(r.chatId) ||
      r.nativeKeys.some((id) => typeof id !== 'string' || !id) ||
      (r.retainedAliasKeys !== undefined &&
        (!Array.isArray(r.retainedAliasKeys) || r.retainedAliasKeys.some((id) => typeof id !== 'string' || !id)))
    )
      return [];
    return this.add([...r.nativeKeys, ...(r.retainedAliasKeys ?? [])]);
  }
  private add(keys: string[]) {
    const added = keys.filter((id) => !this.deleted.has(id));
    for (const id of added) this.deleted.add(id);
    if (added.length) {
      this.revision++;
      for (const listener of this.listeners) listener();
    }
    return added;
  }
  /** Whether `map` has a deleted key: no key list is built, and the walk stops at the first. */
  private holdsDeleted(map: object) {
    for (const id in map) if (this.has(id)) return true;
    return false;
  }
  filter<T extends Partial<AppState>>(patch: T): T {
    if (!this.deleted.size) return patch;
    let out = patch;
    const put = (key: keyof AppState, value: unknown) => {
      if (out === patch) out = { ...patch };
      Object.assign(out, { [key]: value });
    };
    for (const key of MAPS) {
      const map = patch[key];
      if (map && this.holdsDeleted(map)) put(key, Object.fromEntries(Object.entries(map).filter(([id]) => !this.has(id))));
    }
    if (patch.threadOrder?.some((id) => this.has(id)))
      put(
        'threadOrder',
        patch.threadOrder.filter((id) => !this.has(id)),
      );
    if (patch.archived?.some((t) => this.has(t.id)))
      put(
        'archived',
        patch.archived.filter((t) => !this.has(t.id)),
      );
    return out;
  }
}
export const deletionVisibility = new DeletionVisibility();
