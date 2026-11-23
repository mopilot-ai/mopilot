// Types for installHelp.mjs: the by-hand install help for an agent a machine's Host cannot install.
export function installHelp(id: string, platform?: string): { command: string | null; docs: string } | null;
export function manualOffers<T extends { id: string; state?: string | null }>(m: {
  agents: readonly T[];
  installable: readonly string[];
}): T[];
