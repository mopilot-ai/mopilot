// Types of shared/toolRules.mjs.
export type ToolStance = 'allow' | 'ask' | 'block';
export interface ToolRule {
  connector: string;
  pattern: string;
  stance: ToolStance;
  scope: string;
  /** a second condition: the chat's harness (kind or family) */
  harness?: string;
}
export const STANCES: readonly ToolStance[];
export function globMatch(pattern: string, name: string): boolean;
export function exactPattern(name: string): string;
export function scopeRank(scope: string, ctx: { harness: string | null; project: string | null | undefined }): number | undefined;
export function decideStance(o: {
  rules: readonly ToolRule[];
  connector: string;
  tool: string;
  readOnly: boolean;
  harness: string | null;
  project: string | null | undefined;
  fullAccess: boolean;
  unreadable?: boolean;
}): {
  stance: ToolStance;
  rule: ToolRule | null;
  certain: boolean;
  why: 'rule' | 'unreadable' | 'full-access' | 'read-only' | 'default';
};
export function ruleOf(v: unknown): ToolRule | null;
