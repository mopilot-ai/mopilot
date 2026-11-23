// Turns a plugin agent (agents/<name>.md) into the text of a skill, the one conversion every family shares: Codex's
// marketplace copy writes it as skills/<skillName>/SKILL.md, the basic tier reads it over plugin_skill_read.
import { frontMatter } from './manifest.mjs';

/** The skill name for an agent: nested "folder:file" names lose the colon, which skill names don't take. */
export const agentSkillName = (name) => `agent-${String(name).replace(/[^\w.-]+/g, '-')}`;

const FRONT = /^﻿?---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)(?:\r?\n|$)/;

/**
 * SKILL.md text for an agent: its description (or a generic one), then its instructions behind a line saying they
 * run in this conversation, since no subagent exists here. Front matter such as tools and model is dropped.
 */
export function agentSkillText(name, markdown) {
  const text = String(markdown);
  const fm = frontMatter(text);
  const description = (fm.description || `Instructions of the ${name} agent`).replace(/\s+/g, ' ').trim();
  const body = text.replace(FRONT, '').trim();
  const intro = `This is the ${name} agent of a plugin. It runs as a skill here: follow these instructions yourself in this conversation, no separate subagent exists.`;
  return `---\nname: ${agentSkillName(name)}\ndescription: ${JSON.stringify(`Agent: ${description}`)}\n---\n\n${intro}\n\n${body}\n`;
}

/**
 * Whether a skill or command of the plugin already has the name an agent's skill would get. Codex's skills share one
 * namespace per plugin, so such an agent is left out (the plugin's own wins) and the Plugins page says so.
 */
export const agentNameTaken = (spec, agentName) =>
  [...(spec.skills ?? []), ...(spec.commands ?? [])].some((c) => c.name === agentSkillName(agentName));
