// What a task's session is held to, by the kind of agent that runs it: the typed permission anchors of Claude Code and Codex (shared/host/permissions.mjs), and nothing a basic agent's own mode names could promise. A task nobody asked for is held read-only or does not run; a task the user asked for starts in "Ask for approval" so it never inherits a looser mode of the machine; an agent that can be held to neither does not run a task.
import { agentLabel } from '../../../shared/host/agentReadiness.mjs';
import { hostPermissionFamily } from '../../../shared/host/permissions.mjs';

/**
 * @param {string} agent the agent's id: `claude`, `codex` or a basic agent's id
 * @param {{ readOnly: boolean }} o
 * @returns {{ mode: 'read-only' | 'default' } | { unsupported: string }} `mode` is what to set before the first message; `unsupported` says why this agent cannot run the task
 */
export function holdFor(agent, { readOnly }) {
  if (hostPermissionFamily(agent)) return { mode: readOnly ? 'read-only' : 'default' };
  // a basic agent's modes are its own: none is known to mean read-only, so it is never pretended to be
  if (readOnly)
    return { unsupported: `${agentLabel(agent)} can't be held read-only on this machine, so a task nobody asked for does not run on it.` };
  // nor is one's own mode known to ask first: a task the user asked for would run however that agent happens to be set
  return { unsupported: `${agentLabel(agent)} can't be limited to asking first. Pick Claude Code or Codex.` };
}
