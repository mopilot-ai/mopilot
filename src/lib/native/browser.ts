// window.native.browser's types (the built-in browser pane), merged into NativeApi; the calls are declared in electron/bridge/browser.cjs.
import type {
  AgentTabView,
  BrowserBookmark,
  BrowserPageEvent,
  BrowserSuggestion,
  BrowserViewApi,
  BrowserRemoteApi,
  ChromeState,
  ClaudeSiteState,
  CredentialAnswer,
  CredentialRequestView,
  ErrandAllowance,
  ImportFinished,
  ImportKind,
  ImportKindResult,
  ImportSource,
  ImportStarted,
  ImportedData,
  LoginAssistEvent,
  LoginFillStatus,
  PaneLayer,
  SiteBrowser,
  SiteGrant,
  WebPermissionSite,
} from '../native';
import type { HandoffRoute } from '../../../shared/chromeHandoff.mjs';
import type { TurnTrace } from '../turnTrace';
import type { DownloadAction, DownloadActResult, DownloadEntry, DownloadsView } from '../browserDownloads';

declare module '../native' {
  interface NativeApi {
    browser: {
      /** Restore an approved local preview before a legacy pane guest loads it. */
      preparePreview(chat: string | null, url: string): Promise<string>;
      bindPane(paneId: string, pageId: number, chat: string | null): Promise<boolean>;
      captureHistory(paneId: string, targetPaneId: string): Promise<{ token: string; url: string; title: string; chat: string | null }>;
      restoreHistory(token: string, paneId: string): Promise<boolean>;
      discardHistory(token: string): Promise<boolean>;
      stopLoading(pageId: number): Promise<void>;
      navigateGuest(
        pageId: number,
        action: 'loadURL' | 'goBack' | 'goForward' | 'reload' | 'reloadIgnoringCache',
        url?: string,
      ): Promise<void>;
      clearData(): Promise<void>;
      setDownloads(dir: string | null, ask: boolean): Promise<void>;
      /** The pane's Downloads list (electron/capabilities/browser/downloadList.cjs), with the finished ones not looked at. */
      downloads(): Promise<DownloadsView>;
      onDownloads(cb: (view: DownloadsView) => void): () => void;
      /** One download ended: the pane showing its page peeks it. */
      onDownloadDone(cb: (entry: DownloadEntry) => void): () => void;
      /** Opens, shows, cancels, resumes or removes one download; main finds its file by the id. */
      downloadAct(id: string, action: DownloadAction): Promise<DownloadActResult>;
      /** The user looked at these finished downloads; none named: all of them. */
      downloadsSeen(ids?: string[]): Promise<boolean>;
      openDownloadsFolder(): Promise<DownloadActResult>;
      /** Reports the panel tab opened for an agent's chat; false when main refused it. */
      /** tabKey: the browser_* tab id of an agent tab; omitted for a chat's original tab */
      attach(chatId: string, webContentsId: number, tabKey?: string): Promise<boolean>;
      /** How the pane lays out a tab's page: in front, painted behind the pane, or not laid out (agents wait for it to be painted). */
      layer(webContentsId: number, layer: PaneLayer): Promise<boolean>;
      /** Pane tabs as main-owned views (shared.browser.viewTabs, electron/capabilities/browser/views.cjs). */
      view: BrowserViewApi;
      /** A tab on a Host, seen by its frames (electron/capabilities/browser/remoteView.cjs). */
      remote: BrowserRemoteApi;
      /** A browser's saved sites: the in-app browser's unless `browser` names the user's Chrome (each keeps its own table) */
      sites(browser?: SiteBrowser): Promise<SiteGrant[]>;
      /** level null removes the site's permission; resolves to that browser's sites */
      setSite(origin: string, level: SiteGrant['level'] | null, browser?: SiteBrowser): Promise<SiteGrant[]>;
      /** A site the user refused, allowed for the rest of the chat in the browser that refused it: 'ask' when it is high-risk (the next call asks again), false when blocked */
      allowSiteInChat(chatId: string, origin: string, level: SiteGrant['level'], browser?: SiteBrowser): Promise<'allowed' | 'ask' | false>;
      /** Sites allowed the camera, microphone, location or notifications for good. */
      webPermissions(): Promise<WebPermissionSite[]>;
      /** Forgets what a site was allowed for good; resolves to the sites left. */
      forgetWebPermission(origin: string): Promise<WebPermissionSite[]>;
      /** Which browser channel agents get; resolves to the state after the switch. */
      configure(prefs: { channel: 'builtin' | 'chrome'; profileDir: string }): Promise<ChromeState>;
      /** Settings → Browser's "Use Claude in Chrome", saved by main; resolves with the value saved. */
      claudeInChrome(on: boolean): Promise<boolean>;
      chromeState(): Promise<ChromeState>;
      pageState(webContentsId: number): Promise<{ pages: BrowserPageEvent[]; auth: { touchId: boolean }; restartUrl: string | null }>;
      onShortcut(cb: (event: { rootId: number; combo: string; modifiers?: boolean }) => void): () => void;
      onEvent(cb: (event: BrowserPageEvent) => void): () => void;
      onChannelChanged(cb: (state: ChromeState) => void): () => void;
      /** A chat's saved turn traces (Replay), oldest first; empty while turn replays are off. */
      turnTraces(chatId: string): Promise<TurnTrace[]>;
      onTraceSaved(cb: (saved: { chatId: string; id: string; startedAt: number; endedAt: number }) => void): () => void;
      focusPopup(webContentsId: number): Promise<void>;
      closePopup(webContentsId: number): Promise<void>;
      /** Ends the passkey requests a browser page is waiting on, as Chrome's Cancel would; resolves to how many ended */
      cancelPasskey(webContentsId: number, legacy?: boolean): Promise<number>;
      /** Answers the page's own dialog; false when the agent answered it first or the page went */
      answerDialog(webContentsId: number, dialogId: number, accept: boolean, text: string | null): Promise<boolean>;
      /** Opens the app link the notice offered (only on the user's click); rejects when the page has another or none now */
      openAppLink(webContentsId: number, linkId: number): Promise<boolean>;
      /** Puts away a notice about a blocked link or a failed load */
      dismissNotice(webContentsId: number): Promise<boolean>;
      /** Stops the renderer of a page that stopped responding, so it can load again; false when it was gone already */
      stopPage(webContentsId: number): Promise<boolean>;
      /** Loads a stopped page (a popup window that hung) again */
      reloadPage(webContentsId: number): Promise<boolean>;
      /** A form result's Resubmit: loads it again with its form data (the user's choice, never an agent's). */
      resubmitPage(webContentsId: number): Promise<boolean>;
      /** Mutes or unmutes a pane page's audio; resolves with whether it is muted now */
      setAudioMuted(webContentsId: number, muted: boolean): Promise<boolean>;
      /** Annotate mode: a PNG data URL of a region (DIPs) of this window's pane tab, with its marks drawn on; null when it can't be captured */
      captureRegion(webContentsId: number, rect: { x: number; y: number; width: number; height: number }): Promise<string | null>;
      /** Annotate mode: runs an overlay script (annotateScripts) in the pane tab's isolated Annotate world, never the page's own; rejects for any other tab */
      annotate(webContentsId: number, script: string): Promise<unknown>;
      /** Which way "Open in Chrome" goes for a chat (shared/chromeHandoff.mjs): who continues there, or 'none' */
      handoffRoute(chatId: string): Promise<HandoffRoute>;
      /** Fresh continuation text, named for the current segment's tools; rejects when none can reach Chrome. */
      handoffContinuation(request: {
        chatId: string;
        url: string;
        /** the user went to Chrome to sign in and says they did */
        signedIn?: boolean;
      }): Promise<import('../../../shared/chromeHandoff.mjs').HandoffContinuation>;
      /** Hands a page to the chat's Chrome; without webContentsId, the chat's current agent tab (the ways-forward strip). preferredChanged: it changed the saved Preferred browser */
      continueInChrome(request: {
        webContentsId?: number;
        chatId: string;
        url: string;
      }): Promise<{ ok: boolean; url?: string; message?: string; cancelled?: boolean; route?: HandoffRoute; preferredChanged?: boolean }>;
      /** Stops this page's continueInChrome while it is still connecting; false when none is */
      cancelChromeHandoff(request: { webContentsId: number; chatId: string }): Promise<boolean>;
      /** Whether to show the one-time "Claude in Chrome is replaced" note (prior use, not dismissed); with a chatId, only in a Claude chat */
      claudeInChromeNote(chatId?: string): Promise<boolean>;
      dismissClaudeInChromeNote(): Promise<boolean>;
      /** Stores the Playwright Extension's token for the chosen profile; '' removes it. */
      setChromeToken(token: string): Promise<boolean>;
      /** Connects a short-lived instance to Chrome and lists its tab group. */
      testChrome(): Promise<{
        ok: boolean;
        message: string;
        extension?: { installed: string | null; pinned: string; status: 'ok' | 'older' | 'unknown'; message: string | null };
      }>;
      /** The address bar's suggestions for typed text: bookmarks first, then visited pages. */
      suggest(text: string): Promise<BrowserSuggestion[]>;
      /** Forgets one visited page (Shift+Delete on a suggestion). */
      removeHistory(url: string): Promise<void>;
      bookmarks(): Promise<BrowserBookmark[]>;
      bookmarked(url: string): Promise<boolean>;
      /** The star: adds a bookmark for the page, or removes it; ok is false for a page that cannot be bookmarked. */
      toggleBookmark(request: { url: string; title: string }): Promise<{ bookmarked: boolean; ok: boolean }>;
      removeBookmark(id: string): Promise<boolean>;
      onBookmarksChanged(cb: () => void): () => void;
      /** The saved logins of a page's site, user names only. */
      logins(url: string): Promise<{ id: string; username: string }[]>;
      /** Fills a saved login into a pane tab's page (after Touch ID where the Mac has it). */
      fillLogin(webContentsId: number, id: string): Promise<LoginFillStatus>;
      /** A page's in-field dropdown failed to fill, or main offers to save the password the user signed in with. */
      onLoginAssist(cb: (event: LoginAssistEvent) => void): () => void;
      /** The user's answer to a page's "Save password?" offer `offerId` (the one its bar showed); the password itself never leaves main. */
      answerLoginOffer(
        webContentsId: number,
        choice: 'save' | 'never' | 'dismiss',
        offerId: string,
      ): Promise<'saved' | 'never' | 'dismissed' | 'gone' | 'failed'>;
      /** Importing from the user's other browsers (shared.browser.import). */
      import: {
        sources(): Promise<ImportSource[]>;
        /** Step 1: for cookies, unlocks the browser's key (the Mac asks) and lists the sites. */
        start(request: { source: string; profile: string; kinds: Record<ImportKind, boolean> }): Promise<ImportStarted>;
        /** Step 2: writes the categories, with the cookies of the chosen sites. */
        run(request: { jobId: string; sites: string[] }): Promise<ImportFinished>;
        cancel(jobId: string): Promise<boolean>;
        imported(): Promise<ImportedData>;
        /** Removes the cookies an import wrote: one site, or all. Resolves to how many. */
        removeCookies(site?: string): Promise<number>;
        deleteHistory(source?: string): Promise<number>;
        deleteBookmarks(source?: string): Promise<number>;
        deletePasswords(source?: string): Promise<number>;
        /** Opens System Settings → Privacy & Security → Full Disk Access (Safari). */
        openFullDiskAccess(): Promise<void>;
        /** Safari's passwords: the user picks the file Safari exported (main keeps the path); null when they cancel. */
        choosePasswordFile(): Promise<{ name: string } | null>;
        /** Sends the chosen passwords file to the Trash (it holds every password in plain text). */
        trashPasswordFile(): Promise<{ ok: true } | { ok: false; code: string; message: string }>;
        onProgress(cb: (event: { jobId: string; kind: ImportKind; result: ImportKindResult }) => void): () => void;
      };
      /** Agent control of the pane's tabs, by chat (electron/capabilities/browser/agentTabs.cjs). */
      agentTabs(): Promise<Record<string, AgentTabView[]>>;
      onAgentTabs(cb: (e: { chatId: string; tabs: AgentTabView[] }) => void): () => void;
      /** Whether the shared profile is signed in to claude.ai (electron/capabilities/browser/claudeSite.cjs); the higher seq is newer */
      claudeSignIn(): Promise<ClaudeSiteState>;
      onClaudeSignIn(cb: (state: ClaudeSiteState) => void): () => void;
      /** "Take over" (true) or "Hand back" (false) an agent's tab; false when there is no such tab */
      takeOver(chatId: string, tabKey: string | null, take: boolean): Promise<boolean>;
      /** "Stop" on the agent bar: stops the chat's turn as Stop does */
      stopAgent(chatId: string): Promise<boolean>;
      /** The user hid the pane while these chats' agents used it: no more automatic reveals this turn */
      paneHidden(chatIds: string[]): Promise<boolean>;
      /** "Done, continue" (done: sends "Done on <site>" into the chat) or giving up on a browser_request_signin hand-off; tabId null: the chat's held tab. False when none holds */
      signinDone(chatId: string, tabId: string | null, done?: boolean): Promise<boolean>;
      /** The sites where the chat's ordinary messages are allowed for its errand, in either browser (errandGrants.cjs) */
      errands(chatId: string): Promise<ErrandAllowance[]>;
      /** Revoke on one: messages there ask again; false when it was already gone */
      revokeErrand(chatId: string, site: string, browser: 'iab' | 'chrome'): Promise<boolean>;
      onErrands(cb: (e: { chatId: string; errands: ErrandAllowance[] }) => void): () => void;
      /** The open browser_request_credentials sheets (electron/capabilities/browser/credentials.cjs) */
      credentialRequests(): Promise<CredentialRequestView[]>;
      onCredentialRequests(cb: (list: CredentialRequestView[]) => void): () => void;
      /** The user's answer to a sheet; the values go to main, which fills them into the page. False when the sheet is gone */
      credentialAnswer(id: string, answer: CredentialAnswer): Promise<boolean>;
      /** Forgets a login saved in MoPilot */
      credentialForget(savedId: string): Promise<boolean>;
    };
  }
}
