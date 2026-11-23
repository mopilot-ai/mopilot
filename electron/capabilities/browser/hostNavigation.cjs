// Shared browser navigation and load waits: explicit user Stop, normal load failures, history and retry.
const { HostInput } = require('./hostInput.cjs');
const { ToolError } = require('../contract/registry.cjs');
const { noteIgnored, messageOf } = require('../../ignored.cjs');
const { withLoadInterruption } = require('./loadInterruption.cjs');
const { loadFailureNote, isResubmitFailure, formReloadNote, openFailureNote } = require('../../../shared/browserNotice.mjs');
const { sleep, LOAD_MS, waitEvent, oneLine, assertActionLive } = require('./hostUtil.cjs');
const { settlePage, NAV_GRACE_MS } = require('./pageSettle.cjs');
const { whenBlocked } = require('./hostInput.cjs');
const { span } = require('../contract/callPhases.cjs');
const { becameDownload, DOWNLOAD_NOTE } = require('./downloadNavigations.cjs');
const { documentStatus, blockNote, SitePacing } = require('./siteBlock.cjs');

/** @typedef {InstanceType<typeof import('./host.cjs').BrowserTabs>} BrowserTabs */
/** The pace per site of each BrowserTabs (one per app): the site sees one browser, whichever chat asks. */
const pacings = new WeakMap();
const pacingOf = (tabs) => pacings.get(tabs) ?? pacings.set(tabs, new SitePacing()).get(tabs);

class HostNavigation extends HostInput {
  /**
   * After an action: until the page settled (pageSettle.cjs). `grace`: how long a navigation the action scheduled may
   * take to start (an input that may navigate leaves the default; a navigation that already loaded leaves none).
   * @this {BrowserTabs}
   */
  async settle(tab, { grace = NAV_GRACE_MS } = {}) {
    return span('settle', () =>
      settlePage(
        {
          wc: tab.backend,
          ended: () => !!tab.dialog || tab.rendererGone(),
          net: () => ({ inflight: tab.inflight.size, quietMs: Date.now() - tab.lastNet }),
          dom: () => tab.agent('state'),
        },
        { grace },
      ),
    );
  }

  /** @this {BrowserTabs} */
  async navigate(tab, url) {
    return withLoadInterruption(tab.backend, async (wait) => {
      const preview = this.o.prepare?.(tab.chatId, url);
      if (preview) {
        url = await wait(preview);
        assertActionLive();
        tab.check();
      }
      // a person's pace per site, and a block left alone for a while (siteBlock.cjs)
      const pacing = pacingOf(this);
      await wait(pacing.before(url));
      tab.failure = null;
      const loaded = waitEvent(tab.backend, ['did-stop-loading', 'destroyed'], LOAD_MS);
      const blocked = whenBlocked(this, tab);
      tab.navigating = true;
      try {
        const sent = tab.send('Page.navigate', { url });
        const r = await wait(Promise.race([sent, blocked.promise]));
        if (r === 'dialog') {
          // the navigation goes on once the dialog is answered, and a failure then has no caller left to tell
          sent.catch((error) => noteIgnored('navigate a tab a dialog interrupted', error));
          return { url: tab.url, title: tab.title, note: 'A dialog opened before the page could load.' };
        }
        if (r && r.errorText) {
          // a link answered with a file aborts the navigation: the download is the outcome, not a failure (#1484)
          if (await wait(becameDownload(tab.backend, url, r.errorText)))
            return { url: tab.url, title: tab.title, note: DOWNLOAD_NOTE, download: true };
          throw new ToolError(openFailureNote(oneLine(url), r.errorText), 'failed');
        }
        if (r && r.loaderId) {
          const finished = await span('load', () => wait(Promise.race([loaded, blocked.promise])));
          if (finished === 'destroyed') throw new ToolError(`Tab ${tab.id} closed while loading.`, 'tab_closed');
          if (finished === 'dialog') return { url: tab.url, title: tab.title, note: 'A dialog opened while the page loaded.' };
          if (finished === 'timeout' && tab.backend.isLoading())
            return { url: tab.url, title: tab.title, note: 'The page is still loading.' };
        }
      } finally {
        tab.navigating = false;
        blocked.cancel();
        // whichever way the call ends (a dialog, a download, a page still loading, a failure), the site's answer counts
        pacing.after(url, documentStatus(tab), tab.url);
      }
      if (tab.failure) throw new ToolError(loadFailureNote(tab.failure), 'failed');
      await wait(this.settle(tab, { grace: 0 }));
      const status = documentStatus(tab);
      const note = blockNote(status, tab.url);
      return note ? { url: tab.url, title: tab.title, status, note, blocked: true } : { url: tab.url, title: tab.title };
    });
  }

