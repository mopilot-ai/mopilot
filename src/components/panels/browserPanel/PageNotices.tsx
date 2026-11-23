// The browser pane's page notices: a failed, blocked, crashed, slow or hung page with only the actions that can work for it (shared/browserNotice.mjs), and a page's own alert, confirm or prompt for the user to answer; each closes (PaneNotice).
import { useState } from 'react';
import { NOTICE_ACTIONS, noticeActions, noticeCloseAction, type NoticeAction, type PageNotice } from '../../../../shared/browserNotice.mjs';
import type { BrowserPageDialog, BrowserPageEvent } from '../../../lib/native';
import { PaneNotice } from './PaneNotice';

/** The pane's own notice about what it couldn't do: why ('certificate', 'input', a load failure) and the raw error. */
export interface PaneError {
  message: string;
  reason: string;
  detail?: string;
}

/** The notice the pane shows: its own about what it couldn't do, else main's about the page, else none. */
export function shownNotice(pageError: PaneError | null, rootNotice: BrowserPageEvent | undefined | null) {
  if (pageError) return { kind: 'failed', ...pageError, pageId: null };
  if (!rootNotice) return null;
  const { kind, reason, message, detail, pageId } = rootNotice;
  return { kind, reason, message, detail, pageId };
}

/**
 * A page notice and its actions. `handlers` has one for every action a notice can offer, so the pane can never show a
 * button with nothing behind it; noticeActions decides which of them can work here.
 */
export function PageNoticeBar({
  notice,
  loading,
  back = false,
  chat,
  url,
  popup = false,
  handlers,
}: {
  notice: PageNotice & { message: string };
  loading: boolean;
  /** the page has an earlier page to go back to */
  back?: boolean;
  chat: boolean;
  popup?: boolean;
  url?: string;
  handlers: Record<NoticeAction, () => void>;
}) {
  const { message } = notice;
  const actions = noticeActions(notice, { loading, back, chat, url, popup });
  const close = noticeCloseAction(notice);
  return (
    // a crashed or slow page's close hides its notice as Wait does: main keeps it until it says it again
    <PaneNotice
      role="alert"
      onClose={handlers[close === 'hide' ? 'wait' : close]}
      closeLabel={close === 'hide' ? 'Close' : NOTICE_ACTIONS[close]}
    >
      {/* the raw error stays in the tooltip, as Chrome's error page keeps it below its words */}
      <span title={notice.detail ?? undefined}>{message}</span>
      {actions.length > 0 && (
        <div className="browser-notice-actions">
          {actions.map((action) => (
            <button key={action} onClick={handlers[action]}>
              {NOTICE_ACTIONS[action]}
            </button>
          ))}
        </div>
      )}
    </PaneNotice>
  );
}

/** The page's own dialog, as the browser would show it: OK (with a prompt's answer) and, but for an alert, Cancel. */
export function PageDialogBar({
  dialog,
  origin,
  onAnswer,
}: {
  dialog: BrowserPageDialog;
  origin: string;
  onAnswer: (accept: boolean, text: string | null) => void;
}) {
  const [text, setText] = useState(dialog.defaultPrompt);
  const host = (o: string) => o.replace(/^https?:\/\//, '');
  // an embedded page's dialog says so, as Chrome does
  const from = dialog.frame
    ? `An embedded page at ${host(dialog.frame)} says`
    : origin && origin !== 'null'
      ? `${host(origin)} says`
      : 'This page says';
  return (
    // closing it is the browser's Esc: Cancel, or OK for an alert (which has nothing to cancel)
    <PaneNotice
      className="browser-dialog"
      role="alertdialog"
      label={from}
      closeLabel={dialog.type === 'alert' ? 'OK' : 'Cancel'}
      onClose={() => onAnswer(dialog.type === 'alert', null)}
    >
      <span>
        <strong>{from}</strong> {dialog.message}
      </span>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onAnswer(true, dialog.type === 'prompt' ? text : null);
        }}
      >
        {dialog.type === 'prompt' && (
          <input value={text} aria-label="Your answer to the page" onChange={(e) => setText(e.target.value)} spellCheck={false} />
        )}
        <div className="browser-notice-actions">
          <button type="submit">OK</button>
          {dialog.type !== 'alert' && (
            <button type="button" onClick={() => onAnswer(false, null)}>
              Cancel
            </button>
          )}
        </div>
      </form>
    </PaneNotice>
  );
}
