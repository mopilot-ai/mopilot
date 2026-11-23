// The user-level instruction file each harness reads (Settings edits it). File names come from the
// registry: first tier sits in its config folder ($CODEX_HOME, the Claude CLI's folder); a basic
// harness's comes from its quirks (mirrored in the registry's instructionsFiles), when it names one.
import type { HarnessKind } from './adapter';
import { harnessInfo } from './registry';

export interface InstructionRoots {
  home: string;
  codexHome: string;
  claudeRoot: string;
}

const userLevel = (f: string) => f.startsWith('~/') || f.startsWith('/');

/** The absolute path of a harness's user-level instruction file, or null when it has none. */
export function instructionsPath(
  kind: HarnessKind,
  roots: InstructionRoots,
  files: string[] = harnessInfo(kind)?.instructionsFiles ?? [],
): string | null {
  if (kind === 'codex') return `${roots.codexHome}/${files[0] ?? 'AGENTS.md'}`;
  if (kind === 'claude') return `${roots.claudeRoot}/${files[0] ?? 'CLAUDE.md'}`;
  const user = files.find(userLevel);
  if (!user) return null;
  return user.startsWith('~/') ? `${roots.home}/${user.slice(2)}` : user;
}
