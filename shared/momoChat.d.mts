// Types for MoMo's chat predicate (shared/momoChat.mjs).
export const MOMO_META_KEY: 'momo';
export function isMomoMeta(meta: unknown): meta is { momo: string } & Record<string, unknown>;
export const MOMO_DATA_TAGS: readonly string[];
export function isMomoDataMeta(meta: unknown): boolean;
export const MOMO_MODEL_KEY: 'momoModel';
export function momoModelOf(meta: unknown): string | null;
export const MOMO_EFFORT_KEY: 'momoEffort';
export function momoEffortOf(meta: unknown): string | null;
export function shareableChatsIn(holder: {
  chats?: { records: { get(id: string): { meta?: unknown } | undefined } } | null;
}): (id: string) => boolean;
export const CHANNEL_ID: RegExp;
export function channelTag(id: string): string;
export function momoChannelIdOf(meta: unknown): string | null;
export function isMomoConversationMeta(meta: unknown): boolean;
