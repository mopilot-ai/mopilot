// Native bridge browser tabs, site access, imports and credential handoff contracts.
export type { AgentTabView, ClaudeSiteState } from '../../../../shared/model/native';

/** A site permission for browser control: read pages, or also click and type. */
export interface SiteGrant {
  origin: string;
  level: 'read' | 'write';
}

/** A site where a chat's ordinary messages are allowed for its errand (electron/capabilities/browser/errandGrants.cjs). */
export interface ErrandAllowance {
  site: string;
  since: number;
  browser: SiteBrowser;
}

/** The browser a site table, card or refusal is about: MoPilot's in-app browser, or the user's own Chrome (signed in). */
export type SiteBrowser = 'iab' | 'chrome';

/** A site the built-in browser lets use the camera, microphone, location or notifications for good (Always allow). */
export interface WebPermissionSite {
  origin: string;
  permissions: ('camera' | 'microphone' | 'geolocation' | 'notifications')[];
}

/** One Claude Code session running Claude in Chrome, and its link as last read (electron/harness/claude/index.cjs chromeLinks). */
export interface ChromeLinkEntry {
  key: string;
  chatId: string;
  link: import('../../../../shared/model/session').ChromeLinkState | null;
}

/** A Claude in Chrome reconnect or browser switch, per session it touched. */
export interface ChromeLinkResult {
  chatId: string;
  link: import('../../../../shared/model/session').ChromeLinkState | null;
  error: string | null;
  /** a browser switch waits for the chat's running turn to end */
  deferred?: boolean;
}

/** A browser paired with Claude in Chrome (the CLI's "Select browser" list). */
export interface PairedBrowser {
  id: string;
  name: string;
  current: boolean;
}

/** A Codex Browser Use permission per site: browsing, file transfers, and full DevTools (CDP) access. */
export type BrowserUseResource = 'browse' | 'downloads' | 'uploads' | 'debug';

export type BrowserUseDecision = 'allow' | 'deny' | null;

export type BrowserUsePref = 'approvalMode' | 'historyMode' | 'downloadMode' | 'uploadMode' | 'fullCdp';

/** Codex Browser Use settings ($CODEX_HOME/browser/config.toml, electron/capabilities/browser/codexBrowserUse.cjs). */
export interface BrowserUseState {
  file: string;
  /** why the file couldn't be read; nothing else is set then */
  error?: string;
  /** policy turned browser use off for Codex */
  disabled?: string | null;
  /** false when Codex's managed policy couldn't be read (Codex not running) */
  requirementsKnown?: boolean;
  prefs?: Record<BrowserUsePref, { value: string | boolean; options: (string | boolean)[]; locked: string | null }>;
  sites?: ({ origin: string } & Record<BrowserUseResource, BrowserUseDecision>)[];
  /** read-only origin policies: managed (requirements) or config.toml's browser_use; '*' is the default for every site */
  policies?: ({ pattern: string; source: 'managed' | 'config' } & Record<BrowserUseResource, BrowserUseDecision>)[];
}

export interface ChromeState {
  /** the channel agents get right now (null: browser control is off) */
  active: 'builtin' | 'chrome' | null;
  hasToken: boolean;
  extensionUrl: string;
  /** chats that keep their Chrome connection until their turn ends, after a profile or token change */
  waitingChats?: number;
}

/** A row of the address bar's suggestions: a bookmark or a visited page. */
export interface BrowserSuggestion {
  kind: 'bookmark' | 'history';
  url: string;
  title: string;
}

export interface BrowserBookmark {
  id: string;
  title: string;
  url: string;
  /** folder names from the top; imported bookmarks start with "Imported from <Browser>" */
  folderPath: string[];
  addedAt: number;
  source: string;
}

/** What an import can bring. */
export type ImportKind = 'bookmarks' | 'history' | 'cookies' | 'passwords';

/** A browser this Mac has (electron/capabilities/browser/import/sources.cjs): `status` says whether it can be read now. */
export interface ImportSource {
  id: string;
  name: string;
  kind: 'chromium' | 'safari';
  status: 'ready' | 'needs_full_disk_access' | 'not_installed' | 'unsupported';
  profiles: { id: string; name: string; path: string }[];
  kinds: Record<ImportKind, boolean>;
  /** its passwords come from a file the user exports from it (Safari), not from its profile */
  passwordFile: boolean;
}

