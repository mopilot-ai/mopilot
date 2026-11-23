// The browser pane's page-notice actions that put a notice away: Dismiss at once, and "Open in your browser" once the
// page has opened there (CM-M18). Each puts away only the notices still showing that were up at the click.
import { native, type BrowserPageEvent } from '../../../lib/native';
import { noteIgnored } from '../../../lib/ignored';
import { toast, toastFailure } from '../../../store/core';

/** The notices showing: the pane's own (what it couldn't do) and main's of the tab's page. */
export interface ShownNotices {
  pageError: unknown;
  rootNotice: BrowserPageEvent | undefined;
}

/** Puts away the notices that were up at `clicked` and still are: the pane's own, and main's of the same page. */
function putAway(clicked: ShownNotices, now: ShownNotices, clearPaneError: () => void) {
  if (clicked.pageError && now.pageError === clicked.pageError) clearPaneError();
  // main's notice of the same page goes too, or it would show the same words in the pane's place
  if (clicked.rootNotice && now.rootNotice === clicked.rootNotice)
    native.browser.dismissNotice(clicked.rootNotice.pageId).catch((e) => noteIgnored('put away a browser page notice', e));
}

/**
 * Dismiss, and "Open in your browser": the site opens in the user's browser, then the notice goes and says so; a
 * browser that does not open keeps it and is a toast. A notice that came after the click (the page moved on while the
 * browser opened) is left alone.
 * @param shown the notices showing now (a ref the pane updates every render)
 */
export function noticeClose(shown: { current: ShownNotices }, clearPaneError: () => void, pageUrl: string | undefined) {
  return {
    dismiss: () => putAway(shown.current, shown.current, clearPaneError),
    openBrowser: () => {
      const clicked = shown.current;
      native.shell.openExternal(String(pageUrl)).then(() => {
        putAway(clicked, shown.current, clearPaneError);
        toast('Opened this page in your browser', 'info');
      }, toastFailure("Couldn't open the link"));
    },
  };
}
