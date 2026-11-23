// Types for shared/remote/momoSchema.mjs.
/** Additive hello capability; absence means automatic MoMo retry/restored replay is unsafe. */
export type MomoSendDedupCapability = { momoSendDedup?: 1 };
/** Automatic replay must pin expectedChatId from the main-chat follow snapshot. Legacy manual calls may omit it. */
export type MomoSendParams = { id: string; text: string; followUp?: 'queue' | 'steer'; expectedChatId?: string };
export function momoParsers(h: {
  bad: (message: string) => Error;
  queryOf: (p: unknown) => string;
  MAX_TEXT: number;
  MAX_FOLLOW_ITEMS: number;
  DEFAULT_FOLLOW_ITEMS: number;
}): Record<string, (p: Record<string, unknown>) => unknown>;
