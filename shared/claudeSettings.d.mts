export interface LiveSettings {
  model: string | null;
  effort: string | null;
  permission: string;
  fast: boolean;
  account: string;
}
export function claudePermissionFor(permission: string, model: { autoMode?: boolean } | undefined): string;
export function liveControls(cur: LiveSettings | undefined, want: LiveSettings): [string, unknown][] | null;
