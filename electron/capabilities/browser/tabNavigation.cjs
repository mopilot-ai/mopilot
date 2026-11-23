// Translate top-level CDP navigation into the page state and events read by browser hosts.
const top = (tab, frameId) => tab.mainFrame == null || frameId === tab.mainFrame;

/** Returns whether the caller should refresh page metadata after the observed event. */
function observeTabNavigation(tab, method, p) {
  switch (method) {
    case 'Page.frameNavigated':
      if (p.frame && !p.frame.parentId) {
        tab.mainFrame = p.frame.id ?? tab.mainFrame;
        tab.url = p.frame.url ?? tab.url;
        tab.emit('did-navigate');
        // A browser error page: the load failed, as a pane page's did-fail-load says (code unknown, its error by name)
        if (p.frame.unreachableUrl) tab.emit('did-fail-load', {}, 0, tab.pageError || 'ERR_FAILED', p.frame.unreachableUrl, true);
        return true;
      }
      break;
    case 'Network.requestWillBeSent':
      // the page's own document request (an embedded page's document is not it)
      if (p.type === 'Document' && top(tab, p.frameId)) tab.pageRequest = p.requestId;
      break;
    case 'Network.loadingFailed':
      // the page's own document failed (net::ERR_…): the error page that follows names it
      if (p.requestId === tab.pageRequest && !p.canceled) tab.pageError = p.errorText;
      break;
    case 'Page.navigatedWithinDocument':
      if (top(tab, p.frameId)) {
        tab.url = p.url ?? tab.url;
        tab.emit('did-navigate-in-page');
        return true;
      }
      break;
    case 'Page.frameStartedLoading':
      if (top(tab, p.frameId) && !tab.loading) {
        tab.loading = true;
        tab.pageError = null;
        tab.emit('did-start-loading');
      }
      break;
    case 'Page.frameStoppedLoading':
      if (top(tab, p.frameId) && tab.loading) {
        tab.loading = false;
        tab.emit('did-stop-loading');
        return true;
      }
      break;
    default:
  }
  return false;
}

module.exports = { observeTabNavigation };
