// What a person can do by hand for an agent a machine lacks and its Host cannot install (the catalog has no npm line): the vendor's own command to run on the machine, or its install page.
import { ACP_CATALOG } from '../harnessCatalog.mjs';
import { HARNESS_INSTALL, installLines } from '../harnessInstall.mjs';

/**
 * The vendor's command for the machine's system and its docs page; null for an agent the catalog does not offer (unknown, or switched off). `command` is null when the vendor has no command for that system.
 * @param {string} id the agent's id on the machine @param {string} [platform] the machine's system ('darwin' | 'linux'; '' when its Host did not say)
 * @returns {{ command: string | null, docs: string } | null}
 */
export function installHelp(id, platform) {
  const kind = Object.hasOwn(HARNESS_INSTALL, id) ? id : `acp:${id}`;
  const entry = HARNESS_INSTALL[kind];
  if (!entry || ACP_CATALOG[id]?.enabled === false) return null;
  const line = installLines(kind, platform || 'linux', null).find((l) => l.recommended);
  return { command: line ? line.command : null, docs: entry.docs };
}

/** The agents a machine lacks, its Host cannot install (an ACP agent whose catalog entry has no npm line) and the catalog can point to: the "Install an agent…" sheet shows each with its command. @template {{ id: string, state?: string | null }} T @param {{ agents: readonly T[], installable: readonly string[] }} m @returns {T[]} */
export const manualOffers = (m) =>
  m.agents.filter(
    (a) =>
      a.state === 'missing' &&
      !m.installable.includes(a.id) &&
      Object.hasOwn(ACP_CATALOG, a.id) &&
      !HARNESS_INSTALL[`acp:${a.id}`].methods.some((x) => x.via === 'npm') &&
      installHelp(a.id) !== null,
  );
