export type EntrySource = { kind: 'path'; path: string } | { kind: 'git'; url: string; ref?: string; sha?: string; path?: string };
export type MarketplaceEntry = {
  name: string;
  description?: string;
  category?: string;
  version?: string;
  author?: string;
  source: EntrySource;
};
export type Marketplace = { name: string; description?: string; plugins: MarketplaceEntry[]; problems: string[] };
export type MarketplaceSource = { kind: 'local'; path: string } | { kind: 'git'; url: string; ref?: string };

export const MARKETPLACE_FILES: string[];
export function isFetchableUrl(url: unknown): url is string;
export function entrySource(source: unknown): EntrySource | null;
export function readMarketplace(text: string): { ok: true; marketplace: Marketplace } | { ok: false; error: string };
export function parseMarketplaceSource(input: unknown, home: string, platform?: string): MarketplaceSource | null;
