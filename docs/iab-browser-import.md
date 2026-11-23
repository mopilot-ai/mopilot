# Browser history, bookmarks, passwords and import from other browsers

Status: implemented behind the `shared.browser.import` switch (on by default). Scope: the built-in
browser (IAB) remembers the pages and bookmarks of the shared profile, can **import bookmarks, history,
cookies and passwords** from the user's other browsers, and fills a saved login into a page from the
key button. Extensions and Firefox are not supported. A visual summary is in iab-browser-import.html.

## 1. Before this work

- The IAB had no history and no bookmarks. "History" meant each open tab's back/forward list
  (`electron/capabilities/browser/clearData.cjs`), and the address bar had no suggestions.
- Cookies live in the Electron partition `persist:browser`, the profile shared by all chats
  (`shared/browserStorage.mjs`). With Settings → Browser → Storage set to "This chat only", each chat
  gets its own in-memory partition instead.
- `electron/migrations/2026-10-cookies.cjs` already decrypted Chromium cookies (macOS OSCrypt: PBKDF2-SHA1
  with salt `saltysalt`, 1003 rounds, 16-byte key, AES-128-CBC `v10`, and the `sha256(host_key)` prefix of
  cookie schema 24 and later). That code now lives in `shared/chromiumCrypto.cjs`, used by the migration
  and the importer.

## 2. Beyond the reference products

MoPilot also imports **bookmarks**, supports **Safari** and **Arc**, and gives agents read-only history and bookmark
search tools.

## 3. Scope by source

