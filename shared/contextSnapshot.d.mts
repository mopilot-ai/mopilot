export type TokenBreakdown = {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
};
export type CategoryKind = 'used' | 'free' | 'buffer' | 'deferred';
export type CategoryTone = 'instructions' | 'tools' | 'memory' | 'skills' | 'conversation' | 'other';
export type NamedTokens = { name: string; tokens: number };
export type ContextCategory = {
  id: string;
  label: string;
  tokens: number;
  kind: CategoryKind;
  estimated?: true;
  /** its color and place in the palette, for content */
  tone?: CategoryTone;
  /** the names it was reported as, when it groups or renames them */
  parts?: NamedTokens[];
};
export type ContextLists = {
  memoryFiles: { path: string; tokens: number }[];
  mcpTools: { server: string; name: string; tokens: number; deferred?: true }[];
  agents: NamedTokens[];
  skills: NamedTokens[];
};
export type ContextDetails = {
  systemPrompt: NamedTokens[];
  systemTools: NamedTokens[];
  messages: NamedTokens[];
  toolCalls: { name: string; callTokens: number; resultTokens: number }[];
};
/** A chat owner's context snapshot (electron/context): measured counts, categories (Claude Code's own or estimated), lists and freshness. */
export type ContextSnapshot = {
  owner: string;
  at: number;
  model: string | null;
  used: number | null;
  window: number | null;
  quality: 'breakdown' | 'tokens';
  categories: ContextCategory[];
  breakdownAt: number | null;
  breakdownUsed: number | null;
  lists: ContextLists | null;
  details: ContextDetails | null;
  autoCompact: { enabled: boolean; threshold: number | null } | null;
  lastRequest: TokenBreakdown | null;
  session: TokenBreakdown | null;
  cost: { amount: number; currency: string } | null;
  baseline: number | null;
  stale: null | 'compacted' | 'refresh-failed';
};
export type TokenReport = {
  at: number;
  used?: number | null;
  window?: number | null;
  lastRequest?: TokenBreakdown | null;
  session?: TokenBreakdown | null;
  model?: string | null;
};
export const TOKEN_FIELDS: readonly (keyof TokenBreakdown)[];
export const TONES: readonly CategoryTone[];
export function plainCategories(categories: ContextCategory[]): ContextCategory[];
export function count(v: unknown): number | null;
export function tokenBreakdown(v: unknown): TokenBreakdown | null;
export function emptySnapshot(owner: string, at: number): ContextSnapshot;
export function baselineOf(firstInput: unknown, firstMessageChars: unknown): number | null;
export function estimatedCategories(used: number | null, window: number | null, baseline: number | null): ContextCategory[];
export function withTokens(prev: ContextSnapshot, report: TokenReport): ContextSnapshot;
export function fromTokenUsage(usage: unknown): {
  used: number | null;
  window: number | null;
  lastRequest: TokenBreakdown | null;
  session: TokenBreakdown | null;
};
export function fromAcpUsage(u: unknown): TokenBreakdown | null;
export function addBreakdowns(a: TokenBreakdown | null | undefined, b: TokenBreakdown | null | undefined): TokenBreakdown | null;
export function costOf(v: unknown): { amount: number; currency: string } | null;
export function withClaudeBreakdown(prev: ContextSnapshot, reply: unknown, at: number): ContextSnapshot | null;
export function sinceBreakdown(s: ContextSnapshot | null | undefined): number;
