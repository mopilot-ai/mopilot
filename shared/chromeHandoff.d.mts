// Types for the sign-in hand-off to the user's Chrome (chromeHandoff.mjs).
export type HandoffRoute =
  | 'your-chrome'
  | 'claude-in-chrome'
  | 'codex-browser-plugin'
  | 'codex-extension'
  | 'extension'
  | 'relay'
  | 'setup'
  | 'setup-extension'
  | 'none';
export type ChromePanelTarget = { tabId: number; hostId: string; membership: string };
export type HandoffPrecondition = { url: string; token: string };
export type HandoffContinuation = { message: string; precondition: HandoffPrecondition };
export const ROUTE_LABEL: Record<HandoffRoute, string>;
export const NO_CHROME: string;
export const CHROME_SETUP: string;
export const EXTENSION_SETUP: string;
export const HANDOFF_TAG: string;
export function needsSetup(route: HandoffRoute): boolean;
export function setupReason(route: HandoffRoute): string;
export const PREFERRED_WILL_CHANGE: string;
export const PREFERRED_CHANGED: string;
export const MOVED_PREFIX: string;
export function handoffRoute(o: {
  vendor: 'claude-in-chrome' | 'codex-browser-plugin' | null;
  relay: 'extension' | 'relay' | null;
  yourChrome: boolean;
  onChrome: boolean;
  codexExtension?: boolean;
}): HandoffRoute;
export function opensInUserChrome(route: HandoffRoute): boolean;
export function movedNote(route: HandoffRoute, url: string): string;
export function continueMessage(route: HandoffRoute, url: string, chromeToolName?: string, o?: { signedIn?: boolean }): string;
/** Hidden trusted routing context followed by the user's visible message. */
export function browserHandoffMessage(note: string, shown: string): string;
