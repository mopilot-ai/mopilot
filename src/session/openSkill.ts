// Opening a skill from its name: the skill pane, or the SKILL.md itself with the modifier.
import { openPaneTab } from '../store/panes';
import { skillName } from '../lib/skills';
import { modKey } from '../lib/platform';
import { openPath } from './open';

export function openSkill(path: string) {
  openPaneTab('skill', { path, title: skillName(path) });
}

/** A click on a skill's name: the skill pane, or the file itself with the modifier (as a path link opens it). */
export function openSkillClick(path: string, e: Parameters<typeof modKey>[0]) {
  if (modKey(e)) openPath(path);
  else openSkill(path);
}
