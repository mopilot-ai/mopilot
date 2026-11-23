// Types for shared/answerOwner.mjs.
export type Answerer = { kind: 'window' | 'device'; has(chatId: string): boolean };
export function windowAnswerer(shown: (chatId: string) => boolean): Answerer;
export function deviceAnswerer(follows: { has(chatId: string): boolean }): Answerer;
export function mayAnswer(answerer: Answerer, chatId: unknown): boolean;
export const REFUSED: { readonly window: string; readonly device: string };
