// Types for shared/startRef.mjs.
export function linearRef(text: unknown): { key: string } | null;
export function startRef(
  text: unknown,
): { number: number; repo: string | null; kind: 'pull' | 'issue' | null } | { kind: 'linear'; key: string } | null;
