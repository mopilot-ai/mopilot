// Types for shared/chatFamilies.mjs.
export function chatFamilies(
  listed: readonly string[],
  parentOf: (id: string) => string | null | undefined,
): { roots: string[]; descendants: Map<string, string[]> };
