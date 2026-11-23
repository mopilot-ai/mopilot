/** The hash (without '#') that opens a window on this chat. */
export function threadHash(id: string): string;

/** The URL scheme the app answers to (the macOS Quick Actions open `mopilot://chat/new?...`). */
export const APP_SCHEME: string;
/** The most text one link may carry into a draft, and the most files it may name. */
export const LINK_TEXT_MAX: number;
export const LINK_FILES_MAX: number;
/** What a `mopilot://chat/new` link asks for, or null when it is no such link. */
export function parseNewChatLink(url: unknown): { text: string; folder: string | null; files: string[] } | null;