/** A site in the cookie checklist; `sensitive` sites (banking, email, sign-in providers) start unchecked. */
export interface ImportSite {
  site: string;
  /** cookies */
  count: number;
  /** saved passwords */
  logins: number;
  sensitive: boolean;
  reason: string | null;
}

export interface ImportKindResult {
  status: 'ok' | 'failed' | 'cancelled';
  /** why a category failed: access_blocked, missing, read_failed, too_large, keychain_denied, unsupported */
  code?: string;
  imported?: number;
  skippedExisting?: number;
  skippedInvalid?: number;
  failed?: number;
  replaced?: number;
  sites?: number;
}

export type ImportFailure = { ok: false; code: string; message: string };

export type ImportStarted = { ok: true; jobId: string; sites: ImportSite[]; failed: Record<string, string> } | ImportFailure;

export type ImportFinished = { ok: true; results: Partial<Record<ImportKind, ImportKindResult>> } | ImportFailure;

/** What imports brought, for Settings → Browser → Imported data. */
export interface ImportedData {
  history: { source: string; count: number }[];
  bookmarks: { source: string; count: number }[];
  cookies: { site: string; source: string; importedAt: number; count: number }[];
  passwords: { source: string; count: number }[];
  last: { source: string; profile: string; at: number; results: Partial<Record<ImportKind, ImportKindResult>> } | null;
}

export interface BrowserPageEvent {
  rootId: number;
  pageId: number;
  kind: 'loading' | 'slow' | 'ready' | 'failed' | 'crashed' | 'navigated' | 'opened' | 'closed' | 'blocked' | 'unresponsive';
  message: string;
  /** what narrows a failure or a block (shared/browserNotice.mjs): 'certificate', 'load', 'app-link', 'address' */
  reason?: string | null;
  /** the raw error behind a failure's words (ERR_…), for the notice's tooltip */
  detail?: string | null;
  origin: string;
  /** the page is waiting on a passkey request (cancelPasskey ends it) */
  passkey?: boolean;
  /** that request is at macOS's passkey sheet */
  passkeySystem?: boolean;
  /** this page's passkey requests go to macOS's passkey sheet (iCloud and provider passkeys, phones, security keys) */
  systemPasskeys?: boolean;
  /** a passkey an earlier build saved in MoPilot may be used instead (cancelPasskey with legacy) */
  legacyPasskeys?: boolean;
  /** which app link the notice offers to open (openAppLink), or null */
  link?: number | null;
  /** the page's own dialog, waiting for an answer from the user here or the agent (answerDialog) */
  dialog?: BrowserPageDialog | null;
}

/** A page's alert, confirm or prompt, as the pane shows it (main's pageDialogs.cjs). */
export interface BrowserPageDialog {
  id: number;
  type: 'alert' | 'confirm' | 'prompt';
  message: string;
  defaultPrompt: string;
  /** the origin of the embedded page (a frame) that asks, or '' when the tab's own page does */
  frame?: string;
}

/** One of a chat's browser tabs as the pane shows it while an agent drives it (main's agentTabs.cjs). */
/** How the pane lays out a tab's page: shown, painted behind the pane (not visible or interactive), or not laid out. */
export type PaneLayer = 'front' | 'back' | 'none';

/** A pane tab's page as main reports it (electron/capabilities/browser/views.cjs). */
export interface BrowserViewState {
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
  /** the page's own zoom factor */
  zoom: number;
  /** the zoom fits the pane's width (electron/capabilities/browser/pageZoom.cjs), not one the user chose for the site */
  zoomAuto?: boolean;
}

/** A page event of a view, as a <webview> would fire it, with the page's state after it ('closed': the page went). */
export interface BrowserViewEvent {
  id: number;
  type: string;
  state: BrowserViewState | null;
  detail: Record<string, unknown> | null;
}