| Source | Bookmarks | History | Cookies | Passwords |
|---|---|---|---|---|
| Chrome, Edge, Brave, Chromium, Vivaldi | `Bookmarks` and `AccountBookmarks` (JSON; a profile signed in without sync may have only the latter, and one with neither has no bookmarks) | `History` (SQLite) | `Network/Cookies` or `Cookies`, `v10` | `Login Data` and `Login Data For Account`, `v10` |
| Arc | Not offered: Arc keeps pinned tabs in `StorableSidebar.json`, not `Bookmarks` | yes | yes | yes |
| Safari | `~/Library/Safari/Bookmarks.plist` | `~/Library/Safari/History.db` | `Cookies.binarycookies`; needs Full Disk Access | From the CSV file the user exports from Safari (iCloud Keychain itself can't be read) |

A Chromium-family browser is listed only when its data folder holds a profile: other apps create the
folder just to register a native messaging host (`NativeMessagingHosts`), so the folder alone does not
mean the browser is installed.

macOS only. On other platforms every source is reported `unsupported`. Never read: `Web Data`
(addresses, cards), `logins.json`, `key4.db`, localStorage and extensions.

Cookies that are skipped on import: expired, session-only, partitioned (CHIPS, `top_frame_site_key`),
`v11`/`v20` encrypted (not decryptable here) and values that are not printable text.

## 4. Architecture

All of it runs in the main process, for every harness (Codex, Claude Code, ACP), and works with no
window open.

```
shared/chromiumCrypto.cjs                              OSCrypt v10: deriveKey, decryptValue, encryptValue
electron/capabilities/browser/
  pageUrl.cjs            which addresses are kept (http(s), no credentials, no fragment); what agents may see
  historyStore.cjs       userData/browser-history.sqlite.enc (sealed): record, search/rank, import, delete imported
  bookmarkStore.cjs      userData/browser-bookmarks.json: toggle, search, import, delete imported
  historyRecorder.cjs    records did-navigate / page-title-updated of tabs in the shared profile
  suggest.cjs            address bar suggestions: bookmarks first, then visited pages
  data.cjs               one service for main: both stores, suggest, attach (recorder), clear history
  import/
    errors.cjs           ImportError codes (access_blocked, read_failed, keychain_denied, ...)
    snapshot.cjs         copy a database to a 0700 temp dir, read-only, always removed
    sources.cjs          which browsers and profiles exist, and whether macOS lets us read them
    chromiumKey.cjs      the "<Browser> Safe Storage" key, asynchronous, zeroed after use
    chromium.cjs         Bookmarks JSON, History, Cookies readers
    safari.cjs           History.db, Bookmarks.plist (plutil), cookies
    binaryCookies.cjs    Safari's Cookies.binarycookies parser
    plistXml.cjs         XML property list parser for Bookmarks.plist
    sites.cjs            registrable domain, site checklist, sensitive sites
    cookies.cjs          write cookies into the shared session; the ledger of what was written
    importer.cjs         one job at a time: start, run, cancel, imported, remove
    service.cjs          builds the importer from the real readers
electron/app/ipc/browserData.cjs     suggestions, history removal, bookmarks
electron/app/ipc/browserImport.cjs   import: sources, start, run, cancel, imported, removal, Full Disk Access
src/lib/browserSuggest.ts, browserImport.ts
src/components/panels/BrowserSuggestions.tsx, BrowserBookmarks.tsx, BrowserImportCard.tsx
src/components/dialogs/BrowserImportDialog.tsx
src/components/pages/settings/BrowserImportData.tsx
```

### 4.1 Normalized records

```
Bookmark { title, url, folderPath: string[], addedAt }
Visit    { url, title, visitCount, typedCount, lastVisit }
Cookie   { host, name, value, path, secure, httpOnly, sameSite, expires (seconds), hostOnly }
```

Time conversion happens inside each reader: Chromium uses microseconds since 1601, Safari uses
CFAbsoluteTime (seconds since 2001).

### 4.2 History

- `userData/browser-history.sqlite.enc` (an in-memory SQLite database saved sealed, `electron/platform/sealedFile.cjs`), table `urls(url PK, title, visit_count, typed_count, last_visit,
  source)`; `source` is `local` or `import:<browser>`. Capped at 50,000 addresses; the least recently
  visited go first.
- **Recording:** main-frame navigations (HTTP status below 400) of tabs whose session is the shared
  profile, for user and agent tabs and popups alike, and legacy `<webview>` guests. A chat's own
  in-memory partition is never recorded, as a private window is not. Only imported pages carry typed
  counts; local visits do not track what was typed.
- **Ranking:** a host-prefix match beats an address-prefix match, which beats a match inside the
  address or title; within a class, frecency `visit_count + 3·typed_count` decayed by age.
- Visiting an imported page makes it the user's own (its source becomes `local`).
- **Clear browsing data** now also empties this store. Bookmarks stay.

### 4.3 Bookmarks

- `userData/browser-bookmarks.json`, written atomically and privately.
- The star toggles a bookmark of the current page; it removes every bookmark of that address.
- An import lands under the folder `Imported from <Browser>`, keeping the source's folders. A
  bookmark already in that folder is skipped, so importing again adds only new ones.

### 4.4 Cookie import

1. `start` reads the browser's key through `chromiumKey` (the macOS keychain asks the user), reads the
   cookie database snapshot, decrypts with `decryptValue`, and lists the sites.
2. The dialog, laid out as Codex's, imports every site's cookies (it passes all the sites `start`
   listed). `start` still marks sensitive sites (`siteRisk`'s `high` class plus email and sign-in
   providers) and `run` still takes a site list, so a per-site choice can come back without main changing.
3. `run` writes the chosen sites' cookies with `session.cookies.set` into `persist:browser`, replacing
   a cookie that already exists (the user importing wants the other browser's newer session), then
   flushes the store. Expiry is the source's, clamped to Chromium's 400-day maximum.
4. The ledger `userData/browser-import.json` records `[host, name, path, secure]` per site, so "Remove"
   deletes exactly what an import wrote.
5. A chat's own in-memory partition is never seeded; the dialog says sign-ins go to the shared profile.

A job holds decrypted cookies in memory until `run` finishes, the user cancels, or 10 minutes pass.
Values and keys never reach the renderer: it gets site names, counts and error codes.

### 4.5 Safari

- `History.db`: `history_items` joined with the latest `history_visits` (Mac absolute time).
- `Bookmarks.plist`: binary plist converted with `/usr/bin/plutil -convert xml1 -o -` and parsed by
  `plistXml.cjs` (JSON cannot hold the `data` and `date` values a real file has); Favorites,
  Bookmarks Menu and Reading List become folders.
- Cookies: `~/Library/Containers/com.apple.Safari/Data/Library/Cookies/Cookies.binarycookies`
  (big-endian page table and page tag `00 00 01 00`, little-endian fields inside a page, Mac-epoch dates). Safari stores no SameSite, so
  cookies are set `unspecified`.
- Without Full Disk Access reading fails with `EPERM`. The source stays listed as "Needs Full Disk
  Access", with a button that opens System Settings and "Check again".
- Passwords live in iCloud Keychain, which no app can read. The user exports them in Safari (File → Export
  → Passwords…), then chooses that file in the dialog: `browser:import:choosePasswordFile` opens a panel in
  main, which keeps the path; the renderer learns only the file name.
  - `passwordCsv.cjs` reads the export:
    - RFC 4180 rows;
    - Safari's columns (Title, URL, Username, Password, Notes, OTPAuth), Chrome's, and other managers'
      by name;
    - only a regular file under 20 MB (a symbolic link is not followed);
    - one login per web origin and user name.
  - The logins go through the same `saveMany` as Chromium passwords, marked `import:safari`.
  - This alone needs no Full Disk Access, so the Passwords row stays usable without it. The row starts
    off, and Import waits for a file.
  - After a successful import the dialog offers to move the file, which holds every password in plain text,
    to the Trash (`shell.trashItem`, so it can be recovered).

### 4.5a Password import

1. The same key read serves cookies and passwords: one keychain prompt for both. A denied key fails both
   categories; a failed read of one leaves the other.
2. `readPasswords` reads `Login Data` and `Login Data For Account`. It leaves out sites the user told
   the browser never to save (`blacklisted_by_user`), federated sign-ins (`federation_url`, no password),
   realms that are not http(s) (Android apps) and `v11`/`v20` or undecryptable values. Passwords carry
   no host hash. One login per origin (the signon realm's, else the page's) and user name: the most
   recently used.
3. Passwords of every site are imported, as cookies are (`start` lists their sites with cookies').
4. `run` saves the chosen sites' logins into MoPilot's own store (`credentialStore.cjs`,
   `userData/capabilities/browser-logins.json`, each password encrypted with Electron safeStorage), in
   one write, marked `import:<browser>`; a login for the same site and user name is replaced. Without
   an OS encryption key nothing is saved (`storage_unavailable`), never in the clear.
5. Settings lists imported passwords per browser with Delete. The agent's `request_credentials` sheet
   and the user's key button read the same store, on every harness.

### 4.5b The key button (user fill)

- Shown beside the address bar when the page's origin has saved logins. Its menu lists user names and
  "Continue in Chrome" (the user's real Chrome, whose password manager is native).
- Picking a login: main checks the pane tab is a browser page (its session is a pane session, never an
  app window), that the login belongs to the page's exact origin, and that the page shows a username or
  password field. Then it asks Touch ID where the Mac has it, decrypts the password, and for each field:
  checks the page is still on that origin, focuses and selects the visible field from an isolated world
  (`FILL_WORLD`; the page's scripts can't reach it, and the script never holds a value) and types the value
  with `webContents.insertText`, as if typed.
- Only visible, enabled fields count, so a hidden field can't collect a login. The top frame only: a
  login form in a cross-origin frame is not filled.
- The result is a status (`filled`, `no_fields`, `not_found`, `origin_changed`, `cancelled`, `failed`);
  the password never reaches the pane, the page before it is typed, logs or the model.

### 4.5c In-page login help (dropdown and "Save password?")

Behind `shared.browser.loginAssist` (on), in every user browser tab (pane views, popups, legacy guests);
`electron/capabilities/browser/loginAssist.cjs`.

- On each `dom-ready` main installs a script in `FILL_WORLD`, carrying the site's saved user names (no
  passwords) and a per-page nonce. It finds the sign-in fields as the key button does.
- **Dropdown.** When the user focuses or clicks the user-name or password field, the script draws the user
  names under it in a closed shadow root. A trusted click, or the arrow keys and Enter, picks one. The script
  signals `fill:<id>` as a console message that starts with the nonce. Main then runs the key button's fill
  (Touch ID first), and the pane shows a toast if it fails. The dropdown closes on blur, typing, scroll,
  resize and Escape.
- **Save password?** A trusted submit, a trusted click on a button, or Enter in a sign-in field, while the
  password field has a value: the script keeps `{ origin, username, password }` in its own world and
  signals `submitted`. Main takes the values from that world (`take()`), so the password never appears in
  a console message. Main waits until the sign-in looks accepted: the main frame navigates, or after 3
  seconds the page's password field is gone. A form still on the page means the password was refused, so a
  wrong password never replaces a saved one. Main then offers to save them unless:
  - the site is on the user's "Never" list;
  - logins can't be saved (no OS encryption key);
  - the same user already has that password saved.

  An existing user with a different password gets "Update". The offer, and the password with it, stays
  in main for 2 minutes. The pane gets only `{ pageId, host, username, update }`.
- **The bar** under the toolbar (`BrowserLoginOffer.tsx`) offers Save (or Update), Never for this site, and
  Not now. Only the page id and the choice go back to main (`browser:answerLoginOffer`). Saving refreshes
  the page's dropdown and the key button. Answering closes the bar in every window. The bar keeps offers per
  page, so an offer for a tab in the background shows when the pane returns to it. "Never" is kept per origin in `browser-logins-never.json`.
- **Agents.** While an agent drives the tab (`BrowserTabs.driver`), its signals are ignored: nothing is
  filled, taken or offered. A page loaded while an agent drives it gets no saved user names, so it shows
  no dropdown. Agents sign in through `request_credentials`. After the user takes the tab
  over, the help works again.
- **Clickjacking.** The dropdown's host element is in the page's DOM, so a row click counts only if:
  - the field still has the focus;
  - the host's style is unchanged;
  - its computed opacity, visibility, transform and filter are untouched;
  - it sits where it was drawn;
  - it is the topmost element at the click point.

  Otherwise the dropdown closes and nothing is filled.
- **Limits.** Without a nonce the page can't send a signal. Untrusted events (the page's own scripts) are
  ignored. A sign-in that leaves the page before main asks is not offered. Only the top frame is watched.

### 4.6 Running browsers

Copying a database together with its `-wal` file gives a consistent snapshot while the browser runs, so
the user is not asked to quit it. If a read still fails the category reports "Quit <Browser> and try
again", and only the failed categories are retried.

### 4.7 Agent tools

Two read-only tools join the `browser_*` set in `hostTools.cjs`, registered through the capability
registry so sage-mcp, Claude Code's SDK MCP server, ACP session MCP and Codex `dynamicTools` expose the
same specs.

| Tool | Arguments | Returns |
|---|---|---|
| `browser_history_search` | `query?`, `since?` (ISO date), `limit?` (20, max 100) | `[{url, title, lastVisit, visitCount}]`, ranked like the address bar |
| `browser_bookmarks_search` | `query?`, `folder?`, `limit?` (50, max 200) | `[{url, title, folderPath}]` |

- They never navigate, so they need no site grant; opening a result goes through `browser_navigate`
  and its existing checks.
- A `blocked` address (cloud metadata) is dropped. A `high`-risk site shows its host only, flagged
  `risk: 'high'`, with no title, so account paths and reset links never reach the model. Credential-like
  query values (`token`, `key`, `code`, ...) are replaced with `REDACTED`.
- They work with no window open and in read-only chats. In "This chat only" chats they search the shared
  stores, as the address bar does.

## 5. User interface

- **Address bar suggestions:** typing shows bookmarks and visited pages (↑/↓, Enter, Esc; Shift+Delete
  forgets a visited page). The list is a menu, so the native page view hides while it is open, as it
  does for other menus (`OVERLAY_SELECTOR` in `src/lib/browserView.ts`).
- **☆ and the Bookmarks menu** beside the address bar: bookmark the page, open or remove a bookmark,
  and "Import from another browser…".
- **Import dialog**, "Import from your browser", laid out as Codex's (`open-browser-import` event;
  Settings → Browser → Browsing data → Import…, the Bookmarks menu and the first-run card open it):
  - "From": every readable profile ("Google Chrome · Work"); Safari without Full Disk Access shows a note
    with Open Settings and Check again. "Close <browser> completely before importing" under it.
  - One row per category with a switch: Saved passwords, Cookies, Browsing history, Bookmarks (only those
    the browser can bring). A line says the Mac will ask for "<browser> Safe Storage" when cookies or
    passwords are on.
  - Import runs at once: the subtitle says what is importing, each row turns into a spinner, then its
    result ("23 cookies (1 refused)") or the reason it failed. The title ends as "Import complete" or
    "Import failed"; Retry runs only the rows that failed; Done closes.
- **First-run card** in a user's browser tab (never an agent's): "Bring your bookmarks, history and
  sign-ins from …". "Not now" returns it after 1, then 3, then 7 days; "Don't show again" ends it; a
  successful import retires it. Prefs: `browserImportPrompt`, `browserImportSnoozes`,
  `browserImportSnoozeUntil`.
