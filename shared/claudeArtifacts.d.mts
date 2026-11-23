/** Claude Code's built-in tools that work with claude.ai artifacts and Claude Design projects. */
export declare const DESIGN_TOOLS: Set<string>;
export type ClaudeUrlKind = 'artifact' | 'design';
export interface ClaudeUrl {
  kind: ClaudeUrlKind;
  id: string;
  /** the link without its query or fragment: one page, however it was linked */
  canonical: string;
}
/** What a link is, when it is a claude.ai artifact or design page; null for anything else. */
export declare function classifyClaudeUrl(url: unknown): ClaudeUrl | null;
/** The first claude.ai artifact or design link in a text; null when none. */
export declare function findClaudeUrl(text: unknown): (ClaudeUrl & { url: string }) | null;
