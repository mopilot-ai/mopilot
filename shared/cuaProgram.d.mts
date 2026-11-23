export type CuaBinding = { surface: 'desktop' | 'browser'; app: string | null };
export function maskCua(src: string): { code: string; strings: Map<number, string> };
export const CUA_BROWSER_METHODS: RegExp;
export function cuaAppQueries(source: unknown): string[];
export function cuaAssignments(
  source: unknown,
): { name: string; kind: 'app' | 'browser' | 'alias' | 'other'; app?: string | null; from?: string }[];
export function learnCuaBindings(source: unknown, into: Map<string, CuaBinding>, appName?: (app: string) => string): void;
export function cuaProgramUse(source: unknown, bound?: Map<string, CuaBinding>): { desktop: boolean; app: string | null };
export class CuaKernels {
  use(threadId: string, source: unknown): { desktop: boolean; app: string | null; acts: boolean };
  reset(threadId: string): void;
  clear(): void;
}
