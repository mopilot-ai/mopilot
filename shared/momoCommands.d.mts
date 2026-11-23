// Types for what a MoMo chat's composer may run (shared/momoCommands.mjs).
export const MOMO_MENU: readonly string[];
export const MOMO_COMMANDS: readonly string[];
export function momoShowsEntry(id: string): boolean;
export function momoRunsCommand(names: readonly string[]): boolean;
export function momoTypedAsText(text: string): boolean;
export function momoSessionPatch<T extends Record<string, unknown>>(partial: T): Partial<T>;
export function momoMenu<T extends { id: string }>(momo: boolean, items: T[]): T[];
export function momoNames(momo: boolean, names: string[]): string[];
export const LITERAL_MARK: '​';
export function momoLiteralText<T>(text: T): T;
