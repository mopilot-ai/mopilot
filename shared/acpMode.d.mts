/** One of a basic harness's modes, as the composer lists it. */
export interface AcpModeOption {
  id: string;
  name: string;
  description: string | null;
}
/** How a session's mode is read and changed: session/set_mode, or session/set_config_option on `configId`. */
export interface AcpModeControl {
  via: 'mode' | 'config';
  configId: string | null;
  current: string | null;
  options: AcpModeOption[];
}
/** A select option's values, with groups flattened. */
export declare function selectValues(
  o: { options?: unknown } | null | undefined,
): { value: unknown; name: string; description?: string | null }[];
/** How the session's mode is read and changed, or null when it declares none. */
export declare function acpModeControl(acp: { modes?: unknown; configOptions?: unknown } | null | undefined): AcpModeControl | null;
/** The permission row a mode stands for under the quirks' map (own keys only), or null for an agent mode. */
export declare function permissionOf(permissionModes: Record<string, string> | null | undefined, id: string): string | null;
/** Whether a mode is one of the agent's own (its quirks' agentModes). */
export declare function isAgentMode(agentModes: readonly string[] | null | undefined, id: string): boolean;
/** Whether the session declares a mode that isn't one of the agent's own. */
export declare function acpHasPermissionModes(
  acp: { modes?: unknown; configOptions?: unknown } | null | undefined,
  agentModes: readonly string[] | null | undefined,
): boolean;
/** The session's current mode id, from either source; null when it has none. */
export declare function acpCurrentMode(acp: { modes?: unknown; configOptions?: unknown } | null | undefined): string | null;
