// Every skill the user has, merged from each harness's own source into one list, and the one short line a row says about where it is missing or off.
import type { ReachFamily } from '../../../shared/plugins/reach.mjs';
import type { InstalledPlugin } from '../../lib/native/plugins';
import { titleOfName } from '../plugins/pluginView';
import { FAMILIES, FAMILY_LABEL } from '../plugins/ReachStrip';

/** A skill as Codex's skills/list reports it. */
export interface CodexSkill {
  name: string;
  description: string;
  path: string;
  enabled: boolean;
  scope?: string;
  interface?: { displayName?: string; shortDescription?: string } | null;
}

/** One harness family's copy of a skill: on or off, and the SKILL.md it is read from when known. */
export interface SkillCopy {
  on: boolean;
  file?: string;
}

export interface SkillRow {
  /** the skill's name, lowercase; the same skill from two sources shares it */
  key: string;
  title: string;
  description: string;
  copies: Partial<Record<ReachFamily, SkillCopy>>;
  /** Codex's own switch: set when Codex lists the skill */
  codex?: CodexSkill;
  /** the store plugin that brings it */
  plugin?: string;
}

/** What each source gave; a source that couldn't be read is left out (its error is said on the page). */
export interface SkillSources {
  codex: CodexSkill[];
  claude: string[];
  plugins: InstalledPlugin[];
}

/** A skill's display title: its own, else its name in title case ("frontend-design" → "Frontend Design"). */
export const skillTitle = (name: string, display?: string | null) => display || titleOfName(name.split(':').at(-1)!);

/** The merged list, by title. A store plugin's skill reaches every family its plugin is on for; a harness's own source says what it has. */
export function mergeSkills({ codex, claude, plugins }: SkillSources): SkillRow[] {
  const rows = new Map<string, SkillRow>();
  const row = (name: string, description = '', display?: string | null) => {
    const key = name.toLowerCase();
    let r = rows.get(key);
    if (!r)
      rows.set(
        key,
        (r = {
          key,
          title: skillTitle(name, display),
          description,
          copies: {},
        }),
      );
    else {
      if (!r.description) r.description = description;
      // a source's own display name beats the title made from the skill's name
      if (display) r.title = display;
    }
    return r;
  };
  for (const p of plugins) {
    if (!p.spec) continue;
    for (const s of p.spec.skills) {
      const r = row(`${p.spec.name}:${s.name}`, s.description);
      r.plugin = p.id;
      for (const f of FAMILIES)
        r.copies[f] = {
          on: p.enabled && p.harnesses[f] !== false,
          file: s.file,
        };
    }
  }
  for (const k of codex) {
    const r = row(k.name, k.interface?.shortDescription ?? k.description, k.interface?.displayName);
    r.codex = k;
    r.copies.codex = { on: k.enabled, file: k.path };
  }
  for (const name of claude)
    row(name).copies.claude = {
      ...rows.get(name.toLowerCase())?.copies.claude,
      on: true,
    };
  return [...rows.values()].sort((a, b) => a.title.localeCompare(b.title));
}

/** The one line a row says: only what differs from "on everywhere", else null. */
export function skillException(r: SkillRow): string | null {
  const names = (pick: (c?: SkillCopy) => boolean) => FAMILIES.filter((f) => pick(r.copies[f])).map((f) => FAMILY_LABEL[f]);
  const on = names((c) => !!c?.on);
  const off = names((c) => !!c && !c.on);
  const gone = names((c) => !c);
  if (!on.length) return 'Off';
  const parts = [off.length && `Off on ${off.join(', ')}`, gone.length && `Only on ${on.join(', ')}`];
  return parts.filter(Boolean).join(' · ') || null;
}
