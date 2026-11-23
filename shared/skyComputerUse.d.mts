export const SKY_ERROR_CODES: Readonly<Record<string, number>>;
export const PRIVACY_PANES: Readonly<{ accessibility: string; screenRecording: string }>;

export type SkyProblemKind =
  | 'permissions'
  | 'permissionsPending'
  | 'appBlocked'
  | 'appRefused'
  | 'notApproved'
  | 'blockedUrl'
  | 'serviceMissing'
  | 'serviceUnavailable'
  | 'versionMismatch'
  | 'screenLocked'
  | 'userStopped'
  | 'turnEnded'
  | 'disabled'
  | 'siteBlocked'
  | 'browserPolicy'
  | 'browserDeclined'
  | 'browserCheckUnavailable'
  | 'codexAppBrowser'
  | 'chromeExtensionMissing'
  | 'chromePromptTimedOut'
  | 'chromePromptUnavailable'
  | 'chromeDisconnected'
  | 'chromeConnectionLost'
  | 'chromeNoResponse'
  | 'cleanupBlocked'
  | 'requestStopped'
  | 'stopped'
  | 'unknown'
  | 'vendorApp';

export type SkyProblemAction =
  | { kind: 'url'; label: string; url: string }
  | { kind: 'settings'; label: string; section: string }
  | { kind: 'retry'; label: string }
  | { kind: 'send'; label: string; text: string }
  | { kind: 'restartCodex'; label: string };

export interface SkyProblem {
  kind: SkyProblemKind;
  /** Sky's numeric error code, when the text carries it or names a known error */
  code: number | null;
  /** the vendor's error name (Sky's permissionsNotGranted, the Browser plugin's site_status_blocked, …), when known */
  name: string | null;
  /** the vendor's own message, verbatim, except that a request to open a vendor desktop app reads as MoPilot's advice */
  message: string;
  /** MoPilot's fallback copy */
  title: string;
  hint: string | null;
  actions: SkyProblemAction[];
}

export function skyProblem(text: unknown, o?: { failed?: boolean }): SkyProblem | null;
export function skyProblemText(p: SkyProblem): string;
export function vendorAppProblem(text: unknown): SkyProblem | null;
export function hostProblem(kind: 'cleanupBlocked' | 'requestStopped', message: string): SkyProblem;
export function vendorProblem(text: unknown, o: { sources: readonly string[]; failed?: boolean; read?: boolean }): SkyProblem | null;
export const PROBLEM_KINDS: Readonly<Record<SkyProblemKind, { title: string; hint: string | null; actions: SkyProblemAction[] }>>;
export function skyProblemOfItem(item: unknown): SkyProblem | null;
export function skyStepWorked(item: unknown): boolean;
export function plistVersion(xml: unknown): string | null;
export function compareVersions(a: unknown, b: unknown): -1 | 0 | 1 | null;
/** Version folder names newest first by numeric comparison; names that are not a dotted version are left out. */
export function versionsNewestFirst(names: string[]): string[];
