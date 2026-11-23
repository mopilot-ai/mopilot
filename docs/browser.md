# Browser sign-in and task continuation

The built-in BrowserPanel uses the persistent `persist:browser` Electron session. Its cookies and
saved logins are separate from Your Chrome. Updating the tab's address or title does not reload the
page; history and OAuth redirects must not trigger a second navigation.

## Pane tabs are main-owned views

With `shared.browser.viewTabs` on (the default), every pane tab's page is a `WebContentsView` that
the main process creates and owns (`electron/capabilities/browser/views.cjs`), for Codex, Claude Code
and ACP chats alike:

- A view is created in the tab's storage partition (the shared profile, or with Settings → Browser →
  Storage set to "This chat only" the chat's own in-memory partition) with no preload, Node off,
  context isolation, sandbox, web security on and no `<webview>` tag. No window may attach a
  `<webview>` guest while the flag is on.
- The pane renders a placeholder and reports its rect (CSS pixels; main scales it by the window's zoom)
  while the tab is in front. Main adds the view to that window at those bounds. When the tab is behind
  another, the pane is hidden or no window shows it, the view moves to a hidden, never-shown parking
  window instead of being dropped. It keeps loading, running, taking CDP input and returning screenshots
  there. A view only removed from the view tree stops producing frames: CDP screenshots and
  `requestAnimationFrame` hang. Showing the pane in another window reparents the view without a reload.
- Agents' tabs (`browser_*` tools, `sage_browser_*`, dev previews and the `$BROWSER` shim) are views
  main opens itself, so a tab can be created with no window open. A window's pane shows the tab once it
  opens or the agent selects it. A user's view closes with its pane tab, or when every window that
  showed it closes or reloads. An agent's view stays until the agent or the user closes it, or the chat
  is deleted.
- The pane's toolbar (back, forward, reload, stop, the address bar) goes to main, and main sends the
  page's url, title, history, loading and load failures back. Clicks and typing reach the view directly.
- Only views main created (or popups it adopted) pass `assertCdpTarget` and Annotate's checks. App
  windows never do.
- A page uses its view's natural viewport throughout agent control: opening, reading, input, takeover
  and turn end do not shrink text or change responsive breakpoints. Only an explicit device/viewport
  request overrides that size; desktop/reset restores it. A parked view keeps the size it was last
  shown at (1280×800 before any window showed it).
- A page's zoom fits its view's width (`pageZoom.cjs`): a pane narrower than 1000 DIPs zooms the page
  out so it lays out near 1000 CSS px, but never below 70%, where the site's own narrow layout reads
  better than shrunken text. The zoom depends on the width only, never on agent control, and is put back
  on every navigation (Chromium keeps one zoom per host). ⌘+ / ⌘− / ⌘0 with the page or pane focused
  zoom the page's site instead of the window; the address bar then shows the percentage, which fits
  the pane again when clicked. An explicit device or viewport lays the page out at 100%. Agent
  coordinates and screenshot frames stay in page CSS pixels; regions are converted to DIPs for capture.
- A user's view tab remembers the chat whose pane shows it. Camera, microphone, location and
  notification requests from its page ask on that chat's card, as an agent tab's do. A tab of no chat
  asks on a native dialog over the window that shows it, or a standalone dialog while it is parked.

Native views draw above the app's own UI. While an app menu, popover, palette or dialog intersects the
page, the pane asks main to hide the view. The page reappears when the overlay closes, and the page
area stays blank meanwhile. Tooltips and toasts do not hide the page and may be covered by it.
Annotate's bar and full view's floating composer sit over the edge of the page area, so the view is laid
out between them rather than under them. Annotating can therefore resize the page by the bar's height.

With the flag off, the pane hosts the earlier `<webview>` guests. In that path a window reports how it
lays each agent tab out, gone pages are kept as orphans across pane remounts, and an agent tab needs a
window to open in.

## History, bookmarks and import

The shared profile (`persist:browser`) remembers the pages tabs visit (`browser-history.sqlite.enc`, encrypted at rest; kept in memory while the app runs) (an older version, which reads only the plain `browser-history.sqlite`, sees an empty history; what it records there is merged into the sealed one at the next start of this one) and the
user's bookmarks (`browser-bookmarks.json`), both in the user data folder. A chat's own in-memory
partition is never recorded. The address bar suggests from both, the star and the Bookmarks menu manage
bookmarks, Clear browsing data empties history (bookmarks stay), and agents on every harness can search
both with `browser_history_search` and `browser_bookmarks_search`. Settings → Browser → Browsing data →
Import… brings bookmarks, history, cookies and (Chromium browsers) passwords from Chrome, Edge, Brave, Chromium, Vivaldi, Arc and Safari; the key button beside the address bar fills a saved login into the page
(switch `shared.browser.import`); [iab-browser-import.md](iab-browser-import.md) has the design, what is
read from each browser, and the manual release checks.

## Popups

From a view tab, `window.open`, `target=_blank` and OAuth popups open as new tabs of the same pane.
The handler wraps the popup's own webContents (`setWindowOpenHandler` `createWindow`), so Chromium
keeps the opener, POST body, `postMessage` and `window.close` behavior. A popup that calls
`window.close()` closes its tab. An agent's popup becomes a new tab of that chat, current for its tools.
A user's popup becomes a pane tab in the window showing its opener.

With the flag off, `window.open` requests create sandboxed native browser windows in the same session.
The latest open popup becomes the chat's browser-tool target. Closing it returns control to the
remaining popup or original tab. Refs are cleared when that target changes, so the next action needs a
fresh snapshot. App UI windows and unrelated windows cannot become browser CDP targets.

Loading failures, a renderer exit and a load lasting over 30 seconds produce recovery notices. The
panel offers retry, stop while loading, popup focus/cancel, and a Chrome continuation path. Passkey
pages explain that Chrome/iCloud credentials are separate; another sign-in method remains available
on the website.

A notice offers only actions that can work for it (`noticeActions` in `shared/browserNotice.mjs`):

- An untrusted certificate says so and offers "Open in your browser" and Dismiss. The in-app browser
  never bypasses certificate errors, and a Retry would fail the same way. Once the page has opened in the
  user's browser, the notice closes and says so; if it could not open, the notice stays and a toast says why.
- A link to an app (`zoommtg:`, `mailto:`, from the page, a frame or a popup) offers "Open in app",
  which hands it to the system only on the user's click. A local file or script address offers
  Dismiss only. The agent driving the page is told in its next result.
- A page whose script is busy shows Wait, Reload and Close tab. Reload and Close tab stop its
  renderer first (`pageHang.cjs`). An agent's call that waits on the page gets the page checked
  after 3 seconds; once the page is found hung, that call and every later one fail at once with
  why, and every result says so until the page responds again.

A page's own `alert`, `confirm` and `prompt` (in every frame) come from a preload MoPilot
registers in every pane session (`pagePreload.cjs`, `pageDialogs.cjs`), not from Electron, whose
`prompt()` throws and whose native sheet stayed up after an agent answered. The pane shows the
dialog, the agent driving the tab sees it in every result (browser_*'s `browser_handle_dialog`, the
Codex plugin's `Page.handleJavaScriptDialog`), and the first answer is what the page gets. An alert
on a tab an agent drives is accepted with a note. An embedded page's dialog says which page asks. Pane pages are sandboxed with sub-frame preloads on, so the preload runs in every frame (no Node); a child frame that never navigated gets them from its parent when the page reaches its window or document. A sandboxed frame with an opaque origin keeps Chromium's own dialogs, which honour its sandbox. A dialog from an embedded page goes when that frame navigates, is removed or crashes. A hung popup window offers Wait, Reload and Close window; stopping it also stops its opener's page when they share a process.

A page that asks to confirm leaving it (beforeunload) is left when an agent's action leaves it, and
the agent is told. Otherwise, while the window showing the page is focused, the user gets Chrome's
"Leave site?" question there (it holds the app until answered, so it is asked only of a user at the
window). A page no focused window shows is left. A page dialog the tab navigates away from is
dismissed, and a page being left gets no new dialog. "Open in app" opens only the link its notice
offered; network shares and system handlers (smb:, ms-msdt:...) are never offered.

“Use Chrome” restarts on the task's site in this chat's Chrome tab group. It removes query/fragment
parameters and avoids replaying identity-provider or OAuth callback URLs into a different profile.
Where MoPilot's extension serves Chrome, the site opens in the profile it uses and the agent continues with its
Chrome tools. In a build without that extension it requires the Playwright Extension and the Your Chrome setup;
without that extension in Chrome the hand-off offers Browser settings instead of a connection that could only fail. After connecting, browser
tools switch to Your Chrome and the user can explicitly continue the original chat after signing in.
The IAB tab retains its own session. The five core tool schemas stay consistent across channels so
running sessions can continue after the switch; a fresh Chrome snapshot is required before acting.
A security refusal from a Your Chrome tool (blocked or denied site, read-only grant) carries the same structured
reason, retry flag and next step as the built-in browser's, so an agent behaves the same on either channel.
Browser channel selection is currently shared across chats; Chrome tab groups are per chat.

On macOS, packaging with an Apple signing team adds the WebAuthn keychain group to the app's
entitlements and Info.plist. Packaged apps with that group configure Electron's device-bound Touch ID
authenticator. Ad-hoc and custom development certificates without an Apple team do not enable it.
WebAuthn account selection uses a native dialog and cancels when its page goes away. This does not
import existing Chrome/iCloud passkeys or enable third-party Associated Domains. Use an alternate
website sign-in method or Your Chrome when the requested credential is unavailable.

Electron has no Chrome passkey sheet: no QR code for a phone (hybrid transport) and no Chrome or
iCloud passkeys, so a passkey request with no authenticator here waits until the site's timeout.
Each web document of a pane page gets a small wrapper around `navigator.credentials.get`/`create` in
its own world, as password-manager extensions install (`passkeys.cjs`). It reports modal passkey
requests (not conditional autofill ones) over the console, and the pane shows that the page is
waiting for a passkey this browser can't offer. "Use another method" ends the request as Chrome's
Cancel does (`NotAllowedError`), so the site shows its other sign-in methods at once; "Continue in
Chrome" stays available. The wrapper also corrects `PublicKeyCredential.getClientCapabilities`,
where Electron reports the hybrid transport it lacks. A page can see the wrapper and fake its
reports; at worst that shows the notice. The wrapper goes in right after each document commits, so
a request made by an inline script before then is not tracked. Agents' browser tools are not told
about the wait.

### macOS's passkey sheet

When the package holds Apple's `com.apple.developer.web-browser.public-key-credential` entitlement
(and `shared.browser.systemPasskeys` is on), a modal request goes to macOS's own passkey sheet
instead, as in Chrome and Safari. That sheet offers iCloud Keychain and credential-provider passkeys,
a phone through a QR code (hybrid), and security keys with their PIN (macOS 14.4 and later). The
design and its phases are in [iab-passkeys.md](iab-passkeys.md).

- `passkeys.node` (`native/passkeys`, built by `scripts/build-passkeys.mjs` into
  `Contents/Helpers`) runs AuthenticationServices in web-browser mode in the main process. It reports
  whether the signature carries the entitlement.
- The page wrapper sends the request to a CDP binding on the page's own session
  (`passkeyBridge.cjs`). Main takes the caller's origin and frame from CDP, never from the page. It
  serves only frames whose every ancestor has the same origin and whose permissions policy allows
  WebAuthn. It also checks the RP ID against the Public Suffix List (private domains included) and
  validates the options (`passkeyRequest.cjs`).
- The answer must carry the client data and RP ID hash that were sent (`passkeyResult.cjs`). It goes
  back by a single-use request id to that origin's frames only.
- The binding is armed without `Runtime.enable` (bot checks look for it); the domain is turned on
  only once a page asks. A request that hears neither an answer nor an ack (sent when the sheet comes
  up) within 5 seconds takes Electron's path, so it never hangs.
- macOS shows one sheet per app, so a second request is refused (`NotAllowedError`). The sheet
  closes on the page's timeout or abort, on navigation, a renderer exit, a closed page or "Use
  another method". A page that isn't showing is refused.
- Anything the bridge doesn't serve falls back to Electron's own path, with today's notice. That
  covers a missing entitlement, the switch being off, cross-origin frames, related origins and
  malformed options.
- While the sheet is up, the pane says to finish there. Where Electron's Touch ID authenticator is on,
  "Use a passkey saved here" sends the request to it instead, for a passkey an earlier build made.
- Conditional (autofill) requests and extensions (PRF, largeBlob, appid) are not served yet.

## Focused unit verification

Run `npm run test:coverage -- --changed --suite browser` to exercise production browser modules with mocked Electron/Chrome boundaries and BrowserPanel in a DOM unit fixture. The command enforces 100% changed-line, branch and function coverage across the measured diff; reports are under `coverage/unit`. Select additional focused tests when the diff affects other areas. The suite includes the Full access grant units and skips the test that starts the real Playwright MCP CLI. It does not start Electron, Chrome or native authenticators.

Unit tests do not exercise the actual package pipeline or OS/browser authentication. Those changes
receive code/diff review; unit
coverage does not establish that real Google sign-in or Touch ID works on an installed build.

## Manual release checks

These are acceptance scenarios, not recorded passes. Run them during release or when explicitly
requested, following AGENTS.md; ordinary fixes run focused UT but do not automatically run broad
regression/integration suites, package, or launch the app.

- With `MOPILOT_FLAGS=shared.browser.viewTabs=0` in an unpackaged build, confirm the pane falls back to
  `<webview>` tabs and native popup windows.
- Open a page in the pane, resize the window and the pane, hide and show the pane, switch chats and
  open an app menu over the page. Confirm the page stays loaded (no reload), follows the pane's bounds,
  and hides only while the menu covers it.
- Sign in on a site that uses an OAuth popup. Check opener callbacks, return to the original page,
  cancellation, and persistence after refresh/restart. Include both Claude and Codex chats.
- Exercise a supported authenticator on an appropriately signed Mac build. Check account selection,
  cancellation, unavailable credentials, and alternate sign-in. Existing personal passkeys use Chrome.
- Check an unreachable site, interrupted load, retry, address edits during navigation, and renderer
  recovery. Confirm the attempted destination remains visible after a load failure.
- Walk the edge-case fixtures for dialogs, a self-signed certificate, a deep link and a hung page
  (docs/control-plane/edge-cases.md) and click every action each notice offers.
- Continue a task in Chrome, complete sign-in manually, then resume the same chat. Confirm a fresh
  snapshot precedes input, site grants apply, and the IAB is not reported as signed in to Chrome.
- Change Browser settings or close the source tab while connecting. Confirm the continuation fails
  clearly without overwriting a newer channel/profile choice.

Long-term Codex / Claude Code IAB alignment remains tracked in
issue #318.
