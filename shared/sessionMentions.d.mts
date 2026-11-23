export type SessionMention = { token: string; title: string; id: string; start: number; end: number };
export function sessionToken(id: string, title: string): string;
export function sessionMentions(text: string): SessionMention[];
