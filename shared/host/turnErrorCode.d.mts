// Types for turnErrorCode.mjs: why a turn on a Host failed, as a code a client can act on.
export type TurnErrorCode = 'rate_limit' | 'auth' | 'context' | 'model_unavailable';
export const TURN_ERROR_CODES: readonly TurnErrorCode[];
export function turnErrorCode(signal: unknown, message?: unknown): TurnErrorCode | undefined;
export function typedTurnEnd<T>(event: T): T;
export function codeOfText(text: unknown): TurnErrorCode | undefined;
export function ledAs(text: string, code: TurnErrorCode | undefined): string;
