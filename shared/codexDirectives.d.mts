// Types for shared/codexDirectives.mjs: inline Codex directives in answers.
export type Directive = { name: string; label: string; attrs: Record<string, string> };
export const SCHEME: string;
export function parseDirectives(md: string, streaming?: boolean): { markdown: string; followups: Directive[] };
export function directiveFromHref(href: string | undefined): Directive | null;
export function stripDirectives(md: string, plain?: boolean, options?: { reply?: boolean; streaming?: boolean }): string;
