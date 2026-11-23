// Opening the bug report dialog (src/components/dialogs/Dialogs.tsx) from anywhere, through a window event: no app imports.
import type { BugKind } from './native/app';

export const OPEN_BUG_REPORT = 'open-bug-report';

export interface BugReportRequest {
  /** the chat the report is about, or null (Help menu, Settings) */
  threadId: string | null;
  /** the kind it opens on: a bad response opens on bad_result */
  kind?: BugKind;
}

/** Opens the bug report dialog for a chat, or for none. */
export function openBugReport(threadId: string | null, kind?: BugKind) {
  window.dispatchEvent(new CustomEvent<BugReportRequest>(OPEN_BUG_REPORT, { detail: { threadId, ...(kind ? { kind } : {}) } }));
}
