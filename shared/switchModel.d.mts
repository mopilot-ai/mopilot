// Types for a switch's model selection at the shared main/renderer boundary.
export function configuredSwitchModel(
  kind: string,
  requested: unknown,
  prefs?: { model?: unknown; claudeSelection?: { model?: unknown } | null } | null,
): string | null;
