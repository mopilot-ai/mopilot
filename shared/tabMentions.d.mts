/** Where a referenced tab lives: the chat's in-app browser, or the user's Chrome. */
export type TabWhere = 'app' | 'chrome';
/** How a harness adapter serializes tab references (shared/tabMentions.mjs). */
export type TabMentionStyle = 'codex-browser-plugin' | 'text';
export type TabRef = { where: TabWhere; title: string; url: string; tabId?: string | null; browserId?: string | null };
export type TabMention = {
  token: string;
  title: string;
  where: TabWhere;
  url: string;
  tabId: string | null;
  browserId: string | null;
  native: boolean;
  start: number;
  end: number;
};
export function tabToken(tab: TabRef): string;
export function tabMentions(text: string): TabMention[];
export function withTabMentions(prompt: string, style: TabMentionStyle): string;
