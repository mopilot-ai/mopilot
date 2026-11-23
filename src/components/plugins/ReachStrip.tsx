// What of a plugin reaches each harness family: the full line per family (its detail page and the review), and the
// one short exception a card shows, nothing when every harness gets all of it.
import { pluginReach, REACH_NOTE, REACH_WHY, type ReachFamily } from '../../../shared/plugins/reach.mjs';
import type { PluginSpec } from '../../../shared/plugins/manifest.mjs';
import type { CodexMirrorState, InstalledPlugin } from '../../lib/native/plugins';
import { HARNESS_LABEL } from '../../harness/types';

export const FAMILIES: ReachFamily[] = ['codex', 'claude', 'acp'];
export const FAMILY_LABEL: Record<ReachFamily, string> = { codex: HARNESS_LABEL.codex, claude: HARNESS_LABEL.claude, acp: 'Other agents' };

/** How a family's own install went, where MoPilot installs into the harness (the Codex mirror). */
export type Installs = Partial<Record<ReachFamily, CodexMirrorState>>;

/** One family's line: a short state and, for partial reach, what doesn't arrive and why. */
export function reachLine(spec: PluginSpec, family: ReachFamily, o: { off?: boolean; install?: CodexMirrorState } = {}) {
  if (o.off) return { state: 'off', text: 'Off' };
  if (o.install?.state === 'failed') return { state: 'failed', text: `Couldn't install: ${o.install.error ?? 'unknown error'}` };
  if (o.install?.state === 'alreadyOn') return { state: 'full', text: 'Uses its own copy' };
  // which MCP transports a basic-tier harness takes differs per harness: remote servers are said to depend on it
  const r = pluginReach(spec, family, { stdio: true, http: true });
  const remoteVaries = pluginReach(spec, family, { stdio: true, http: false }).summary !== r.summary;
  const asSkills = [...new Set(r.components.map((c) => REACH_NOTE[c.note as string]).filter(Boolean))].map((n) => ` ${n}`).join('');
  const note = `${asSkills}${remoteVaries ? ' Remote MCP depends on the harness.' : ''}`;
  if (r.summary === 'full') return { state: 'full', text: `Everything.${note}` };
  const missing = r.components.filter((c) => c.reach === 'unavailable');
  const whys = [...new Set(missing.map((c) => REACH_WHY[c.why as string]))].join(' ');
  // why a family's source is withheld is for the user; what a plan merely ignored is on the review's list
  const plan = spec.execution?.plans[family];
  const withheld = plan?.state === 'withheld' ? ` ${plan.reasons.join(' ')}` : '';
  return {
    state: r.summary,
    text: `${r.summary === 'none' ? 'Nothing runs' : `Not ${missing.map((c) => c.name).join(', ')}`}. ${whys}${note}${withheld}`,
  };
}

/** The card's one line: only what differs from "all of it everywhere", worst first; null when nothing does. */
export function reachException(plugin: InstalledPlugin & { spec: PluginSpec }, installs: Installs = {}) {
  if (!plugin.enabled) return null;
  const parts = FAMILIES.map((f) => ({
    f,
    state: reachLine(plugin.spec, f, { off: plugin.harnesses[f] === false, install: installs[f] }).state,
  }));
  const names = (state: string) =>
    parts
      .filter((p) => p.state === state)
      .map((p) => FAMILY_LABEL[p.f])
      .join(', ');
  const failed = names('failed');
  const text = [
    failed && `Couldn't install on ${failed}`,
    names('none') && `Doesn't run on ${names('none')}`,
    names('partial') && `Partly on ${names('partial')}`,
    names('off') && `Off on ${names('off')}`,
  ]
    .filter(Boolean)
    .join(' · ');
  return text ? { text, failed: !!failed } : null;
}
