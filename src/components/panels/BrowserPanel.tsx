// Persistent browser pane navigation, page effects and toolbar orchestration.
import { browserDuplication } from '../../store/browserDuplicate';
import { BrowserDuplicateNotice } from '../titleBar/PaneTabMenu';
import { stopBrowserLoad, browserLoadFailure, loadWasAborted } from '../../lib/browserStop';
import { reloadBrowserPage, useBrowserShortcuts, browserPageId } from '../../session/useBrowserShortcuts';
import { useEffect, useRef, useState } from 'react';
import { useEffectOn } from '../../lib/effects';
import { useStore, set as setState, toast, toastFailure } from '../../store/core';
import { closePaneTab } from '../../store/panes';
import { chatOf } from '../../store/chats';
import { ExternalLink, Highlighter } from '../ui/icons';
import { native, type BrowserPageEvent, type PaneLayer } from '../../lib/native';
import { noteIgnored } from '../../lib/ignored';
import { openLink } from '../../session/open';
import { agentTabFor } from '../../lib/agentTabs';
import { browserUrl, isWebUrl, isIdentityProvider } from '../../../shared/browser.mjs';
import { browserPartition, SHARED_PARTITION } from '../../../shared/browserStorage.mjs';
import { loadFailure, PANE_NOTICE_KINDS, type NoticeAction } from '../../../shared/browserNotice.mjs';
import { AnnotateBar } from './BrowserAnnotate';
import { SuggestionList } from './BrowserSuggestions';
import { BookmarkStar, BookmarksMenu } from './BrowserBookmarks';
import { BrowserImportCard } from './BrowserImportCard';
import { BrowserLoginKey } from './BrowserLoginKey';
import { BrowserLoginOffer } from './BrowserLoginOffer';
import { useSuggestions } from '../../lib/browserSuggest';
import { isEnabled } from '../../lib/flags';
import { ViewSurface, type WebviewElement, type DidFailLoadEvent } from './browserPanel/ViewSurface';
import { RemoteStage } from './browserPanel/RemoteStage';
import { hostOfTabKey } from '../../lib/hostTabKey';
import { AgentBar, AgentResultBar, ViewBadges, NavPill, NewTabTools, displayHost } from './browserPanel/auxiliary';
import { FindBar, usePageFind } from './browserPanel/FindBar';
import { BrowserDownloads, NOTICE_SLOT } from './browserPanel/Downloads';
import { PageDialogBar, PageNoticeBar, shownNotice, type PaneError } from './browserPanel/PageNotices';
import { useGuestPreview } from './browserPanel/useGuestPreview';
import { guestNavigation } from './browserPanel/guestNavigation';
import { SignInNotices } from './browserPanel/SignInNotices';
import { noticeClose } from './browserPanel/noticeClose';
import { useReportPaneLoading } from '../../store/paneLoading';
import { ChromeHandoffNotice, useChromeHandoff, type HandoffIntent } from './browserPanel/ChromeHandoff';
import { useChromeState } from './browserPanel/useChromeState';
import { useBrowserTabPage } from '../../session/browserTabPage';
import { cancelOnEscape, isEnter, selectUnlessTyped } from '../../lib/focus';

/**
 * Persistent IAB page. Its initial src stays fixed; navigation events must never reload it via React.
 * `layer` is how the pane lays the page out; an agent's tab reports it to main, whose input and
 * screenshots wait until the page is painted.
 */
