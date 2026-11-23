import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import type { SkillMetadata } from '../src/protocol/v2/SkillMetadata.ts';

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === './adapters/codexApi' && context.parentURL?.endsWith('/codexCatalog.ts'))
      return { url: 'data:text/javascript,export const codexApi = {};', shortCircuit: true };
    try {
      return next(specifier, context);
    } catch (error) {
      if (specifier.startsWith('.') && !/\.[a-z]+$/.test(specifier)) return next(specifier + '.ts', context);
      throw error;
    }
  },
});
const { composerCodexSkills } = await import('../src/harness/codexCatalog.ts');
const skill = (path: string, scope: SkillMetadata['scope'] = 'repo', name = 'mopilot-update'): SkillMetadata => ({
  name,
  path,
  scope,
  enabled: true,
  description: 'Update',
  pluginId: null,
});
const select = (skills: SkillMetadata[], cwd = '/repo/app') => composerCodexSkills({ data: [{ cwd, skills, errors: [] }] }, cwd);

test('repeated project copies collapse into one effective invocation', () => {
  const project = skill('/repo/.codex/skills/mopilot-update/SKILL.md');
  assert.deepEqual(select([project, project, project]), [project]);
});

test('the nearest project copy overrides parent and personal copies in either order', () => {
  const parent = skill('/repo/.codex/skills/mopilot-update/SKILL.md');
  const nearby = skill('/repo/app/.codex/skills/mopilot-update/SKILL.md');
  const personal = skill('/Users/dev/.codex/skills/mopilot-update/SKILL.md', 'user');
  for (const skills of [
    [personal, nearby, parent],
    [parent, nearby, personal],
  ])
    assert.deepEqual(select(skills), [nearby]);
});

test('disabled copies are ignored without hiding other skill names', () => {
  const disabled = { ...skill('/repo/.codex/skills/mopilot-update/SKILL.md'), enabled: false };
  const personal = skill('/Users/dev/.codex/skills/mopilot-update/SKILL.md', 'user');
  const other = skill('/repo/.codex/skills/review/SKILL.md', 'repo', 'review');
  assert.deepEqual(select([disabled, personal, other]), [personal, other]);
});

test('skills discovered for another workspace do not leak into the active menu', () => {
  const own = skill('/repo/app/.codex/skills/mopilot-update/SKILL.md');
  const unrelated = skill('/other/.codex/skills/review/SKILL.md', 'repo', 'review');
  assert.deepEqual(
    composerCodexSkills(
      {
        data: [
          { cwd: '/other', skills: [unrelated], errors: [] },
          { cwd: '/repo/app', skills: [own], errors: [] },
        ],
      },
      '/repo/app',
    ),
    [own],
  );
});
