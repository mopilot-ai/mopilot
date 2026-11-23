// Types for the independent usage-limit preferences shared by main and the renderer.
export interface LimitPreferences {
  autoContinueOnLimit?: unknown;
  autoSwitchHarnessOnLimit?: unknown;
}
export function resumeAfterQuotaReset(prefs: LimitPreferences | null | undefined): boolean;
export function switchHarnessAtLimit(prefs: LimitPreferences | null | undefined): boolean;
