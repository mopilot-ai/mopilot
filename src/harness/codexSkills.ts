// Codex's skills by name for the components: skills/list across folders (one entry per SKILL.md, a project's repo entry winning) and the on/off write.
import { codexRequest } from './adapters/codex';
import type { SkillsListResponse } from '../protocol/v2/SkillsListResponse';

type Listed = SkillsListResponse['data'][number]['skills'][number];

const rank = (scope: string) => (scope === 'repo' ? 0 : scope === 'user' ? 1 : 2);

/** The skills for these folders, each with the folder it was listed under; rejects when Codex can't list them. */
export async function listCodexSkills(cwds: string[], forceReload = false): Promise<(Listed & { cwd: string })[]> {
  const r = await codexRequest<SkillsListResponse>('skills/list', {
    cwds,
    forceReload,
  });
  const byPath = new Map<string, Listed & { cwd: string }>();
  for (const d of r.data ?? [])
    for (const k of d.skills ?? []) {
      const prev = byPath.get(k.path);
      if (!prev || rank(k.scope) < rank(prev.scope)) byPath.set(k.path, { ...k, cwd: d.cwd });
    }
  return [...byPath.values()];
}

/** Turns one skill on or off in Codex's config; rejects when Codex can't write it. */
export async function setCodexSkillEnabled(path: string, enabled: boolean): Promise<void> {
  await codexRequest('skills/config/write', { path, enabled });
}
