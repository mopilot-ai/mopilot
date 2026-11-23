// Types for the built-in browser's page notices (browserNotice.mjs).
export interface PageNotice {
  kind: string;
  reason?: string | null;
  /** the raw error behind a failure's words (ERR_…), for the notice's tooltip */
  detail?: string | null;
}
export type NoticeAction =
  | 'retry'
  | 'reload'
  | 'stop'
  | 'chrome'
  | 'openBrowser'
  | 'openApp'
  | 'dismiss'
  | 'wait'
  | 'restart'
  | 'closeTab'
  | 'closeWindow'
  | 'resubmit'
  | 'back';
export const NOTICE_ACTIONS: Record<NoticeAction, string>;
export const CRASHED_MESSAGE: string;
export const UNRESPONSIVE_MESSAGE: string;
export function schemeOf(url: string): string;
export function blockedAddress(url: string): { reason: 'app-link' | 'address'; scheme: string; message: string };
export function isCertificateError(code: number | null, description?: string): boolean;
export function loadFailure(
  code: number,
  description?: string,
): { reason: 'certificate' | 'resubmit' | 'load'; message: string; detail: string };
export function loadFailureNote(description: string): string;
export function isResubmitFailure(description: string): boolean;
export function formReloadNote(tabId: string): string;
export function openFailureNote(url: string, errorText: string): string;
export function blockedAddressNote(tabId: string, url: string): string;
export function unresponsiveNote(tabId: string): string;
export const PANE_NOTICE_KINDS: readonly string[];
export const DISMISSABLE: string[];
export function noticeCloseAction(notice: PageNotice): 'dismiss' | 'wait' | 'hide';
export function noticeActions(
  notice: PageNotice,
  ctx?: { loading?: boolean; back?: boolean; chat?: boolean; url?: string; popup?: boolean },
): NoticeAction[];
