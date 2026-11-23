// What the running Codex's version and probes allow (WP5-20, A24). A version above min that isn't
// known bad works as usual, tested or not; a capability whose probe failed (its method isn't there) or
// whose feature is off is greyed out on its own, with the reason. Below min or known bad, Codex is
// incompatible and says so.
import { ownTable } from '../../shared/ownTable.mjs';
import type { CodexNegotiated } from '../lib/native';
import type { Semantic, Why } from './adapter';
import { flagGate, whyText } from './caps';

/** semantic -> the probes it needs (electron/harness/versions.cjs CODEX_PROBES) */
export const CODEX_PROBES_FOR: Partial<Record<Semantic, string[]>> = ownTable({
  goal: ['codex.goals'],
  plan: ['codex.collaborationModes'],
  tasks: ['codex.backgroundTerminals'],
  review: ['codex.review'],
  compact: ['codex.compact'],
  // thread-level providers (the gateway's models) and the per-thread plugins switch that turns cua_repl off
  model: ['codex.threadProvider'],
  computerUse: ['codex.pluginsOff'],
});

export const codexIncompatible = (n: CodexNegotiated | null | undefined) =>
  n?.versionStatus === 'tooOld' || n?.versionStatus === 'knownBad';

/** "Codex 0.150.0 doesn't work with this version of MoPilot. Update it." (too old or known bad: an update fixes both) */
export const incompatibleText = (n: CodexNegotiated) =>
  whyText({ layer: 'version', code: 'version.incompatible', fix: 'upgrade' }, { label: 'Codex', version: n.cliVersion ?? '' });

/** Why this semantic can't be used on the running Codex, or null. Probes that didn't run block nothing. */
export function codexWhy(n: CodexNegotiated | null | undefined, s: Semantic): Why | null {
  if (!n) return null;
  if ((CODEX_PROBES_FOR[s] ?? []).some((p) => n.probes?.[p] === false))
    return { layer: 'version', code: 'version.probeFailed', fix: 'upgrade' };
  return flagGate(n.flags)[s] ?? null;
}

export function codexBlocked(n: CodexNegotiated | null | undefined, s: Semantic): string | null {
  const why = codexWhy(n, s);
  return why ? whyText(why, { label: 'Codex', version: n?.cliVersion ?? '', semantic: s }) : null;
}