- **Key button** beside the address bar when the site has saved logins (§4.5b).
- **Login dropdown** under a page's sign-in fields, and the **"Save password?" bar** under the toolbar
  after a sign-in (§4.5c).
- **Settings → Browser → Browsing data** lists what imports brought, with Delete (history, bookmarks,
  passwords per browser) and Remove (cookies per site, or all). These are plain lines, not Settings rows: the page's
  row budget (`ROWS_BUDGET`) is full.

## 6. Security and privacy

- Temp snapshots go to a 0700 folder under the system temp dir and are removed in `finally`; symlinked
  source files and files over 512 MB are refused; key buffers are zeroed after use.
- Agents gain sign-ins, not permissions: site grants (`origins.cjs`) and site risk (`siteRisk.cjs`)
  still gate them. The dialog says so.
- The keychain read is asynchronous (`execFile`), because the prompt can wait minutes and must not block
  main. The `security` prompt names "security" rather than MoPilot; the cookie migration, which runs
  before the app is ready, still reads its keychain item synchronously. A native `SecItemCopyMatching` in
  the desktop helper would name the app and is future work.
- One import job at a time (`busy`). Every step after an `await` checks the job is still current;
  cancel stops before the next category and before the next cookie.

## 7. Multi-harness

| Case | Behavior |
|---|---|
| Codex, Claude Code, ACP chats | Same stores, same `persist:browser`. Importing is a user action, not a harness capability. |
| Agent tabs (`browser_*`, the Codex iab backend, `sage_browser_*`) | See imported cookies; their navigations are recorded in history |
| "This chat only" storage | Not seeded with cookies, not recorded in history |
| No window open | Import runs in main; progress is broadcast to any window |
| Your Chrome channel | Not affected (it is the user's real Chrome) |

## 8. Testing

Focused unit tests, with 100% changed-line, branch and function coverage:

- `tests/browserImportSnapshot.test.ts`, `browserImportChromium.test.ts`, `browserImportSources.test.ts`,
  `browserImportSafari.test.ts`: readers against real fixture files (SQLite, JSON, `binarycookies`).
- `tests/browserHistory.test.ts`: URL rules, history ranking, bookmarks, suggestions, recorder, IPC.
- `tests/browserImportCore.test.ts`, `browserImportIpc.test.ts`: sites, ledger, importer (cancel, busy,
  expiry, partial failures), the real readers wired through a temp home.
- `tests/browserMemoryTools.test.ts`: the agent search tools.
- `tests/browserDataWiring.test.ts`: main wires recording, clearing, tools and IPC.
- `tests/browserPasswordCsv.test.ts`: the passwords export reader (CSV parsing, columns, rejected files).
- `tests/browserPasswords.test.ts`: the password reader, the login store's import, the key button's fill
  and its IPC.
- `tests/browserLoginAssist.test.ts`: the fill world's dropdown and sign-in watcher (in happy-dom), main's
  signals, offers, expiry and answers, the "Never" list, and the IPC.
- `tests/browserBookmarksUI.test.ts`, `browserImportUI.test.ts`, `browserImportLib.test.ts`,
  `browserLoginKeyUI.test.ts`, `browserLoginOfferUI.test.ts`, `browserPanelUI.test.ts`: the address bar,
  star and menu, key button, save-password bar, dialog, first-run card, imported-data lines.

## 9. Manual release checks

Not recorded passes; run them in a real build with scratch user data (AGENTS.md).

- Import from a Chrome profile with a few bookmarks and history entries. Confirm suggestions in the
  address bar, the Bookmarks menu, and that a visited page appears after browsing.
- Import cookies from Chrome and confirm the keychain prompt names "Chrome Safe Storage", a site opens
  signed in, and Remove signs it out again.
- Safari without Full Disk Access shows the note and the System Settings button; after granting it the
  import works.
- Import passwords from Chrome; on a site with a saved login the key button appears, Touch ID is asked,
  and the user name and password land in the page's fields (a two-step sign-in: the password on the
  second page). A site without a field reports it.
