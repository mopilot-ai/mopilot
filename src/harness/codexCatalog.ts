// What the composer asks the Codex app-server for: its plugin marketplaces, its
// skills for a folder. Components call these, not the app-server by method name
// (tests/boundary.test.ts); the Codex-only pages (components/harness/codex/*) call it directly.
import { codexApi } from './adapters/codexApi';
import type { SkillsListResponse } from '../protocol/v2/SkillsListResponse';
import type { SkillMetadata } from '../protocol/v2/SkillMetadata';
import { isUnder, samePath } from '../lib/paths';

export const listCodexPlugins = () => codexApi.pluginList();
export const listCodexSkills = (cwd: string, forceReload = false) => codexApi.skillList(cwd, forceReload);

/** The slash menu invokes by name: show one effective skill per name, rather than every discovered copy. */
export function composerCodexSkills(result: SkillsListResponse, cwd: string): SkillMetadata[] {
  const matching = result.data.filter((entry) => samePath(entry.cwd, cwd));
  const entries = matching.length ? matching : result.data;
  const byName = new Map<string, SkillMetadata>();
  const scopeRank = { repo: 0, user: 1, system: 2, admin: 3 };
  const projectRoot = (skill: SkillMetadata) => {
    const root = skill.path.replace(/[\\/]\.(?:codex|agents|claude)[\\/]skills[\\/].*$/, '');
    return root !== skill.path && isUnder(cwd, root) ? root.length : 0;
  };
  for (const entry of entries)
    for (const skill of entry.skills) {
      if (skill.enabled === false) continue;
      const previous = byName.get(skill.name);
      // Project overrides personal/system copies; the nearest project root wins among project copies.
      if (
        !previous ||
        scopeRank[skill.scope] < scopeRank[previous.scope] ||
        (skill.scope === previous.scope && projectRoot(skill) > projectRoot(previous))
      )
        byName.set(skill.name, skill);
    }
  return [...byName.values()];
}