export interface BrowserViewApi {
  /**
   * The pane tab's page: the view its pane id names, an agent's tab, or a new one for `url`. Null for a bad request.
   * `chatId` is the agent's chat whose tab it is; `chat` the chat whose pane shows a user's tab (its pages ask there).
   */
  bind(
    paneId: string,
    req: { chatId?: string | null; chat?: string | null; tabKey?: string | null; url?: string; partition?: string },
  ): Promise<{ id: number; state: BrowserViewState } | { closed: true } | null>;
  /** Where this window shows the page, in CSS pixels; null hides it. */
  bounds(id: number, rect: { x: number; y: number; width: number; height: number } | null): Promise<boolean>;
  nav(
    id: number,
    action: 'back' | 'forward' | 'reload' | 'reloadIgnoringCache' | 'stop' | 'zoom-in' | 'zoom-out' | 'zoom-reset' | 'load' | 'stop-find',
    url?: string,
  ): Promise<void>;
  /** Finds `text` in the page (Electron's findInPage): the request id its found-in-page events carry. */
  nav(id: number, action: 'find', request: { text: string; forward: boolean; findNext: boolean }): Promise<number>;
  /** The pane tab closed: its page goes. */
  close(paneId: string): Promise<boolean>;
  onEvent(cb: (event: BrowserViewEvent) => void): () => void;
}

export type LoginFillStatus = 'filled' | 'no_fields' | 'not_found' | 'origin_changed' | 'cancelled' | 'failed';

/** From main's in-page login help (loginAssist.cjs), for the pane showing page `pageId`. */
export type LoginAssistEvent =
  | { pageId: number; kind: 'offer'; offerId: string; host: string; username: string; update: boolean }
  | { pageId: number; kind: 'offer_gone'; offerId: string }
  | { pageId: number; kind: 'fill'; status: LoginFillStatus };

/** A browser_request_credentials sheet: the site and fields MoPilot fills, and the site's saved logins (no passwords) */
export interface CredentialRequestView {
  id: string;
  chatId: string;
  tabId: string;
  /** the page's origin */
  origin: string;
  /** the frame holding the fields, when it is another origin; '' otherwise */
  frameOrigin: string;
  reason: string;
  fields: { kind: 'username' | 'password' | 'otp'; label: string }[];
  saved: { id: string; username: string }[];
  /** logins can be saved in MoPilot (the OS encryption key is available) */
  canSave: boolean;
}

export type CredentialAnswer =
  | { action: 'fill'; values: Partial<Record<'username' | 'password' | 'otp', string>>; savedId?: string | null; save?: boolean }
  | { action: 'takeover' }
  | { action: 'decline' };

/** One frame (or failure) of a tab on a Host, pushed to the pane watching it (electron/capabilities/browser/remoteView.cjs). */
export interface BrowserRemoteFrame {
  paneId: string;
  /** the page as a JPEG, base64 */
  data?: string;
  mime?: string;
  /** the page's size in CSS pixels: what a point on the frame maps to */
  width?: number;
  height?: number;
  url?: string;
  title?: string;
  loading?: boolean;
  /** why the frame could not be fetched */
  error?: string;
}

/** One input of the user's on a tab they took over; main forwards it to the page only while the tab is theirs. */
export type BrowserRemoteInput =
  | {
      kind: 'mouse';
      type: 'down' | 'up' | 'move' | 'wheel';
      x: number;
      y: number;
      button?: 'left' | 'right' | 'middle';
      clickCount?: number;
      deltaX?: number;
      deltaY?: number;
      modifiers?: number;
    }
  | { kind: 'key'; type: 'down' | 'up'; key: string; code?: string; text?: string; keyCode?: number; modifiers?: number }
  | { kind: 'text'; text: string };

/** The pane's window onto a tab on a Host: frames by polling, input during a takeover. */
export interface BrowserRemoteApi {
  /** Starts following the tab (`tabKey` names its Host); false for a key that is not a tab on a Host. */
  watch(paneId: string, chatId: string, tabKey: string): Promise<boolean>;
  /** How the pane shows it: visible, and whether the user took it over (a takeover polls faster). */
  view(paneId: string, view: { visible?: boolean; takeover?: boolean }): Promise<boolean>;
  stop(paneId: string): Promise<boolean>;
  input(paneId: string, input: BrowserRemoteInput): Promise<boolean>;
  onFrame(cb: (frame: BrowserRemoteFrame) => void): () => void;
}
