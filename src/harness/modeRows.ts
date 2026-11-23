// A basic harness's modes, split as the composer and a harness page show them (#1875): the agent's own modes its
// quirks name (opencode's build, Cursor's agent, ask and plan) go in a mode menu of their own; every other mode is how
// much it may do, in the permission menu, under the permission row its quirks map it onto, else its own name.
import { isAgentMode, permissionOf, type AcpModeControl } from '../../shared/acpMode.mjs';
import type { PermissionMode } from '../../shared/model/store';
import { PERMISSION_LABEL, PERMISSION_ORDER } from './permissionsMenu';

export interface ModeRow {
  id: string;
  /** the permission row's name when the quirks map the mode onto one, else the harness's own name */
  label: string;
  detail: string | null;
  permission: PermissionMode | null;
}

export interface ModeSplit {
  /** the permission menu's rows in its order; a mode that maps onto no row sits just before Full access */
  permission: ModeRow[];
  /** the agent's own modes, in the order it declares them */
  agent: ModeRow[];
}

/** A harness's own name as a menu shows it: "build" as "Build". */
const shown = (name: string) => name.charAt(0).toUpperCase() + name.slice(1);

export function splitModes(
  control: AcpModeControl,
  permissionModes: Record<string, PermissionMode> = {},
  agentModes: readonly string[] = [],
): ModeSplit {
  const out: ModeSplit = { permission: [], agent: [] };
  for (const m of control.options) {
    const p = permissionOf(permissionModes, m.id) as PermissionMode | null;
    const own: ModeRow = { id: m.id, label: shown(m.name), detail: m.description, permission: null };
    if (isAgentMode(agentModes, m.id)) out.agent.push(own);
    else out.permission.push(p ? { id: m.id, label: PERMISSION_LABEL[p], detail: m.description, permission: p } : own);
  }
  const rank = (r: ModeRow) => (r.permission ? PERMISSION_ORDER.indexOf(r.permission) : PERMISSION_ORDER.length - 1.5);
  out.permission.sort((a, b) => rank(a) - rank(b));
  return out;
}
