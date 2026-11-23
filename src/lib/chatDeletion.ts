// A successful native whole-chat deletion; metadata and aliases are retained, and admission lasts only for this main process.
export interface ChatDeletionReceipt {
  chatId: string;
  nativeKeys: string[];
  /** Main-certified retained aliases discovered after reload; no additional native deletion is implied. */
  retainedAliasKeys?: string[];
  nativeDeleted: true;
  remoteDeletionPending?: boolean;
  /** with `remoteDeletionPending`: the chat's machine answers but its Host is too old to take the deletion, so it waits for an update */
  remoteDeletionOutdated?: boolean;
  metadata: 'retained';
}
