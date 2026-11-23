// Types for shared/remote/schema.mjs.
export const MAX_TEXT: number;
export const UPDATE_EXTENSION: string;
export const MAX_RECENT: number;
export const MAX_CHAT_TITLE: number;
export const MAX_CHUNK: number;
export const MAX_CHUNKS: number;
export const MAX_FILE_BYTES: number;
export const MAX_AUDIO_BYTES: number;
export const MAX_FOLLOW_ITEMS: number;
export const DEFAULT_FOLLOW_ITEMS: number;
export const MAX_HISTORY_PAGE: number;
export const DEFAULT_HISTORY_PAGE: number;
export class SchemaError extends Error {
  code: 'invalid';
}
export function audioOf(v: unknown): Buffer;
export function tabLine(tab: unknown): string | null;
export function chatOf(p: unknown): string;
export function targetOf(p: unknown): { chatId: string } | { harness: string };
export function optionOf(v: unknown): string;
export function maybeOption(v: unknown): string | null;
export function attachmentsOf(v: unknown): string[];
export function skillsOf(v: unknown): string[];
export function pickOf(p: unknown): { model: string | null; effort: string | null; attachments: string[]; skills: string[] };
export function projectOf(p: unknown): string | null;
export function composed(p: unknown): string;
export const MAX_PTY_WRITE: number;
export function ptyStreamOf(p: unknown): string;
export const PARSERS: Record<string, (p: Record<string, unknown>) => unknown>;
export function knownMethod(m: unknown): boolean;
export function parseParams(method: string, params: unknown): unknown;