export function BrowserPanel({
  tabId,
  cwd,
  threadId,
  layer = 'front',
}: {
  tabId: string;
  cwd: string;
  threadId: string | null;
  layer?: PaneLayer;
}) {
  const tab = useStore((s) => s.paneTabs.find((t) => t.id === tabId));
  const ref = useRef<WebviewElement | null>(null);
  // Annotate receives the physical guest; navigation uses a handle that enters main first.
  const guestElement = useRef<WebviewElement | null>(null);
  // the page is a main-owned view (shared.browser.viewTabs) for the panel's life, or a <webview>
  const [viewTabs] = useState(() => !!tab?.browserView || isEnabled('shared.browser.viewTabs'));
  const inputRef = useRef<HTMLInputElement>(null);
  const editing = useRef(false);
  const failedUrl = useRef<string | null>(null);
  const [source, setSource] = useState(tab?.restoring ? 'about:blank' : (tab?.url ?? ''));
  const [generation, setGeneration] = useState(0);
  const [addr, setAddr] = useState(tab?.url ?? '');
  const [focused, setFocused] = useState(false);
  // the address bar's text is something the user typed (suggestions are for that, not for a page's own address)
  const [typing, setTyping] = useState(false);
  const suggest = useSuggestions(addr, typing && focused);
  const [nav, setNav] = useState({ back: false, forward: false, loading: false });
  const [pages, setPages] = useState<BrowserPageEvent[]>([]);
  // the pane's own notice about the page (what it couldn't do), and why: 'certificate', 'input' or a load failure
  const [pageError, setPageErrorState] = useState<PaneError | null>(null);
  const setPageError = (message: string | null, reason = 'load', detail?: string) =>
    setPageErrorState(message ? { message, reason, detail } : null);
  /** A load the pane started failed: an untrusted certificate says so (Retry can't help), anything else `fallback`; one cut short by a newer load or Stop is no failure. */
  const loadError = (e: unknown, fallback: string) => {
    if (loadWasAborted(e)) return;
    const failure = browserLoadFailure(e, fallback);
    setPageError(failure.message, failure.reason, failure.detail);
  };
  // "Wait" on a page that stopped responding: that notice stays hidden (a new one shows again)
  const [waited, setWaited] = useState<BrowserPageEvent | null>(null);
  // the same for a popup window of the tab: its own, so waiting on one never brings the other back
  const [waitedPopup, setWaitedPopup] = useState<BrowserPageEvent | null>(null);
  const chrome = useChromeState();
  // Annotate mode belongs to the page it started on: a recreated page (crash recovery) leaves it
  const [annotating, setAnnotating] = useState<number | null>(null);
  const fullUrl = useStore((s) => s.prefs.browserFullUrl);
  const paneChat = tab?.agentChat || tab?.ownerChat;
  const chatId = paneChat || threadId;
  // Settings → Browser → Storage: the shared profile, or this chat's own (cleared when the chat ends).
  // A page keeps the partition it started in; a new page (a crash restart, a blank tab's first address) takes the current choice.
  const storage = useStore((s) => s.prefs.browserStorage);
  const partitionOf = useRef<{ generation: number; partition: string } | null>(null);
  if (partitionOf.current?.generation !== generation)
    partitionOf.current = { generation, partition: tab?.browserPartition ?? browserPartition(storage, chatId ? chatOf(chatId) : null) };
  const partition = partitionOf.current.partition;
  // main's view of the agent driving this tab (any harness), shown whether or not the chat is open here
  const agent = useStore((s) => (tab?.agentChat ? agentTabFor(s.agentTabs, tab.agentChat, tab.agentTab ?? null) : null));
  const rootId = useRef<number | null>(null);
  const agentChat = tab?.agentChat;
  const agentTab = tab?.agentTab;
  const remote = !!(agentChat && agentTab && hostOfTabKey(agentTab));
  const guest = useGuestPreview(source, chatId ? chatOf(chatId) : null, !viewTabs && !remote, generation);
  useReportPaneLoading(tabId, nav.loading || guest.pending);
  const layerRef = useRef(layer);
  layerRef.current = layer;
  const reportLayer = () => {
    // a view paints whether or not the pane shows it
    if (!viewTabs && agentChat && rootId.current != null)
      // the page may be gone; the next layer change reports again
      native.browser.layer(rootId.current, layerRef.current).catch((e) => noteIgnored("report a browser pane page's layer", e));
  };
  // every layer change; a page that (re)binds to its agent reports its layer itself
  useEffectOn([layer], () => {
    reportLayer();
  });
  const popup = pages.filter((p) => p.pageId !== rootId.current).at(-1);
  const rootNotice = pages.find((p) => p.pageId === rootId.current && PANE_NOTICE_KINDS.includes(p.kind) && p !== waited);
  const shownNow = useRef({ pageError, rootNotice });
  shownNow.current = { pageError, rootNotice };
  // a page's own dialog (this tab's or its popup's), for the user to answer
  const dialogPage = pages.find((p) => p.dialog);
  // agents already work in Your Chrome: the handoff only reopens the site there
  const onChrome = chrome?.active === 'chrome';
  const signIn = isIdentityProvider(tab?.url || '')
    ? displayHost(String(tab?.url))
    : popup && isIdentityProvider(popup.origin)
      ? popup.origin
      : '';
  // a page (this tab or its popup) waiting on a passkey: at macOS's sheet, or one this browser can't offer
  const passkeyPage = pages.find((p) => p.passkey);

  const update = (patch: { url?: string; title?: string }) =>
    setState((s) => ({ paneTabs: s.paneTabs.map((t) => (t.id === tabId ? { ...t, ...patch } : t)) }));

  // The page's listeners, for the life of each page (a new one per address on a blank tab or a crash restart) and
  // again when its agent's tab changes. The guest stays alive across history, redirects and title changes, so this
  // never reloads it.
  useEffectOn([!!source, generation, paneChat, agentChat, agentTab, guest.url], () => {
    const wv = ref.current;
    if (!wv) return;
    let live = true;
    let releasePage: (() => void) | undefined;
    setPages([]);
    // attached: false for the look on mount, where a guest that hasn't attached yet is the normal answer
    const rememberGuest = (attached: unknown = true) => {
      try {
        const id = wv.getWebContentsId();
        if (rootId.current !== id) tabPage.bound(id);
        rootId.current = id;
        releasePage = browserDuplication.bind(tabId, id, partition, paneChat ? chatOf(paneChat) : null);
        native.browser
          .pageState(id)
          .then((s) => live && rootId.current === id && setPages(s.pages))
          // the guest may have closed already; nothing to show
          .catch((e) => noteIgnored("read a browser pane page's popups", e));
        if (agentChat)
          // the guest may have closed before main could attach it
          native.browser.attach(agentChat, id, agentTab).catch((e) => noteIgnored("attach a browser pane page to its agent's tab", e));
        reportLayer();
      } catch (e) {
        // the guest has not attached yet: did-attach and dom-ready ask again
        if (attached) noteIgnored("read a browser pane page's id once it attached", e);
      }
    };
    const sync = () => {
      try {
        const url = failedUrl.current || wv.getURL();
        setNav({ back: wv.canGoBack(), forward: wv.canGoForward(), loading: wv.isLoading() });
        if (!editing.current) setAddr(url);
        update({ url, title: wv.getTitle() || url });
      } catch (e) {
        // the guest may have exited; the recovery notice remains visible
        noteIgnored("read a browser pane page's address and history", e);
      }
    };
    const loading = () => {
      if (rootId.current == null) rememberGuest();
      failedUrl.current = null;
      setPageError(null);
      setNav((n) => ({ ...n, loading: true }));
    };
    const ready = () => {
      rememberGuest();
      sync();
    };
    const failed = (event: Event) => {
      const e = event as DidFailLoadEvent;
      if (e.isMainFrame && e.errorCode !== -3) {
        const failure = loadFailure(e.errorCode, e.errorDescription);
        setPageError(failure.message, failure.reason, failure.detail);
        if (isWebUrl(e.validatedURL)) {
          failedUrl.current = e.validatedURL;
          update({ url: e.validatedURL });
          if (!editing.current) setAddr(e.validatedURL);
        }
      }
    };
    const off = native.browser.onEvent((event) => {
      if (event.rootId !== rootId.current) return;
      setPages((prev) =>
        event.kind === 'closed'
          ? prev.filter((p) => p.pageId !== event.pageId)
          : prev.some((p) => p.pageId === event.pageId)
            ? prev.map((p) => (p.pageId === event.pageId ? event : p))
            : [...prev, event],
      );
    });
    wv.addEventListener('did-attach', rememberGuest);
    wv.addEventListener('dom-ready', ready);
    wv.addEventListener('did-navigate', sync);
    wv.addEventListener('did-navigate-in-page', sync);
    wv.addEventListener('page-title-updated', sync);
    wv.addEventListener('did-stop-loading', sync);
    wv.addEventListener('did-start-loading', loading);
    wv.addEventListener('did-fail-load', failed);
    rememberGuest(false); // Rebind an already-mounted page when its agent's tab changes.
    return () => {
      live = false;
      rootId.current = null;
      releasePage?.();
      off();
      wv.removeEventListener('did-attach', rememberGuest);
      wv.removeEventListener('dom-ready', ready);
      wv.removeEventListener('did-navigate', sync);
      wv.removeEventListener('did-navigate-in-page', sync);
      wv.removeEventListener('page-title-updated', sync);
      wv.removeEventListener('did-stop-loading', sync);
      wv.removeEventListener('did-start-loading', loading);
      wv.removeEventListener('did-fail-load', failed);
    };
  });

  const blank = !source;
  useEffect(() => {
    if (blank) inputRef.current?.focus();
  }, [blank]);
  useEffect(() => {
    if (!source && tab?.url) setSource(tab.url);
  }, [source, tab?.url]);

  const go = (raw: string) => {
    const url = browserUrl(raw);
    if (!url) {
      setPageError('Enter a web address or search term.', 'input');
      return;
    }
    setPageError(null);
    chromeHandoff.reset();
    // a crashed view loads again in place (a crashed <webview> is replaced)
    if (ref.current && (viewTabs || rootNotice?.kind !== 'crashed')) {
      try {
        ref.current.loadURL(url).catch((e) => loadError(e, "Couldn't open this page. Try again or continue in Chrome."));
      } catch {
        setPageError('This browser page is not ready yet. Try again in a moment.');
      }
    } else {
      setSource(url);
      setGeneration((v) => v + 1);
    }
    // the tab keeps the page's title until the new page names itself, as Chrome and the Codex app do
    update({ url, title: tab?.title || url });
    setAddr(url);
  };
  const pick = (url: string) => {
    setTyping(false);
    go(url);
  };
  /** Loads the page again in a new renderer: a crashed view in place, a crashed <webview> replaced. */
  const restart = () => {
    setPageError(null);
    if (viewTabs)
      ref.current?.loadURL(tab?.url || source).catch((e) => loadError(e, "Couldn't reload this page. Try again or continue in Chrome."));
    else {
      setSource(tab?.url || source);
      setGeneration((v) => v + 1);
    }
  };
  const unavailable = () => setPageError('This browser page is not ready yet. Try again in a moment.');
  const stop = () => (guest.pending ? guest.cancel() : stopBrowserLoad(ref.current, unavailable));
  const reload = () =>
    guest.error
      ? restart()
      : reloadBrowserPage({
          failedUrl,
          clearError: () => setPageError(null),
          crashed: rootNotice?.kind === 'crashed',
          formResult: (pageError ?? rootNotice)?.reason === 'resubmit',
          restart,
          page: ref.current,
          loadError,
          unavailable,
        });
  const find = usePageFind(ref, generation);
  useBrowserShortcuts({
    page: ref,
    address: inputRef,
    front: layer === 'front' && !tab?.restoring,
    paneId: tabId,
    url: tab?.url || '',
    reload,
    annotate: () => setAnnotating((a) => (a === generation ? null : generation)),
    find: find.command,
    unavailable,
  });
  const tabPage = useBrowserTabPage(tabId, { reload, pageId: () => browserPageId(rootId.current, ref.current), muted: !!tab?.muted });
  /** The page's webContents id for main (the key button), or null while the page has none. */
  const pageIdNow = () => browserPageId(rootId.current, ref.current);
  const chromeHandoff = useChromeHandoff({
    chatId,
    generation,
    pageId: () => ref.current!.getWebContentsId(),
    rootPage: () => rootId.current,
    onChrome,
    pageGone: () => setPageError('This page is no longer available. Reload it before continuing.'),
  });
  const handoff = chromeHandoff.handoff;
  const prepareChrome = (intent: HandoffIntent) => () => void chromeHandoff.prepare(intent);
  const cancelPasskey = (legacy?: boolean) => {
    const failed = () => toast("Couldn't cancel the passkey request on this page", 'error');
    if (passkeyPage) native.browser.cancelPasskey(passkeyPage.pageId, legacy).catch(failed);
  };
  const popupAction = (action: 'focusPopup' | 'closePopup') => {
    if (popup) native.browser[action](popup.pageId).catch(() => toast('This browser window is no longer available', 'error'));
  };
  // the notice shown: the pane's own about what it couldn't do, else main's about the page
  const shown = shownNotice(pageError ?? (guest.error ? { message: guest.error, reason: 'load' } : null), rootNotice);
  // the address the page failed at, else the tab's: only a web address opens in the user's browser or hands off, and not while the Chrome card is open
  const pageUrl = failedUrl.current ?? tab?.url;
  const noticeChat = !!chatId && !handoff && isWebUrl(pageUrl ?? '');
  /** Stops the renderer of a page that stopped responding (main), then `next`; a failure is a toast. */
  const stopThen = (pageId: number, next: () => void) => {
    native.browser.stopPage(pageId).then(next, toastFailure("Couldn't stop this page"));
  };
  const closeHungTab = () => stopThen(Number(shown?.pageId), () => closePaneTab(tabId));
  // every action a page notice can offer (shared/browserNotice.mjs NOTICE_ACTIONS); noticeActions picks those that can work
  const noticeHandlers: Record<NoticeAction, () => void> = {
    retry: reload,
    resubmit: () => void native.browser.resubmitPage(Number(rootId.current)).catch(toastFailure("Couldn't resubmit this page")),
    back: () => ref.current?.goBack(),
    reload,
    stop,
    chrome: prepareChrome('continue'),
    openBrowser: () => noticeClose(shownNow, () => setPageErrorState(null), pageUrl).openBrowser(),
    // offered only on main's notice of a page whose link was blocked
    openApp: () => {
      native.browser.openAppLink(Number(shown?.pageId), Number(rootNotice?.link)).catch(toastFailure("Couldn't open the app"));
    },
    dismiss: () => noticeClose(shownNow, () => setPageErrorState(null), pageUrl).dismiss(),
    // offered only on main's notice of a page that stopped responding
    wait: () => setWaited(rootNotice as BrowserPageEvent),
    restart: () => stopThen(Number(shown?.pageId), restart),
    closeTab: closeHungTab,
    // the tab's own page is no window: closing it is closing the tab
    closeWindow: closeHungTab,
  };
  // a popup window that stopped responding gets the same way on: Wait, or stop it and reload or close the window
  const popupHung = popup?.kind === 'unresponsive' && popup !== waitedPopup ? popup : null;
  const popupHandlers: Record<NoticeAction, () => void> = {
    ...noticeHandlers,
    wait: () => setWaitedPopup(popupHung),
    restart: () =>
      stopThen(Number(popupHung?.pageId), () => {
        native.browser.reloadPage(Number(popupHung?.pageId)).catch(toastFailure("Couldn't reload the window"));
      }),
    closeWindow: () => stopThen(Number(popupHung?.pageId), () => popupAction('closePopup')),
  };
  const answerDialog = (pageId: number, dialogId: number, accept: boolean, text: string | null) => {
    native.browser.answerDialog(pageId, dialogId, accept, text).then((answered) => {
      if (!answered) toast("The page's dialog was already answered", 'info');
    }, toastFailure("Couldn't answer the page's dialog"));
  };
  // a line under the toolbar only where storage differs from the default shared profile (Continue in Chrome's tooltip covers sign-in)
  const context = !source
    ? null
    : onChrome && !tab?.agentChat
      ? 'Agents use Your Chrome. This tab has its own sign-in.'
      : partition === SHARED_PARTITION
        ? null
        : "Built-in browser · This chat's own storage, cleared when the chat ends.";

  return (
    <div className="browser-pane" data-pane-id={tabId}>
      <div className="browser-bar" inert={tab?.restoring}>
        <NavPill
          nav={{ ...nav, loading: nav.loading || guest.pending }}
          disabled={!source}
          onBack={() => ref.current?.goBack()}
          onForward={() => ref.current?.goForward()}
          onReload={() => (nav.loading || guest.pending ? stop() : reload())}
        />
        <form
          className="browser-addr"
          onSubmit={(e) => {
            e.preventDefault();
            setTyping(false);
            go(addr);
          }}
        >
          <input
            ref={inputRef}
            value={focused || fullUrl ? addr : displayHost(addr)}
            placeholder="Search or enter a URL"
            aria-label="Browser address"
            onChange={(e) => {
              setAddr(e.target.value);
              setTyping(true);
            }}
            onKeyDown={(e) => {
              const row = suggest.items[suggest.index];
              if (cancelOnEscape(e, () => setTyping(false)) || !suggest.items.length) return;
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                suggest.move(e.key === 'ArrowDown' ? 1 : -1);
              } else if (isEnter(e) && row) {
                e.preventDefault();
                pick(row.url);
              } else if (e.key === 'Delete' && e.shiftKey && row?.kind === 'history') {
                e.preventDefault();
                native.browser.removeHistory(row.url).catch((err) => noteIgnored('forget a visited page', err));
                suggest.drop(row.url);
              }
            }}
            onFocus={(e) => {
              editing.current = true;
              setFocused(true);
              selectUnlessTyped(e.target);
            }}
            onBlur={() => {
              editing.current = false;
              setFocused(false);
              setTyping(false);
            }}
            spellCheck={false}
          />
          <SuggestionList items={suggest.items} index={suggest.index} onPick={pick} onHover={suggest.setIndex} />
        </form>
        <BrowserLoginKey url={tab?.url ?? ''} pageId={pageIdNow} onChrome={chatId ? prepareChrome('signin') : undefined} />
        <BookmarkStar url={tab?.url ?? ''} title={tab?.title ?? ''} />
        <BookmarksMenu onOpen={go} />
        <ViewBadges device={agent?.device} page={ref} />
        <button
          className="browser-btn round"
          data-on={annotating === generation}
          aria-pressed={annotating === generation}
          disabled={!source}
          onClick={() => setAnnotating((a) => (a === generation ? null : generation))}
          aria-label="Annotate"
          title="Annotate: mark parts of this page for the chat"
        >
          <Highlighter size={15} />
        </button>
        <BrowserDownloads pages={() => [rootId.current, ...pages.map((p) => p.pageId)]} front={layer === 'front'} />
        <button
          className="browser-chrome-btn"
          disabled={!source || !chatId || (!!handoff && !handoff.done)}
          onClick={prepareChrome('continue')}
          title={
            onChrome
              ? 'Open this page in your real Chrome, where agents already work'
              : 'Continue this task in your real Chrome, using its own sign-in'
          }
        >
          {onChrome ? 'Open in Chrome' : 'Continue in Chrome'}
        </button>
        <button
          className="browser-btn round"
          disabled={!isWebUrl(tab?.url || '')}
          onClick={() => tab?.url && openLink(tab.url)}
          aria-label="Open in default browser"
        >
          <ExternalLink size={15} />
        </button>
        {/* the page is loading: a 2px pulsing bar along the toolbar's bottom edge, as the Codex app's (browser-pane.css) */}
        <div className="browser-loadbar" data-on={nav.loading || guest.pending} aria-hidden="true">
          <div />
        </div>
      </div>
      {!tab?.agentChat && <BrowserImportCard />}
      <BrowserLoginOffer pageId={pageIdNow} />
      <div className={NOTICE_SLOT} />
      {tab?.agentChat && agent && (agent.active || agent.takenOver || agent.signin) && <AgentBar chatId={tab.agentChat} view={agent} />}
      {tab?.agentChat && agent?.result && !agent.active && <AgentResultBar />}
      {context && <div className="browser-context">{context}</div>}
      {dialogPage?.dialog && (
        <PageDialogBar
          key={`${dialogPage.pageId}:${dialogPage.dialog.id}`}
          dialog={dialogPage.dialog}
          origin={dialogPage.origin}
          onAnswer={(accept, text) => answerDialog(dialogPage.pageId, dialogPage.dialog!.id, accept, text)}
        />
      )}
      {shown && (
        <PageNoticeBar
          notice={shown}
          loading={nav.loading || guest.pending}
          back={nav.back}
          chat={noticeChat}
          url={pageUrl}
          handlers={noticeHandlers}
        />
      )}
      {popupHung && (
        <PageNoticeBar notice={popupHung} loading={false} chat={!!chatId} popup url={popupHung.origin} handlers={popupHandlers} />
      )}
      <SignInNotices
        popup={popup}
        popupHung={!!popupHung}
        passkeyPage={passkeyPage}
        signIn={pages.some((p) => p.systemPasskeys) ? '' : signIn}
        handingOff={!!handoff}
        onChrome={chatId ? prepareChrome('signin') : null}
        popupAction={popupAction}
        cancelPasskey={cancelPasskey}
      />
      <ChromeHandoffNotice state={chromeHandoff} chrome={chrome} onChrome={onChrome} />
      <BrowserDuplicateNotice tabId={tabId} message={tab?.duplicateError} />
      <FindBar find={find} />
      {/* IAB-14: the page's stage. The Annotate bar floats over the top of the page inside it, so
          annotating never resizes or moves the <webview>. */}
      {source ? (
        <div className="browser-stage">
          {annotating === generation && (
            <AnnotateBar webview={viewTabs || remote ? ref : guestElement} threadId={threadId} onExit={() => setAnnotating(null)} />
          )}
          {remote && agentChat && agentTab ? (
            // an agent's tab on another machine, or its whole desktop, is seen by its frames (browser/remoteView.cjs, hostDesktopView.cjs)
            <RemoteStage
              key={generation}
              handleRef={ref}
              paneId={tabId}
              chatId={agentChat}
              tabKey={agentTab}
              shown={layer === 'front'}
              takenOver={!!agent?.takenOver}
            />
          ) : viewTabs ? (
            <ViewSurface
              key={generation}
              handleRef={ref}
              paneId={tabId}
              url={source}
              partition={partition}
              chatId={tab?.agentChat ?? null}
              chat={paneChat ? chatOf(paneChat) : null}
              tabKey={tab?.agentTab ?? null}
              shown={layer === 'front'}
              onClosed={() => closePaneTab(tabId)}
            />
          ) : guest.url ? (
            <webview
              key={generation}
              ref={(el) => {
                guestElement.current = el as unknown as WebviewElement | null;
                ref.current = guestElement.current ? guestNavigation(guestElement.current, unavailable) : null;
              }}
              className="browser-view"
              src={guest.url}
              partition={partition}
            />
          ) : (
            <div className="browser-view" />
          )}
        </div>
      ) : (
        <NewTabTools tabId={tabId} cwd={cwd} threadId={threadId} />
      )}
    </div>
  );
}

/**
 * The page's place in the pane when it is a main-owned view: main binds the pane tab to its view (by
 * pane id, or an agent's chat and tab key) and shows it at this element's rect while the tab is in
 * front and no app menu or dialog covers it; otherwise, and once unmounted, main parks it alive.
 * Clicks and typing reach the view directly; its state comes back through the handle.
 */
