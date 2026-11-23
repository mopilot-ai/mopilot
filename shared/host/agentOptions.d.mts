// Types for the agent model options a Host reports (shared/host/agentOptions.mjs).
export const RESOLVED_MAX: number;
export const RESOLVED_ID_MAX: number;
export function defaultEffort(efforts: unknown, preferred?: unknown): string | null;
export function claudeResolvedName(m: { value?: unknown; description?: unknown; resolvedId?: unknown }): string | null;
export function optionFields(
  m: {
    id: string;
    resolvedModel?: unknown;
    resolvedId?: unknown;
    defaultEffort?: unknown;
    supportsFastMode?: unknown;
    supportsAutoMode?: unknown;
  },
  efforts: string[],
): { resolvedModel?: string; resolvedId?: string; defaultEffort?: string; supportsFastMode?: boolean; supportsAutoMode?: boolean };