- In Safari, export passwords (File → Export → Passwords…), then import that file. The logins appear in Settings →
  Browser as Safari's. "Move to Trash" sends the file to the Trash.
- On a site with a saved login, focusing the user-name field shows the dropdown. Picking a name asks
  Touch ID and fills both fields. Signing in on a site with a new password shows "Save password?";
  Save makes the key button appear. "Never for this site" stops further offers there. While an agent
  drives the tab, neither appears.
- Clear browsing data empties history but keeps bookmarks.
- With "This chat only" storage, imports do not seed it and its visits are not recorded.

## 10. Decisions

- **Every site** is imported, with no site step, as Codex does (this replaced the earlier Claude-style
  checklist with sensitive sites unchecked).
- **Agents** get read-only history and bookmark search on every harness.
- **Cookie expiry:** the source's, clamped to 400 days (what Codex effectively does through Chromium).
  An existing cookie is replaced, not skipped.
- **First-run card:** in the pane, snoozed 1/3/7 days, ended by "Don't show again" or an import.
- **Firefox** is not supported.
- **Passwords** go into MoPilot's own encrypted store, filled by main on the user's click (Touch ID
  where available); Codex's in-field password manager comes from its Chromium fork, which an Electron app
  does not have.
- **Safari passwords** come from the user's own CSV export. Reading the Keychain directly would need an Apple
  entitlement no third-party app gets.
- **In-page login help** is drawn by MoPilot's own script in an isolated world, not by the browser
  as in Codex's Chromium fork. The page can see that the dropdown's host element exists, but not its
  contents or the nonce, and it can't trigger it.
- **Not in this phase:** login forms inside frames, a settings page for the "Never" list, extensions,
  localStorage, Arc's pinned tabs, Windows and Linux, a
  bookmark manager, and a suggestion list that keeps the page visible (a floating child view).
