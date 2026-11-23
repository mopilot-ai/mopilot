// The controls of a chat only a machine holds, built from the Host itself (#4859): the agents the machine runs with their state, the agent the chat is on or moves to with its next message, and the permission modes Claude Code and Codex take. The shape is the Mac's `options.get` for a machine chat, so the phone's own model and agent sheets read it unchanged.
import type { MachineAgent } from './machines';
import type { MachineModel } from '../../../shared/host/models.mjs';

/** The name a chat moves between agents by on the wire: the two built-in agents by their id, any other as an ACP agent. */
export const wireOf = (id: string) => (id === 'claude' || id === 'codex' ? id : `acp:${id}`);

/** The permission modes the Host sets for Claude Code and Codex; an ACP agent's modes are its own and are not offered. `read-only` is a sandbox and approval mode, not Plan (Codex asks no question cards in it), so it is not called Plan: a real Plan row waits for the Host to report one per agent. */
const PERMISSIONS = [
  { id: 'read-only', label: 'Read-only', detail: 'Look at files, change nothing' },
  { id: 'default', label: 'Manual', detail: 'Ask before edits and commands' },
  { id: 'auto-review', label: 'Auto', detail: 'Decide on its own, with a review' },
];

/** One of an agent's models as an `options.get` model entry: named by the model it resolves to (never an alias), with its levels and default level, and whether it has a fast mode. */
export function hostModelOption(m: MachineModel) {
  return {
    id: m.id,
    label: m.resolvedModel ?? m.name,
    ...(m.resolvedModel && { resolvedModel: m.resolvedModel }),
    ...(m.description && { description: m.description }),
    efforts: m.efforts.map((e) => ({ id: e, label: e })),
    defaultEffort: m.defaultEffort,
    ...(m.default && { default: true }),
    ...(m.supportsFastMode !== undefined && { fast: { supported: m.supportsFastMode } }),
  };
}

/** What a chat only the machine holds says of itself: `current` is the agent it runs on (wire name), `pending` the one it moves to with its next message, `permission` the mode this phone last set. */
export function hostControls(o: {
  machineName: string;
  agents: MachineAgent[] | null;
  current: string | undefined;
  pending: string | undefined;
  permission: string | undefined;
}) {
  // each agent carries its models in the options' own shape; the top-level `models` the phone's sheets read stays empty until the phone sets and reads back a chat's model (#4885)
  const agents = (o.agents ?? []).map((a) => ({
    id: wireOf(a.id),
    label: a.label,
    state: a.state,
    reason: a.reason ?? '',
    ...(a.models?.length && { models: a.models.map(hostModelOption) }),
  }));
  const on = o.pending ?? o.current;
  const label = agents.find((a) => a.id === on)?.label ?? on;
  const builtIn = o.current === 'claude' || o.current === 'codex';
  return {
    ...(on ? { harnessId: on, harness: label } : {}),
    ...(o.current ? { current: o.current } : {}),
    switching: !!o.pending && o.pending !== o.current,
    machine: { name: o.machineName, agents },
    models: [],
    permission: { value: o.permission ?? null, rows: builtIn ? PERMISSIONS : [] },
  };
}
