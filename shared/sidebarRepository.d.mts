// Repository identities accepted by project sidebar matching.
export function sidebarRepository(remote: unknown): string | null;
export function cloudRepository(name: unknown): string | null;
export function readSidebarOrigin(
  run: (args: string[]) => Promise<{ ok: boolean; stdout: string; stderr: string }>,
): Promise<string | null | undefined>;
export function environmentRepository(env: { repo?: unknown; repositories?: unknown }): string | null;
