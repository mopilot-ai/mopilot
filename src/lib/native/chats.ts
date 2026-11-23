// window.native.chats's types (the chat store and the data migration), merged into NativeApi; the calls are declared in electron/bridge/chats.cjs.
import type { ChatDeletionReceipt } from '../chatDeletion';
import type { MigrationReport, MigrationStatus } from '../native';
import type { Segment } from '../../../shared/model/harness';
import type { ChatMeta, ChatView, ChatsSnapshot } from '../chatMeta';

declare module '../native' {
  interface NativeApi {
    /** per-chat state in userData/threads/<id>.v2, owned by main (electron/platform/chats.cjs) */
    chats: {
      snapshot(): Promise<ChatsSnapshot>;
      delete(id: string): Promise<ChatDeletionReceipt>;
      deletions(): Promise<ChatDeletionReceipt[]>;
      onDeleted(cb: (receipt: ChatDeletionReceipt) => void): () => void;
      patchMeta(id: string, patch: Partial<ChatMeta>): Promise<boolean>;
      setSegments(id: string, segments: Segment[] | null): Promise<boolean>;
      /** another window changed a chat */
      onChanged(cb: (e: { id: string; chat: ChatView | null }) => void): () => void;
      /** the whole store was reloaded (after a migration retry) */
      onReset(cb: (snap: ChatsSnapshot) => void): () => void;
      migration(): Promise<MigrationStatus[]>;
      retryMigration(): Promise<MigrationStatus[]>;
      /** the last run of the chat-data migration: result, counts, failed chats, backup */
      migrationReport(): Promise<MigrationReport | null>;
      /** put the pre-migration data back from the backup; null when there is none */
      restoreMigration(): Promise<MigrationStatus[] | null>;
    };
  }
}