  /**
   * Whether reloading the tab would submit a form again: its page failed as a form result (Back onto a POST), or its
   * history entry came from a form. A history it can't read is no form: the reload goes on.
   * @this {BrowserTabs}
   */
  async reloadResubmits(tab) {
    if (tab.failure && isResubmitFailure(tab.failure)) return true;
    try {
      const h = await tab.send('Page.getNavigationHistory');
      return h?.entries?.[h.currentIndex]?.transitionType === 'form_submit';
    } catch (error) {
      noteIgnored("read a tab's history before reloading it", error);
      return false;
    }
  }

  /**
   * Back, forward or reload. A page that fails to show is the call's note, never a plain success. A reload that would
   * submit a form again is refused: only the user resubmits (Chrome asks them first; Electron cancels it silently).
   * @this {BrowserTabs}
   */
  async history(tab, dir) {
    if (dir === 'reload' && (await this.reloadResubmits(tab))) throw new ToolError(formReloadNote(tab.id), 'denied');
    // a reload is a request to the site too: a site that blocked this browser is left alone, and one that did not is paced
    if (dir === 'reload') await pacingOf(this).before(tab.url);
    return withLoadInterruption(tab.backend, async (wait) => {
      assertActionLive();
      tab.failure = null;
      const h = tab.backend.navigationHistory;
      const loaded = waitEvent(tab.backend, ['did-stop-loading', 'did-navigate-in-page', 'destroyed'], LOAD_MS);
      if (dir === 'back') h.goBack();
      else if (dir === 'forward') h.goForward();
      else tab.backend.reload();
      await wait(loaded);
      // the tab's failure is cleared when the page it went to starts loading (tab.cjs)
      if (tab.failure) return { url: tab.url, title: tab.title, note: loadFailureNote(tab.failure) };
      await wait(this.settle(tab, { grace: 0 }));
      if (dir === 'reload') pacingOf(this).after(tab.url, documentStatus(tab));
      return { url: tab.url, title: tab.title };
    });
  }

  /**
   * browser_navigate "stop": ends the tab's load as the pane's Stop does, keeping what the page rendered. No load wait of
   * the agent's own runs meanwhile (this runs in the tab's queue), so it is no user Stop (loadInterruption.cjs).
   * Whether the tab was loading.
   * @this {BrowserTabs}
   */
  stop(tab) {
    const loading = tab.backend.isLoading();
    if (loading) tab.backend.stop();
    return loading;
  }

  /**
   * Waits for a load the page started without a navigation of the tools (a duplicate's first page, historyCopy.cjs)
   * as a navigation's: settled, still loading, or failed (the tab stays; the failure is a note), and the user's Stop ends it.
   * @this {BrowserTabs}
   */
  async loaded(tab) {
    // the tab's failure is cleared when its page starts loading (tab.cjs)
    return withLoadInterruption(tab.backend, async (wait) => {
      if (tab.backend.isLoading()) {
        const finished = await wait(waitEvent(tab.backend, ['did-stop-loading', 'destroyed'], LOAD_MS));
        if (finished === 'destroyed') throw new ToolError(`Tab ${tab.id} closed while loading.`, 'tab_closed');
        if (finished === 'timeout' && tab.backend.isLoading())
          return { url: tab.url, title: tab.title, note: 'The page is still loading.' };
      }
      if (tab.failure) return { url: tab.url, title: tab.title, note: loadFailureNote(tab.failure) };
      await wait(this.settle(tab, { grace: 0 }));
      return { url: tab.url, title: tab.title };
    });
  }

  /** @this {BrowserTabs} */
  async waitForLoad(tab, state = 'load', timeoutMs = 10_000) {
    return withLoadInterruption(tab.backend, async (wait) => {
      const deadline = Date.now() + timeoutMs;
      /** @type {unknown} why the page's state could not be read, the last time it could not */
      let unread = null;
      for (;;) {
        if (tab.backend.isDestroyed()) throw new ToolError(`Tab ${tab.id} was closed.`, 'tab_closed');
        let ready = '';
        try {
          ready = (await wait(tab.agent('state'))).ready;
          unread = null;
        } catch (error) {
          // no ready state (the page is between documents): handled as not yet parsed, and named if it times out
          unread = error;
        }
        const parsed = ready === 'interactive' || ready === 'complete';
        const loaded = ready === 'complete' && !tab.backend.isLoading();
        const idle = tab.inflight.size === 0 && Date.now() - tab.lastNet >= 500;
        if (state === 'domcontentloaded' ? parsed : state === 'networkidle' ? loaded && idle : loaded) return;
        if (Date.now() >= deadline)
          throw new ToolError(
            `Timed out after ${timeoutMs} ms waiting for the page to reach "${state}".${unread ? ` Its load state could not be read: ${oneLine(messageOf(unread), 200)}` : ''}`,
            'timeout',
          );
        await wait(sleep(100));
      }
    });
  }
}
module.exports = { HostNavigation };
