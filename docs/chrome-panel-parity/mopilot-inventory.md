# MoPilot Chrome side panel: inventory of main

Scope: the extension's side panel as it is on main (branch `mopilot/chrome-panel-parity-design`, current main), as the baseline for the panel's design work ([design.md](design.md)). This file records what exists. It does not propose changes.

Sources read (all paths under `electron/` unless noted):

- `chrome-extension/sidepanel.html`, `sidepanel.css`, `panel.css`, `src/panel*.mjs`, `src/sidePanel.mjs`, `src/groups.mjs`, `src/sessions.mjs`, `src/tabNotices.mjs`, `src/contextMenu.mjs`, `mic.html`, `blocked.html`.
- Main side: `app/chromePanel*.cjs`, `capabilities/browser/chromePanel*.cjs`, `capabilities/browser/agentControlFrame.cjs`, `capabilities/browser/agentTabMark.cjs`, `shared/ownToolLines.mjs`.
- Real-Chrome specs: `tests/e2e/cuj-chrome-*.spec.ts`. Unit tests: `tests/chromePanel*.test.ts`, `tests/chromeSidePanel.test.ts`, `tests/chromeGroupStatus.test.ts`, `tests/agentControlFrame.test.ts`, `tests/agentTabMark*.test.ts`.

Conventions. "File:line" means a line in the stated file as read on main today. `ext/` = `electron/chrome-extension/`. "Spec" = a real-Chrome spec (`tests/e2e/cuj-chrome-*.spec.ts`, real Chrome with the real extension against the app, fake harnesses). "UT" = a unit test in `tests/`. "none" = no test of that state in that layer. Spec names are shortened: `side-panel` = `cuj-chrome-side-panel`, `design` = `cuj-chrome-panel-design`, and so on.

Recently landed, recorded as present (verified in the code below):

| Change | Where |
| --- | --- |
| Usage-limit banner and a "Limit reached" progress line | `ext/src/panelThread.mjs:22-23`, `ext/src/panelChrome.mjs:82-89`, `app/chromePanelIdentity.cjs:30-39`, `session/caps.cjs:411-415` |
| MoPilot's own tools worded ("Wrapped up") | `shared/ownToolLines.mjs` (`wrap_up`), `capabilities/browser/chromePanelLive.cjs` `ownToolLine` |
| Paste an image into the box | `ext/src/panelAttach.mjs:40-49` |
| Tab group named for the chat, or "MoPilot" | `ext/src/groups.mjs:5-8`, `ext/src/sessions.mjs:90,153`, `capabilities/browser/chromeExtension.cjs:411`, `app/chromeRelay.cjs:332` |
| User bubble Copy takes no room | `ext/sidepanel.css:146-147` |
| Harness list asked again when the model menu opens | `ext/src/panelMenus.mjs:93`, `ext/src/panelHarnesses.mjs:39-47`, `ext/src/sidePanel.mjs:29,110` |
| Message box grows with its text, no resize handle | `ext/src/panelAutosize.mjs:4-8`, `ext/sidepanel.css:108` |
| Finished turn with one run of steps folds under "Worked for 11s" | `ext/src/panelStep.mjs:4-10`, `ext/src/panelThread.mjs:331-352`, `capabilities/browser/chromePanelLive.cjs` (`workedMs`) |

---

## 0. Global look and structure

Entry: `ext/sidepanel.html` (104 lines). Body `class="side"`; flex column, `height: 100%`, `position: relative` (`sidepanel.css:7-9`). The page is one column: `<header class="bar">` (html:10-21), `#task-title` (22), `#sidebar` overlay (23-36), then exactly one of `#state` (37), `#welcome` (43), `#empty` (56) or `#chat` (59), then `#jump` (67), `#composer` (68-100), `#pin-tip` (101). `show()` decides which (`ext/src/sidePanel.mjs:187-228`).

Tokens (`ext/panel.css:3-14`, dark `15-24`, overridden in `ext/sidepanel.css:2-6`):

| Token | Light | Dark |
| --- | --- | --- |
| `--bg` | `#faf9f6` (sidepanel.css:2) | `#262624` |
| `--fg` | `#262624` | `#e9e8e3` |
| `--soft` (bubble, code, hover) | `#f0efeb` | `#30302e` |
| `--card` (composer card, jump button, header menu) | `#fff` | `#30302e` |
| `--accent` | `#d97757` (used only for the hold ring and card checkboxes, `sidepanel.css:97,99`) | same |
| `--muted` | `#6b6b6b` (panel.css:5) | `#a0a0a0` |
| `--line` | `#e4e4e4` | `#3a3a3a` |
| `--btn` / `--btn-fg` | `#1f1f1f` / `#fff` | `#ececec` / `#202124` |
| `--ok` / `--wait` / `--error` / `--off` | `#1e8e3e` / `#d97706` / `#c5221f` / `#9a9a9a` (no dark override) | same |

Fonts: body `13px/1.45 system-ui, -apple-system, sans-serif` (`panel.css:25`). Replies: `Charter, "Iowan Old Style", Georgia, serif`, 16px, line-height 1.55 (`sidepanel.css:64`). Code: `12px ui-monospace, monospace`. Dark mode follows `prefers-color-scheme` only; there is no in-panel theme switch.

Status dot: `.dot` 8x8 circle (`panel.css:31-34`); `.ok` green, `.wait` amber, `.error` red, default grey.

Chevron: one SVG mask (`sidepanel.css:4-5`), 10x10, margin-left 4px, drawn in currentColor, used by `.chev` (title), `#perm::after`, `.steps > summary::after` (rotated -90deg when closed, `sidepanel.css:82-83`).

Animations in the panel document: exactly one, `spin` (`sidepanel.css:52-54`, 0.9s linear infinite on `.spin`, disabled under `prefers-reduced-motion`). Nothing else animates (details in section 17).

Dead CSS that remains (no element uses it): `.sugg` (55-56), `.tasks`/`.task` (177-179, the greeting's task list moved to the sidebar), `.bar img` (12). Recorded because a parity pass may reuse or delete them.

---

## 1. Header / toolbar

Layout: `.bar` flex row, `gap 4px`, `padding 8px 12px 4px`, `min-height 28px` (`sidepanel.css:10`). A flex spacer (`.grow`) first, so buttons sit right-aligned; there is no logo, no wordmark and no title in the bar. Buttons are `.icon` 28x28, no border, `color var(--muted)`, hover background `--soft` (`sidepanel.css:14,23`), 18px stroke icons at 1.6 stroke (`15`).

| Button | id | Glyph | title / aria-label | Shown when | Action | Code |
| --- | --- | --- | --- | --- | --- | --- |
| History | `#side` | clock-with-arrow svg | title "History", aria "Show sidebar", `aria-expanded` toggles | connected (hidden on a connection state, `$('side').hidden = !!st`) | toggles sidebar | html:12, sidePanel.mjs:206,418-422 |
| New chat | `#new` | pencil-in-square svg | "New chat" | connected | `newChat()` (clears box, closes thread) | html:13, sidePanel.mjs:195,424 |
| More | `#more` | three dots | "More", `aria-haspopup=menu` | hidden while the composer is hidden (state, first run) via `body.side:has(#composer[hidden]) #more` | opens header menu | html:14, sidepanel.css:22 |

Header menu `#header-menu`: absolute, `top 40px; right 12px`, `min-width 210px`, `max-width calc(100vw - 24px)`, padding 6, `--card` background, 1px `--line` border, radius 12, shadow `0 8px 28px rgb(0 0 0 / .12)`, z-index 8 (`sidepanel.css:20`). Rows (html:15-20):

1. `#meta` (hidden with no chat): "harness · account", e.g. "Claude Code · a@b.com" (`panelThread.mjs:203`), 12px muted, single line with ellipsis.
2. "Open in MoPilot ↗" (`#app`, hidden when not connected): opens the chat (`sidePanel.mjs:431`) or the app when no chat.
3. "Extension settings" (clicks the sidebar's hidden `#side-settings`, which calls `chrome.runtime.openOptionsPage`, `panelChrome.mjs:23-26`).
4. "Scheduled tasks": opens the sidebar and scrolls `#tasks` into view (`panelChrome.mjs:27-31`).

Dismiss: outside `pointerdown`, or Escape (`panelChrome.mjs:32-38`); also after any row. Menu has no animation, no arrow keys, no focus trap, no roving focus (rows are plain buttons in tab order).

Thread title row `#task-title` (html:22): only with a chat open (`show`, `sidePanel.mjs:200`; also `body.side:has(#chat[hidden]) .thread-title {display:none}`, `sidepanel.css:19`). Flex, `padding 2px 14px 8px`. The title is a button, 14px weight 500, `max-width calc(100% - 18px)`, ellipsis, followed by the chevron; clicking toggles the sidebar (`sidePanel.mjs:423`). Text: chat title (whitespace collapsed, max 80 code points, `sidePanel.mjs:287`), "New chat" when none, replaced by the harness's own title when a read returns one (`sidePanel.mjs:80-83`, `app/chromePanelIdentity.cjs:13-40`, 3s timeout). There is no rename, no share, no overflow actions on the title.

Coverage:

| State | UT | Spec |
| --- | --- | --- |
| Toolbar ids in empty state (`side, new, more`), title row hidden | `chromeSidePanel`, `chromePanelPresentation` | design (asserts the id list and `#task-title` hidden) |
| More menu opens | `chromePanelPresentation` ("compact header menu routes settings and tasks, dismisses only on outside click or Escape") | design (screenshot `more-menu.png`, not a value assertion) |
| Open in MoPilot | `chromePanelPresentation` | side-panel (clicks it, app shows the chat) |
| Extension settings, Scheduled tasks rows | `chromePanelPresentation` | none |
| Title from harness / 80-char clip | `chromeSidePanel`, `chromePanelThread` | design ("Fake chat title" read back) |
| `#meta` harness · account | `chromePanelMetadataUI` | harness-switch (Codex then Claude Code) |

---

## 2. History sidebar

Element `#sidebar` (html:23-36): `position absolute; inset 0; z-index 3`, full-panel overlay on `--bg`, flex column, `gap 6px`, `padding 10px`, scrolls (`sidepanel.css:24`). It covers the chat and composer; there is no slide or fade. `show()` closes it on any connection state (`sidePanel.mjs:208`). `side-close` (×, 28x28) hides it; choosing a chat, New chat also close it.

Top to bottom (`ext/src/panelSidebar.mjs`, html:24-35):

1. Head: 18px icon, "MoPilot" (600), × button titled "Hide sidebar".
2. Search: `input[type=search]` placeholder "Search chats", aria "Search chats"; 6px 9px padding, 1px line, radius 8; filters titles case-insensitively, client side (`panelSidebar.mjs:115-125`).
3. "＋ New chat" (`.side-item`, full-width, radius 6).
4. "Projects" heading (11px, 600, uppercase, 0.04em, muted, `sidepanel.css:29`). Rows: "All chats" first then each project; picking one filters the list and is where a new chat goes; picking it again clears (`panelSidebar.mjs:130-146`). Empty: "No projects yet."
5. "Scheduled" heading. Rows: task name + muted small time from `whenOf`: "Paused", "Today 3:02 PM", "Tomorrow 9:00 AM", or "Oct 31 9:00 AM" (`panelSidebar.mjs:11-20`); click opens the app's Scheduled page (`onOpen(null, 'scheduled')`). Empty: "No scheduled tasks."
6. "Pinned" heading and list: hidden when none, also hidden while searching or in Archived (`panelSidebar.mjs:167-170`).
7. Recents row: heading "Recents", a `<select id="recents-filter">` (Active / Archived, 12px muted) and a checkbox "By project" (`html:33`). Archived reloads with `archived: true`; By project groups with a 12px muted head per project ("No project" last).
8. Chat rows: `.row` containing `.row-chat` (status dot, title with ellipsis, "Waiting" small when `state==='waiting'`) and a `⋯` button (aria "More options for <title>") whose `.row-menu` offers "Pin"/"Unpin" and "Open in MoPilot" (`panelSidebar.mjs:200-254`). The row menu is absolute `right 0; top 28px`, min-width 180, radius 8, shadow `0 8px 24px rgba(0,0,0,.14)`. Dot tones: running and waiting amber, idle grey (`TONE`, line 8); there is no unread marker, no timestamp, no per-row project label, no archive/delete/rename action.
9. Empty strings: "Loading…" while fetching; "No chats match." (search), "No archived chats.", "No chats yet."; a failed list shows the error text in its own list (`panelSidebar.mjs:99-104`).
10. Foot (`.side-foot`, sticks to bottom, top border): "View all in MoPilot ↗", "Extension settings".

Limits: `recent` limit 200 (`panelSidebar.mjs:90`). No pagination, no virtualized list.

Coverage:

| State | UT | Spec |
| --- | --- | --- |
| Open, headings Projects / Scheduled / Recents, chat in Recents, Pin, Pinned list, search no-match and match, New chat, reopen from Pinned | `chromePanelSidebar`, `chromePanelSidebarMain` | side-panel |
| Archived filter, By project, project filter, project-scoped New chat | `chromePanelSidebar` | none |
| Scheduled rows and `whenOf` text | `chromePanelSidebar` | none |
| `⋯` > Open in MoPilot, View all, Extension settings (sidebar foot) | `chromePanelSidebar` | none (Open in MoPilot is covered from the header menu only) |
| "Waiting" tag, status dots | `chromePanelSidebar` | none |
| Empty / loading / failed list strings | `chromePanelSidebar` | none |

---

## 3. Connection states, welcome, consent, intro

### 3.1 Connection states (until paired and connected)

`#state` is a centered column (`.center`: flex 1, grid, gap 10, padding 24, text-align center, `sidepanel.css:48`): optional 18px `.spin`, `<h2>` 15px, `<p>` muted max 30ch, optional primary button (`html:37-42`). The bar's History and New chat are hidden; More is hidden (composer hidden). Source of truth: `ext/src/panelConnection.mjs:6-39`, `stateOf` 45-55. Re-polled by `FOLLOW_MS` (`ext/src/options.mjs:32-40`): connecting/asking/starting 1s, unpaired/unauthorized 2s, offline and update-required 5s; also on a background `status` event (`sidePanel.mjs:471`).

| Key | Spinner | Title | Text | Button (`send`) |
| --- | --- | --- | --- | --- |
| starting | yes | "Starting MoPilot…" | "This takes a few seconds." | none |
| connecting (default) | yes | "Connecting…" | "" | none |
| offline | no | "MoPilot isn't running" | "Open it to chat from Chrome." | "Open MoPilot" (`launch`) |
| asking | no | "Allow this Chrome in MoPilot" | "Click Allow in MoPilot to connect." | none |
| unpaired | no | "Connect to MoPilot" | "Press Connect, then click Allow in MoPilot." | "Connect" (`connect`) |
| unauthorized | no | same as unpaired | same | "Connect" |
| updateExtension | no | "Extension Update Required" | "Update the extension to keep using MoPilot." | "Update extension" (`update`) |
| updateApp | no | "MoPilot Update Required" | "Update MoPilot to keep using this extension." | "Download MoPilot" (`download`) |
| updating | yes | "Updating…" | "Chrome is installing the new version." | none |
| missing | no | "Get MoPilot" | "Install MoPilot, or open it once, to chat from Chrome." | "Download MoPilot" |

If the background answer carries `error` and the state has no spinner, the error replaces the text (`sidePanel.mjs:211`). A failed button press shows the error in the text slot (`415`). No illustration, no link to help, no explanation of what the extension does here. Related pages: `blocked.html` ("This site is blocked", "Your browser's administrator doesn't allow MoPilot's agents on this site. Your own browsing isn't affected.", Go back) and `mic.html` (section 6.9).

| State | UT | Spec |
| --- | --- | --- |
| connected (no state page, tab chip shown) | `chromeSidePanel` ("until it is connected the panel shows one state and the button that moves it on") | side-panel (`connected: true`) |
| asking / unpaired Connect, then the app's one Allow | `chromeSidePanel` | pairing-in-front, `pairWithAllow` fixture in every spec (the page's strings are not asserted) |
| offline, starting, connecting, update-required (both), updating, missing | `chromeSidePanel`, `chromeExtensionUpdates` | none |

### 3.2 First run: consent, then intro

`#welcome` replaces the chat and hides the composer until both steps are done (`show`, `sidePanel.mjs:192-194`; `PanelWelcome.blocking`, `panelWelcome.mjs:74-76`). Storage keys `panelConsent`, `panelIntro`, `panelPinTip` in `chrome.storage.local` (`panelWelcome.mjs:4`). If storage cannot be read the steps show again (60-65).

Consent (`panelWelcome.mjs:7-14`, html:44-48): h2 "Before you start"; three items (strong title, 13px muted line, `sidepanel.css:173-175`):

1. "Agents act in your Chrome" / "They open pages, click and type in the tabs they use, signed in as you."
2. "Pages can try to steer them" / "A site can hide instructions meant for the agent. Watch what it does on sites you don’t trust."
3. "Agents can make mistakes" / "Check purchases, messages and other actions that matter before they go through."

Button "I understand" (primary).

Intro (`panelWelcome.mjs:17-20`, 111-117): two slides, title + text + dots (`● ○`, letter-spacing 4px, muted) + button:

1. "Chat from Chrome" / "Ask about the page you’re on. The chat is the same one in MoPilot." (button "Next")
2. "A tab group per chat" / "Tabs an agent opens stay together in a group named for its chat." (button "Let’s go")

Text-only; no images or per-slide illustrations; no skip.

Pin tip `#pin-tip` (html:101): margin 0 12px 8px, padding 8 10, 1px line, radius 8, 12px, flex: "Pin MoPilot for quick access: open Extensions in the toolbar, then pin it." with × (aria "Dismiss"). Shown while `chrome.action.getUserSettings().isOnToolbar === false` and not dismissed; hides on `onUserSettingsChanged` (`panelWelcome.mjs:53-55,121-128`). It sits at the bottom, below the composer.

| State | UT | Spec |
| --- | --- | --- |
| Consent (3 risks, composer hidden), I understand, both slides, Let's go | `chromePanelWelcome` | side-panel (`firstRun`), and `completePanelFirstRun` fixture in all other panel specs |
| Storage unreadable shows consent again | `chromePanelWelcome` | none |
| Pin tip show / dismiss / auto-hide | `chromePanelWelcome` | none |

---

## 4. Empty state

`#empty` (html:56-58): centered 40x40 `icons/icon-128.png`, `opacity .18`, `grayscale(1)` (`sidepanel.css:51`). Nothing else: no greeting text, no suggestions, no recent-chat shortcuts. The only prompt is the composer's placeholder, "How can I help you today?" (`panelConnection.mjs:3`). Shown when connected, first run done, no chat open (`sidePanel.mjs:197`). A new chat's composer additionally shows the project chip (section 5.9) when a project was picked in the sidebar.

| State | UT | Spec |
| --- | --- | --- |
| Empty mark, placeholder, model menu present, no horizontal overflow | `chromeSidePanel`, `chromePanelMenus` | design (asserts `.empty-mark`, placeholder, id list, no overflow, screenshot), side-panel, per-tab ("another tab starts empty") |

---

## 5. Composer

DOM: `<form id="composer">` (html:68-100), `margin 6px 12px 8px`, grid, `gap 6px`, `position relative` (`sidepanel.css:102,155`). Children, in order: usage banner (5.10), `.composer-card`, footer line.

### 5.1 Card

`.composer-card`: radius 16, padding 12, grid gap 8, background `--card`, shadow `0 2px 10px rgb(0 0 0 / .08), 0 0 0 .5px rgb(0 0 0 / .08)` (no visible border, `sidepanel.css:103`). Inside, top to bottom: `#notice` (tab notice, 5.11), `#attached` chips, `#skills` chips, the `/` and `@` menus (absolute, above), `<textarea id="text">`, the menus for model, permission and +, then `.row`, then `#error`, then `#copy-notice`.

### 5.2 Textarea

`rows=2`, placeholder "Ask anything" (new chat) or "Write a message…" (open chat) (`sidePanel.mjs:202`), aria "Message". CSS: no border, no outline, `resize: none`, transparent, `font: inherit` (13px), `min-height 44px`, `max-height 180px`, `line-height 1.5`, padding `1px 0` (`sidepanel.css:108`). `autosize()` sets `height:auto` then `height = scrollHeight` on every `sync()` (`panelAutosize.mjs:4-8`, called from `sidePanel.mjs:252`), so it grows from 44px to 180px and then scrolls; it shrinks again when text is removed. No drag handle.

Draft: kept per tab in `chrome.storage.session` (`panelDraft:<tabId>`), debounced 250 ms, flushed on `pagehide`, restored when the panel reopens, preserved across tab replacement (`ext/src/panelTab.mjs:149-201`, `ext/src/panelState.mjs`). Over 100,000 characters: "This draft is too long to save. Keep the panel open and shorten it." (`panelState.mjs:41`). Selected text from the page context menu "Ask MoPilot" is appended after a blank line (never sent), `ext/src/contextMenu.mjs`, `panelTab.mjs:159-171`.

### 5.3 Row: plus, permission, project chip, model, mic, send/stop

`.row` flex, `gap 6px`, align center (`sidepanel.css:109`). Left to right: `#plus`, `#perm`, `#project` chip, spacer, `#model`, `#mic`, `#send`/`#stop` (html:86-95).

- `#plus` `.icon` 28x28, glyph "+", title and aria "Add files and more". Opens `#plus-menu` (5.6).
- `#perm` `.pick` pill (5.5). Hidden until options load, disabled with no permission block.
- `#model` `.pick` (5.4), `font-size 11px`, `padding-right 0`, `max-width 44%`.
- `#mic` `.icon.mic`, 28x28, svg microphone (5.8).
- `#send`: 28x28, radius 8, `--btn` fill, glyph "↑", aria "Send"; `:disabled` opacity .4 (`sidepanel.css:114-115`). Disabled when sending, an attachment is uploading (`attach.busy`), the text is empty, or a new chat has no harness (`sidePanel.mjs:254`).
- `#stop`: same 28x28 box but outlined 1px `--fg`, transparent, with a 9x9 filled square drawn by `::after` (`sidepanel.css:116-118`), aria "Stop", title "Stop". Replaces Send only when a chat is open, its turn is `running` and the box is empty (`sidePanel.mjs:256-258`). Typing while a turn runs puts Send back, and Send then queues a follow-up that runs after (or steers into) the turn. There is no "Stopping…" state in the panel: Stop calls `stop` then re-reads the chat (`sidePanel.mjs:454-461`).

Pick buttons (`.pick`): no border, transparent, muted, 12px, padding `4px 6px`, radius 6, ellipsis, `max-width 45%`, hover `--soft` (`sidepanel.css:130-132`).

### 5.4 Model / effort / harness menu

`#model` label: `"<model label> <effort label>"` (e.g. "Fake Opus High"), or the harness name when no model is known, or "Choose model" (`panelMenus.mjs:104-105`). Opens `#model-menu`. All composer menus (`.menu`) are absolute above the card: `bottom 100%`, `left/right 8px` of the composer, `max-height 60vh`, scroll, `--bg`, 1px line, radius 10, shadow `0 6px 24px rgb(0 0 0 / .14)`, padding 6, z-index 5 (`sidepanel.css:156`). One menu open at a time (`PanelMenus.close`, `panelMenus.mjs:80-85`); there is no outside-click close for these menus (only a second click on the same button, or picking), and Escape does not close them (Escape handlers exist only for `/`, `@` and the header menu).

Rows (`panelMenus.mjs:144-180`), all `role=menuitemradio`, `.menu-item` (column, padding `6px 8px`, radius 6), selected row gets a trailing " ✓" (`.on > span::after`), 11px muted `small` for detail:

1. `h4` "Harness" (11px uppercase muted) and one row per usable harness, only when more than one (`this.harnesses.length > 1`). The harness a pending switch goes to shows "From your next message". For a new chat the pick sets the new chat's harness; for an open chat it calls `switch` and the chat moves on its next message (`panelMenus.mjs:220-235`).
2. `h4` "Model", then each non-"more" model with its description as detail.
3. "More models" / "Fewer models" toggle (muted, `aria-expanded`) when there are more.
4. `h4` "Effort" and the effort rows for the selected model, shown only if the model has efforts. A model pick keeps the effort when the new model has it, else the model's default.

Opening the menu asks for the harness list again (`panelMenus.mjs:93`, `PanelHarnesses.refresh`); an answer with no harnesses leaves the list as it was; a failure goes to the error line (`panelHarnesses.mjs:39-47`). For an open chat the model is the chat's own; a plain Send never re-applies the panel's menu pick (`panelMenus.mjs:46-49`, `observe` 52-58). Failure to load: error line with main's message.

### 5.5 Permission menu

`#perm` shows the checked row's label, or "Set by <harness>" (disabled) when the harness has no modes (`panelMenus.mjs:106-112`). Pill: 1px line, radius 999, padding `4px 22px 4px 8px`, `max-width 38%`, chevron absolutely placed `right 8px` in the padding (`sidepanel.css:133-135`). Menu: `h4` with the block's title (e.g. "What MoPilot can do"), one row per mode with label, 11px detail, `✓` on the current one; a mode the model cannot take is disabled with its reason as detail. Picking "Full access" (when not already) first shows `h4` "Full access can edit files, run commands and act on websites without approval." and a row "Enable Full access" / "Only continue if you trust this task."; only that second row applies it (`panelMenus.mjs:186-191,237-257`). Closing or switching target retires the confirmation.

### 5.6 Plus menu and attachments

`#plus-menu` rows: "Add a screenshot of this tab", "Add files", and a tab line: favicon (14px) + page title + button "Don't include this tab" / "Include this tab" (`aria-pressed`) (html:80-84, `sidePanel.mjs:259-266`). The tab chip is hidden when no web page (http/https) is in front (`tabOf`, `sidePanel.mjs:32-36`); it follows the tab in front, resets to included on another tab, and goes with the message as `{ tab: { id, url, title } }` (`sidePanel.mjs:325-329`).

Attachments (`ext/src/panelAttach.mjs`): at most 10 per message (`MAX_FILES`, "Add up to 10 files."). Screenshot goes through the background's debugger capture and is named "Screenshot.png"; with no web page: "Open a web page to add a screenshot of it."; failure: "MoPilot can't take a screenshot of this page." (67-77). Picked files are read as data URLs and kept by main (`chromePanelFiles.cjs`). Pasted image: png/jpeg/gif/webp only, named "Pasted image.png" (or .jpg etc.); a paste that also carries plain text is left to the box (40-49). Chips (`.chip.file`): pill, 1px line, 12px, name with ellipsis and a "×" button (aria "Remove <name>"); while uploading, a muted "Adding…" chip. Send waits for uploads. Chips clear once the message is accepted.

### 5.7 Slash and mention menus

`/` (`ext/src/panelSlash.mjs`): opens only when the whole text is `/name` at the start (`^\/([\w:.-]*)$`). Lists the harness's commands and skills (read once per target, shared across keystrokes), names that start with the query first, then ones that contain it, at most 8 rows. Row: `/name hint` plus description (11px muted). Keys: ArrowDown/ArrowUp wrap, Enter or Tab pick, Escape closes; IME composition is passed through. A command inserts `/name ` in the box; a Codex skill becomes a chip `/name` (monospace) and the box clears. Empty: "No commands here." Listbox aria "Commands".

`@` (`ext/src/panelMention.mjs`): opens on `@` at the start or after whitespace before the caret. Lists this window's http(s) tabs (title + address) then recent chats (detail "Chat"), up to 5 of each, filtered by substring. A pick writes a token (`[Title](mopilot-tab://chrome?tabId=…&url=…)` or `[Title](session://id)`) and a space; user bubbles show it as `@Title` (`named`). Empty: "No tabs or chats match." Same keys as `/`. Listbox aria "Tabs and chats".

### 5.8 Mic / Dictate

`ext/src/panelDictate.mjs:5-10`: labels "Dictate" (idle), "Starting…", "Stop dictating" (recording, `aria-pressed=true`), "Transcribing…". Styling: `.mic.recording` red `#d33` fill, white glyph, radius 999; `.mic.transcribing` opacity .55; disabled while starting or transcribing (`sidepanel.css:170-171`). One click records (`MediaRecorder`, webm/opus; cap 120 s auto-stop, line 130), a second stops, main transcribes on its dictation services in turn, and the text is appended after what is typed with a space and the box is focused (`sidePanel.mjs:159-165`). The panel cannot show Chrome's permission prompt, so a refused microphone opens `mic.html` ("Allow the microphone for Dictate", "Chrome asks once. Your voice is sent to MoPilot to be written out, as Dictate does in the app.", button "Allow microphone") and says "Allow the microphone in the tab that opened, then dictate again." Other errors: "No microphone found.", "The speech input owner changed. Dictate again.", "Couldn't transcribe the recording". `mic.html` results: "Microphone allowed. Close this tab and dictate in the side panel." / "Chrome blocked the microphone. Allow it for MoPilot in Chrome’s site settings, then try again." / "No microphone found." No waveform, no timer, no cancel (discard) action.

### 5.9 Project chip, notice, error, copy notice, footer

- Project chip (`#project`): pill "In <project>" with × (aria "Not in this project"), only on a new chat after a project was picked in the sidebar (`sidePanel.mjs:204-205`). Resets the `/` list.
- Tab notice (`#notice`, `ext/src/panelNotice.mjs`, text in `ext/src/tabNotices.mjs:11-15`): amber 1px border (`--wait`), radius 8, 12px, padding `6px 8px`, role=status. Two texts: "Your browser's administrator doesn't allow agents on this site." and "Another extension is blocking this page, such as a password manager or a recorder. Close its menu or turn it off for this site, then retry." with a "Retry" button (reloads the tab without the other frame).
- Error line `#error` (role=alert): 12px `--error`, max-height 30vh, scrolls. Plain text from main or the panel; cleared on opening or starting a chat. A message that could not be sent and is no longer in the box becomes a persistent `<details open>` block "Message needs review" with the reason, "Message: <text>", a "Copy message" button (aria "Copy retained message") and "Dismiss" (`ext/src/panelErrors.mjs:21-48`, `sidepanel.css:119-124`). It survives chat changes until dismissed.
- Copy notice `#copy-notice` (role=status, polite): 12px muted, collapses to 0 height when empty; shows "Copied" for 2 s, or the clipboard error ("Copy is unavailable in this browser.") (`panelChrome.mjs:155-178`).
- Footer: "MoPilot uses AI and can make mistakes. Please double-check responses." 10px/1.4 muted, centered, always shown under the card (`html:99`, `sidepanel.css:182`). Not a link; no privacy or terms link.

### 5.10 Usage banner

`#usage` (html:69, `panelChrome.mjs:82-89`): shown above the composer card, inside the form, when the open chat's read carries `limit` (`app/chromePanelIdentity.cjs:36-39`). Text: "Usage limit reached on <account label>." (`session/caps.cjs:411-415`; only for an actually exhausted account of the chat's current login). Style: flex, gap 8, `margin 0 0 8px`, padding `8px 10px`, radius 9, `--soft` background, 12px (`sidepanel.css:184-185`), with × (aria "Dismiss usage notice"). Dismissal is keyed by `[chatId, limit key]`; another chat, another account or a new limit shows it again. It has no reset time, no "switch account" or "upgrade" action, and does not offer to continue.

### 5.11 Keyboard in the composer

Enter sends; Shift+Enter inserts a newline; Enter during IME composition does nothing (`sidePanel.mjs:441-448`). With a `/` or `@` menu open, Enter/Tab pick, arrows move, Escape closes (menu keys handled first, 442-443). No ArrowUp-to-recall-last-message, no Cmd+Enter to send, no Escape-to-stop.

Coverage for section 5:

| State | UT | Spec |
| --- | --- | --- |
| Placeholder both variants | `chromePanelMenus`, `chromeSidePanel` | side-panel (new), design (new and "Write a message…") |
| Box grows, no resize handle, 180px cap, shrinks | `chromePanelComposerLook` | composer-look |
| Send with Enter, harness picked last, turn shows under it | `chromeSidePanel` | side-panel, per-tab, all send-driven specs (via `requestSubmit`) |
| Send disabled states, Send/Stop swap, Stop ends turn | `chromeSidePanel`, `chromePanelThread` | side-panel (Stop, then "Done"), design (`#stop`) |
| Queue a follow-up while running | `chromePanelThread` | none |
| Model menu: effort pick shown on button | `chromePanelMenus` | side-panel (`menus`), design |
| Harness rows, switch pending "From your next message", chevron mask 10px, label with ellipsis | `chromePanelMenus`, `chromeSidePanel` | harness-switch |
| Harness list asked again on opening | `chromePanelHarnessRefresh` | none |
| Permission menu rows, checked row, title "What MoPilot can do" | `chromePanelMenus`, `chromePanelPermissionPresets` | side-panel, harness-switch, design (Ask for approval) |
| Full access second confirmation | `chromePanelMenus` | none |
| "Set by <harness>" disabled variant | `chromePanelMenus` | none |
| + menu opens, two items visible | `chromePanelAttach` | side-panel (`composerMenus`) |
| Add a screenshot (chip, errors), Add files, 10-file cap, "Adding…" | `chromePanelAttach` | none |
| Paste image chip "Pasted image.png×", text paste left alone | `chromePanelAttach` | paste-image |
| Tab chip follows front tab; title shown | `chromeSidePanel` | side-panel, current-tab, financial (asserts `#tab-title`) |
| "Don't include this tab" toggle | `chromeSidePanel` | none |
| `/` menu opens, Escape closes | `chromePanelSlash` | side-panel |
| `/` arrows, Enter pick, skill chip | `chromePanelSlash` | none |
| `@` menu lists tab, pick writes token | `chromePanelMention` | side-panel |
| `@` chats rows, arrows, Tab | `chromePanelMention` | none |
| Mic / Dictate (all states), `mic.html` | `chromePanelDictate`, `chromePanelDictateUI` | none |
| Project chip | `chromePanelSidebar` | none |
| Tab notice (admin, other extension, Retry) | `chromeExtensionTabNotices` | foreign-frame (the frame guard and the reload, not the panel's line) |
| Error line, "Message needs review", Copy message | `chromePanelErrors` | design (retained message, Copy, "Another action failed") |
| Copy notice "Copied" | `chromePanelPresentation` | design |
| Footer line | `chromeSidePanel` | design (asserts text) |
| Usage banner and dismiss | `chromePanelPresentation`, `chromePanelMetadataUI`, `chromePanelLimitState` | none (the limit spec asserts the note row and progress line, not the banner) |
| Draft kept per tab across reload | `chromePanelTab`, `chromePanelState` | per-tab |
| Ask MoPilot (context menu) draft | `chromePanelTab` | none |

---

## 6. User bubble and its tab line

`.you` (`sidepanel.css:60,62-63,146-147`): `align-self flex-end`, `max-width 85%`, `--soft` background, radius 14, padding `7px 11px`, `white-space: pre-wrap`, `overflow-wrap: anywhere`; 13px sans. No avatar, no name, no timestamp, no edit or retry. Text goes in as text; mention tokens show as `@Title` (`panelThread.mjs:298`, `panelMention.mjs:8`).

Tab line `.tab` inside the bubble (`panelThread.mjs:300,355-361`): the site's host (`new URL(url).host`, or the string itself when not parseable), 11px muted, `margin-top 4px`, one line with ellipsis, prefixed "↗ " via `::before`, `title` = full URL. Taken from the message's Chrome-tab marker (`shared/userText.mjs`); the agent-only handoff line is never shown.

Long messages: over 600 characters become `<details class="message-fold">` whose summary is the first 180 code points plus "…", opened state kept across reads (`panelMessage.mjs:17-29`); when main clipped a message (20,000 characters) the Copy button reads "Copy shown text" and the aria says the message is truncated (30).

Copy button (`.message-copy`, `panelMessage.mjs:2-13`): text "Copy" (via `::before` from `data-copy-state`), 11px muted, no border; `opacity 0` until the bubble is hovered or the button is focused. On a bubble it is `position absolute; top 100%; right 0`, so it takes no height and sits under the bubble; `pointer-events none` until hover (`sidepanel.css:146-149`). The button copies the exact row text; label becomes "Copied" for 2 s (`panelChrome.mjs:155-178`). A message sent from here appears immediately and stays until a read has it (`panelThread.mjs:26-30,160-174`); one main refuses returns to the box with the reason.

| State | UT | Spec |
| --- | --- | --- |
| Bubble text, tab line host, hover title | `chromePanelThread` | side-panel (tab text equals host; bubble text equals message plus host) |
| Bubble has no blank row; Copy out of flow | `chromePanelBubbleSpace` | bubble-space |
| Long-message fold, truncated copy label | `chromePanelPresentation` | none |
| Immediate echo, refused message returns to box | `chromePanelThread`, `chromePanelSendDraft` | none |

---

## 7. Assistant rendering

`.reply` (`sidepanel.css:64-76`): serif 16px, no bubble, no avatar, full width. Built from the Markdown subset in `ext/src/panelMarkdown.mjs` as DOM nodes; text is never HTML. Supported: paragraphs (a single newline is a `<br>`), headings `#`..`######` (all rendered as one `p.h`, weight 600, same size), `-`/`*`/`1.` lists (loose lists stay one list, ordered lists keep their start number; no nesting, no task lists), fenced code blocks (no language label, no highlighting), GFM tables, inline `code`, `**bold**`, `*italic*`, `[text](url)` for http(s) only (new tab, `noopener noreferrer`; any other scheme stays text). Not supported: blockquotes, horizontal rules, images, strikethrough, math, nested lists, autolinks of bare URLs.

Spacing: `p, ul, ol, pre` margin `0 0 8px`; lists `padding-left 20px`. Inline code: 12px mono, `--soft`, radius 4, padding `1px 4px`. Code block: `--soft`, radius 8, padding `8px 10px`, `overflow auto` (scrolls sideways), each block carries a Copy button floated right inside it (`.reply pre .message-copy {float:right}`, aria "Copy code", copies the code alone). Tables: wrapped in `.table` (`overflow-x auto`), 12px, collapsed borders `1px --line`, cell padding `4px 8px`, `min-width 4em`, header 600 on `--soft`, left aligned (column alignment colons are ignored). Links inherit text color (underlined by default). A reply's Copy row is a visible block (`display:block`, opacity 0 until hover) below the reply, copying the whole reply.

While streaming, the text lands in `#live` (`white-space pre-wrap`, plain text, not Markdown, `panelThread.mjs:235-239`) until a read of the chat holds the reply as a row; it then re-renders as Markdown, so the live reply is raw text (asterisks, pipes) until the read swaps it. The live text is reconciled against rows by `unread()` (`ext/src/panelPreview.mjs`, whitespace-insensitive overlap) so it does not double up. There is no cursor, no per-token fade, no skeleton.

Row limits: main returns the recent end, at most 200 displayed blocks, 2,000 steps and 400,000 characters; 20,000 characters per message (`capabilities/browser/chromePanelLive.cjs:19-26`). When older rows were left out, a centered 12px muted line "Earlier messages are in MoPilot." heads the list (`panelThread.mjs:270-275`); there is no "load earlier" action in the panel.

Note rows (`.note`, role `note`): 12px muted, centered; used for "account moved" and the usage-limit note (section 11).

| State | UT | Spec |
| --- | --- | --- |
| Paragraphs, headings, lists, ordered list start, code block | `chromePanelMarkdown` | side-panel, design, readability (ordered list, 3 items; numbering restarts guarded) |
| Table in scroll box | `chromePanelMarkdown` | side-panel, design, readability (1 table, no horizontal overflow) |
| Inline code / bold / italic / web link, other links as text | `chromePanelMarkdown` | none |
| Code block Copy button and "Copied" | `chromePanelPresentation` | design |
| Reply Copy row (whole reply) | `chromePanelBubbleSpace` | none |
| Live preview then replaced by row | `chromePanelThread`, `chromePanelPreview` | side-panel (records `#live`), readability |
| "Earlier messages are in MoPilot." | `chromePanelThread` | readability (history kept; the line itself is not asserted) |
| 40k-character reply, no overflow | `chromePanelPresentation` | readability |

---

## 8. Steps and folds

Each tool call is a row `.step` (12px muted, flex, gap 6, `sidepanel.css:77-78`): a 5px dot (`::before`, muted) then one line of text. Text comes from main (`capabilities/browser/chromePanelLive.cjs` `stepOf`, `toolLine`): "Ran <command first line or the model's description>" / "Ran a command", "Edited a.md, b.html and 2 more" / "Created ...", "Searched for <q>" / "Searched the web", "Ran a sub-agent", "Updated the plan", Chrome and desktop actions ("Took a screenshot", "Typed text", "Pressed keys", "Scrolled", "Hovered over the page", "Zoomed in", "Dragged", "Waited", "Clicked", "Opened <host>", "Went back", "Reloaded the page", "Checked the open tabs", "Opened a new tab", "Closed a tab", "Switched tabs", "Kept a tab open for you", "Read the page", "Searched the page", "Filled in a field", "Ran a script on the page", "Took several steps", "Read the console", "Read network requests", "Resized the window", "Uploaded a file", "Handed the tab to you", "Opened an app", "Asked to use apps", "Used the browser"), another server's tool as "Used <server>/<tool>", else "Used <tool>" / "Used a tool". MoPilot's own tools use the app's lines from `shared/ownToolLines.mjs`: running "Wrapping up", done "Wrapped up", failed "Couldn’t wrap up" (same for each own tool, e.g. "Updated task list", "Marked a chapter", "Searched memory"). Reasoning and tool results without a short form are dropped.

Details: a step with input/result text or a screenshot is `<details class="step">` (`panelStep.mjs:12-42`): summary is the line; body is `<pre>` ("Input (preview)" JSON, "Result (preview)" text, max 4,000 characters, `max-height 220px`, scroll, `sidepanel.css:189`) and an inline `<img class="step-thumbnail">` (alt "Screenshot returned by this step", `max-width 100%`, `max-height 200`, radius 6) for Chrome tools. Only the latest current-turn screenshot is kept (`clipRows`). Open state is kept by row key across reads.

Folds: a run of 2 or more consecutive steps (or one step that carries `workedMs`) is one `<details class="steps">` (`panelThread.mjs:283-287,331-352`). Summary text:

- while the turn runs: "<N> steps · <latest step text>" (e.g. "6 steps · Used a tool");
- after a finished turn with exactly one run of steps, completed status and `durationMs >= 1000`: "Worked for 11s", "2m 5s", "1h 3m" (`workedFor`, `panelStep.mjs:4-10`; stamped in `chromePanelLive.cjs` rows loop). Not shown for several runs, a running, stopped or failed turn, no or sub-second duration.

Fold styling: `font-family system-ui`, summary cursor pointer, no marker, trailing chevron rotated -90deg (open: 0deg); opening adds `margin-bottom 6px`; children `margin 0 0 4px 11px` (`sidepanel.css:80-86`). Default closed; state kept across reads, keyed by the preceding row and first step (or the run id). Clicking a summary turns off auto-follow (`panelChrome.mjs:50-52`).

A lone step stays a plain line (no fold, no chevron).

| State | UT | Spec |
| --- | --- | --- |
| Fold of several steps with the latest named, lone step stays a line | `chromePanelSteps` | design (summary click) |
| Open state survives refresh, duplicates independent | `chromePanelSteps`, `chromePanelStepDetails` | none |
| Step line "Ran npm test" with Input pre | `chromePanelStepDetails` | side-panel, design (`pre` contains "Input") |
| Screenshot thumbnail in step | `chromePanelStepDetails` | design (1 `.step-thumbnail`) |
| "Worked for Ns" | `chromePanelWorkedFor` | worked-for |
| Own-tool wording ("Wrapped up") | `chromePanelOwnTools` | none |
| Chrome / desktop tool step vocabulary | `chromePanelLive`, `chromePanelSteps` | none (a few lines appear incidentally in design and side-panel) |

---

## 9. Progress line

`<p id="progress" class="progress">` at the bottom of `#chat`, after rows, live text and cards (html:65). Flex, gap 8, muted, margin 0 (`sidepanel.css:100`). Parts, left to right: `#progress-dot` (8px dot, class `dot wait|ok|error`), `#progress-text`, `#elapsed` (nowrap), `#activity-count` (11px, `margin-left:auto`), `#activity-thumbnail` (32x24, `object-fit cover`, radius 4, hidden unless a screenshot exists). The line is inside `#chat`, so it exists only with a chat open, and it never leaves (Done stays under the last row). It is not sticky: it scrolls with the thread.

States (`panelThread.mjs:18-24`, `246-260`; `panelChrome.mjs:113-153`):

| Text | Dot | When | Extras |
| --- | --- | --- | --- |
| "Working…" | amber (`wait`) | turn `running` | `#elapsed` "Watching 12s" (observed in this panel since it saw the turn start, ticks each second), `#activity-count` "+N" when the latest run has more than one step, thumbnail of the latest screenshot |
| "Using your Chrome" | amber | running and the latest step or run carries `surface=chrome` | same extras |
| "Waiting for you" | amber | turn `waiting` (an approval or a question card is up) | no elapsed |
| "Done" | green (`ok`) | turn `idle` | no elapsed |
| "Limit reached" | red (`error`) | idle and the last row is a limit note (`limit:true`); stays until another turn runs; another chat's limit is not carried over | no elapsed; the usage banner is separate |

Not present: no "Stopped" (a stopped turn reads "Done"), no failed or error state for a turn that crashed (it reads "Done" plus whatever note rows exist), no "Reconnecting" or offline line inside the chat, no "Thinking" state, no per-step live text in the line, no token or cost line. A stalled stream shows the last "Working…" with a growing "Watching Ns".

Elapsed text is local: "Watching <s>s" counted from when this document first observed a running line (`panelChrome.mjs:133-135`; a panel opened mid-turn starts at 0; the tooltip says "Elapsed time observed in this panel"). It is not the turn's real duration and is never shown after the turn ends; the "Worked for" label replaces it in the fold.

Auto-follow: the thread follows the bottom unless the user scrolls more than 80px up; a 32px circular "↓" button (`#jump`, aria "Scroll to latest message", `bottom` computed from the composer's top + 8) appears when more than 80px from the bottom (`panelChrome.mjs:44-48,96-111`, `sidepanel.css:141`). Auto-follow does not scroll while a hold-to-confirm card is pressed. Scroll jumps use `behavior: 'auto'` (instant).

| State | UT | Spec |
| --- | --- | --- |
| Working… | `chromePanelThread`, `chromeSidePanel` | side-panel |
| Using your Chrome, thumbnail, "+N" | `chromePanelPresentation` | design ("Using your Chrome", 1 thumbnail with data: src) |
| Waiting for you | `chromePanelThread` | side-panel, design |
| Done | `chromePanelThread` | side-panel, worked-for, harness-switch, financial |
| Limit reached, red dot, "not Done" | `chromePanelLimitState`, `chromePanelOwnTools` | limit |
| "Watching Ns" elapsed | `chromePanelPresentation` | none |
| Jump button, auto-follow rules | `chromePanelPresentation` | none |

---

## 10. Approval and question cards

All cards live in `#cards` (grid, gap 8), between the live reply and the progress line (html:64). `.card`: 1px `--line`, radius 10, padding `10px 11px`, grid gap 8 (`sidepanel.css:91`). Parts (`ext/src/panelCards.mjs:48-266`): `.q` (600) title; optional `<pre>` detail (12px mono, muted, `max-height 140px`, scroll); form fields; link "Open <url>" (http/https only, new tab); `.choices` grid of buttons (13px, padding `8px 10px`, radius 8, left aligned). The first choice, when not a deny, is `.primary` (dark fill); Deny and the rest are outlined. There is no icon, no site favicon, no risk colour, no countdown, no keyboard hint other than the hold tooltip.

Cards come from main as titles, detail and choice keys only; the panel sends back the key and a request version, and main rebuilds the answer against the live request (`capabilities/browser/chromePanelCards.cjs`). Every card carries a version token so a stale answer is refused (`chromePanelEpoch.cjs`).

Card catalog (title; choices):

| Card | Title | Choices |
| --- | --- | --- |
| Codex command | "Run this command?" | "Allow once", "Allow for this session", "Deny" (or with a proposed prefix: "Allow once", "Always allow this prefix" with a second confirm "Permanently allow commands starting with …?", "Deny") |
| File edit | "Allow <agent> to edit files?" | Allow once, Allow for this session, Deny |
| Claude Code tool | "Allow <agent> to use <tool>?" / "Allow <agent> to fetch <url>?" or the tool's own title; detail is the JSON input | same three |
| Plan | "Ready to start on this plan?" | "Approve plan", "Deny". Main sends `plan` ({text, file?, clipped?}); `PanelCards.plan` draws the text as Markdown (`panelMarkdown.mjs`, text only) under the title: 13px, folded to about 12 lines (`max-height: calc(12 * 1.45em)`) with a "Show more" / "Show less" toggle that appears when the lines overflow (measured with a ResizeObserver as the panel resizes; before the first measure, when the text has more than 12 lines), scrollable (60vh) when open; a "Saved as <file>" line and "Only the start of the plan is shown here." when clipped |
| Claude in Chrome tool | "Allow <agent> to <action> on <host>?" | Allow once, a saved-rule label, Deny |
| Basic (ACP) permission | "<agent> wants to: <tool>" / "<agent> is asking for permission" | the harness's own options, Deny |
| Extra permissions | reason or "Allow <agent> additional permissions?" | "Allow for this turn", "Allow for this session", "Deny" |
| MoPilot site (browser origin) | "Allow <agent> to use <origin> in your Chrome?" under a "MoPilot needs your OK" line (`.kicker`), and the reminder "MoPilot asks you first before it buys anything, creates an account, or gets past a CAPTCHA." (`.note`) under the buttons | "Allow once" (Enter), "Allow in this chat", "Always allow on this site" (Cmd/Ctrl+Enter; "Always allow reading on this site" when only reading may be kept), "Decline" (Esc); an "Access level" `<select>` when levels are offered. Choice keys are unchanged (`once`, `chat`, `always`, `alwaysRead`, `deny`) |
| MoPilot app set | "Allow <agent> to use these apps?" | "Allow in this chat", "Always allow", "Deny"; one checkbox per app (default checked) |
| Computer confirm | "Allow <agent> to <verb> in <where>? This can't be undone." | "Allow for this task" (when a task scope exists), "Allow once" (hold), "Deny" |
| Takeover, dev server, terminal, browser permission, vision consent | titled for what they ask (`chromePanelHostCard.cjs`) | "Allow"/"Allow once"/"Allow in this chat"/"Always allow for this site", "Deny" |
| Native Codex browser / app grants | the grant's own message | each offered scope, Deny; "all sites" asks again ("Allow browser access to every site? This permission applies beyond this page." then button "Confirm permission") |
| Question (async) | "A question for you" | "Send", "Skip" |
| MCP form / ACP form | the server's message or "<server> needs input" | "Submit" ("Done" for a URL form), "Decline", "Cancel" |
| Anything unknown | "<agent> is waiting for you in MoPilot." | one button "Answer in MoPilot" (opens the chat in the app) |
| Delivered / busy / another client running | "Your answers are queued for the next turn", "Your answers are waiting to be sent", "These answers were discarded before sending", "Your answers were sent"; detail "Sending your answers…" or "Another client is running this chat. Answer after it finishes."; no choices, controls disabled | (disabled) |

Form controls (`panelCards.mjs:73-143,268-333`): radio (single) or checkbox (multi) per option with the label and a small description; a free-text input ("Other answer" / "Your answer", password type for secrets); typed schema fields (text, number, checkbox, enum `<select>` with "Choose…", textarea for JSON with "Enter valid JSON for this field."); entered values survive refreshes (snapshot by version).

Keys: a choice with a `shortcut` (`enter`, `escape`, `mod-enter`) shows the key on its button (`<kbd>`, hidden from the accessible name; `aria-keyshortcuts`) and answers on a real key press (`PanelCards`, `press`), for the first card only, and only when no menu is open and the focus is nowhere or in an empty message box (never on a control, in the card's own fields or in text being typed; an input method's keys are its own). Only the site permission cards carry shortcuts; the hold choice keeps its Cmd+Enter hold.

Hold-to-confirm: an irreversible choice (computer confirm "Allow once" without a task scope) needs a real press held for `HOLD_MS = 1000` ms, or Cmd+Enter held, on the first card (`panelCards.mjs:4,193-241`). While held the button gets `.holding` (inset 2px `--accent` ring, `sidepanel.css:99`); release, pointer leave, blur, window blur or a hidden document cancels. Tooltip "Hold the button or ⌘↩ to allow". There is no progress fill and no countdown; the ring is static.

Answering disables the buttons; a failed answer re-enables them and puts the reason in the error line. Cards disappear on the next read. The page-side pill and the panel's "Waiting for you" are separate surfaces.

| State | UT | Spec |
| --- | --- | --- |
| Command card, Allow once, then reply and Done | `chromePanelCards`, `chromePanelThread` | side-panel (both harnesses), design |
| MoPilot site card, "Allow in this chat", access level select, "New permissions required", Enter / Esc | `chromePanelCards`, `chromePanelCardControls`, `chromePanelPermissionCard`, `chromePanelPlanCard` | side-panel, design, financial, current-tab, b5-approvals |
| Task scope "Allow for this task", then hold card "This can't be undone." | `chromePanelCardControls` | financial |
| Short hold cancels, full 1 s hold answers | `chromePanelCardControls` | financial |
| Question and MCP form (typed text, multi-select) | `chromePanelCardControls`, `chromePanelNativeQuestions`, `chromePanelAnswers` | forms |
| Plan card (plan text, fold, Show more), prefix confirm, all-sites "Confirm permission" | `chromePanelCards`, `chromePanelCardControls`, `chromePanelPlanCard` | b5-approvals (Claude) |
| File edit card, extra permissions, ACP permission, native grants | `chromePanelCards`, `chromePanelApprovalRecords` | none |
| "Answer in MoPilot" fallback | `chromePanelCards` | none (financial asserts it is absent) |
| Delivered, queued, busy, another client running, stale version | `chromePanelQuestionLifetime`, `chromePanelCardReplies` | none |
| Cmd+Enter hold | `chromePanelCardControls` | none |

---

## 11. Errors, limit, offline, not paired

| Surface | Text | Where | Code | UT | Spec |
| --- | --- | --- | --- | --- | --- |
| Usage-limit note row | the harness's note (fake: "Claude AI usage limit reached"), in the rows where the turn stopped, `.note` 12px muted centered | thread | `chromePanelLive.cjs` statusNote with `kind==='limit'` (`limit:true`) | `chromePanelOwnTools`, `chromePanelLimitState` | limit |
| "Limit reached" line | red dot | progress | `panelThread.mjs:22-23,204` | `chromePanelLimitState` | limit |
| Usage banner | "Usage limit reached on <account>." with × | above composer card | `panelChrome.mjs:82-89` | `chromePanelPresentation`, `chromePanelMetadataUI` | none |
| Account-moved note | the app's note text | thread `.note` | `chromePanelLive.cjs` statusNote `kind==='account'` | `chromePanelOwnTools` | none |
| First read spinner / "Couldn't load this chat." + "Try again" | spinner 18px; after 15 s (`LOAD_MS`) or a failed first read | thread | `panelThread.mjs:39,126-137`, html:60-61 | `chromePanelWelcome` | none |
| Chat gone | "That chat isn't in MoPilot." then back to New chat | error line | `panelErrors.mjs:3-4`, `sidePanel.mjs:73-75` | `chromePanelTab`, `chromePanelHistoryLifetime` | none |
| Request timeout | "MoPilot didn't answer. Try again." (15 s; 60 s for starting a chat; 150 s for a transcription) | error line | `ext/src/panelLink.mjs:8-12,40` | `chromeSidePanel` | none |
| Connection dropped mid-request | "MoPilot went away. Try again." | error line | `panelLink.mjs:76` | `chromeSidePanel` | none |
| Not connected | "MoPilot isn't connected." | error line | `panelLink.mjs:34` | `chromeSidePanel` | none |
| Unconfirmed send | "Delivery is unconfirmed. Check the chat before sending again." | "Message needs review" block | `panelLink.mjs:52`, `sidePanel.mjs:385-394` | `chromePanelSendAdmission`, `chromePanelDelivery` | none |
| Queued / waiting / discarded | "Your message is queued. <reason>", "Your message is waiting to be sent.", "The message was discarded before it reached the harness." | error line (warning) | `app/chromePanel.cjs:309-319` | `chromePanelDelivery`, `chromePanelHoldRetry` | none |
| Page could not join the chat | "The page could not be connected to this chat. <reason>" (e.g. "Another chat is working in this tab. Stop it before moving the tab.", "Update the MoPilot Chrome extension, then send again from this page.") | error line (warning) | `capabilities/browser/chromePanelTab.cjs:21-77` | `chromePanelAdmission`, `chromePanelAdmissionRecovery` | current-tab covers only the success path |
| No harness | "No harness can start a chat now. Check Settings in MoPilot." | error line | `sidePanel.mjs:236` | `chromeSidePanel` | none |
| Panel could not restore tab | "This tab's panel could not be restored. Keep this panel open to preserve your chat and draft." | error line | `sidePanel.mjs:468` | `chromePanelTab` | none |
| Offline / not paired / update / missing | see 3.1 | full-panel state | `panelConnection.mjs` | `chromeSidePanel` | none |

No toast system exists; everything is the single `#error` line, the `#notice` line, or a full-panel state. There is no retry button on a failed turn, no "regenerate", and no error row inside the thread for a turn that failed on the harness (the line reads "Done").

---

## 12. Handoff and sign-in

The panel has no dedicated handoff or sign-in card. What exists:

- Step line "Handed the tab to you" for the `request_signin` tool (`chromePanelLive.cjs` TOOLS table); the tab is the user's own, so the agent stops and the turn goes idle ("Done") or waits.
- Page-side marks for the handoff end of a turn: favicon yellow dot for `waiting` and `handoff`, green dot for `deliverable` (`capabilities/browser/agentTabMark.cjs:30`, `DOT`), cleared when the tab is seen.
- Sending a message with the tab chip attached hands that tab to the chat first (`session.adopt`); a failure surfaces as the warning in section 11 and the agent is told not to reopen the URL (`chromePanelTab.cjs`).
- "Continue in Chrome" from the app's built-in browser is an app-side flow; the panel only receives the resulting chat.
- A site the administrator blocks: `#notice` text (5.9) and the `blocked.html` page for an agent's tab.

No sign-in detection, no "Sign in then click Continue" card, no per-site login status.

| State | UT | Spec |
| --- | --- | --- |
| "Handed the tab to you" step line | `chromePanelLive` (tool table) | none |
| Tab handoff success keeps the existing tab and form state | `chromePanelAdmission` | current-tab |
| Tab handoff failure warning | `chromePanelAdmissionRecovery` | none |
| Continue in Chrome (app to Chrome, then pairing) | `chromeExternalInstall`, `chromeExtensionPair` | chrome-continue (both harnesses), pairing-in-front |
| Favicon marks | `agentTabMark` | side-panel (asserts the `link[data-mopilot-mark]` appears) |
| Blocked page | `chromeExtensionTabNotices` | none |

---

## 13. Tasks and scheduled

Only in the sidebar (section 2) and the header menu's "Scheduled tasks" row. The panel lists tasks (name, next run) and opens the app's Scheduled page on click; it cannot create, edit, run, pause or view runs; the empty greeting no longer lists tasks (`panelWelcome.mjs:1` comment; test "scheduled tasks are fetched on opening history, not on the minimal greeting"). No task-list (todo) view of the agent's own plan: `update_task_list` appears only as a step line ("Updated task list").

| State | UT | Spec |
| --- | --- | --- |
| Scheduled rows, "Paused", Today/Tomorrow format | `chromePanelSidebar`, `chromePanelWelcome` | none |

---

## 14. Tab group title and page-side indicator

Tab group (in Chrome's tab strip): created per chat session, blue (`GROUP_COLOR`, `ext/src/groups.mjs:3`). Title = status mark + chat title (`groupTitle`, `groups.mjs:8`):

| Status | Mark | Source |
| --- | --- | --- |
| running | ⌛ | turn `running` (`app/chromeRelay.cjs:52`) |
| waiting | 🔔 | turn `awaitingUser` |
| done | ✅ | turn `idle` (the mark stays after the turn ends) |
| none | no mark | before any turn status |

Title text: the chat's title, trimmed to 80 characters; the plain name "MoPilot" while the chat has no title; never the chat id (`ext/src/sessions.mjs:90,153`, `capabilities/browser/chromeExtension.cjs:411`, `app/chromeRelay.cjs:332`). The group retitles on every status or title change (`Groups.retitle`). A tab that joins takes the existing group; a closed group is re-made.

Page-side indicator (inside the user's page, from the agent cursor's isolated world with a closed shadow root, `agentControlFrame.cjs:1-30`):

- Glow `.mp-frame/.mp-glow` around the viewport while the agent holds the tab: three inset shadows of `rgba(217,119,87,.7/.5/.2)` at 15/25/35px (`agentControlFrame.cjs:152-155`).
- Pill at bottom center (`bottom 16px`, moves to `top 16px` when the agent acts within 96px of the bottom): `#faf9f5` background, 12px radius, padding `10px 14px`, `.5px` border, warm shadow, 13px/18px system font. Contents: 8px dot (`#d97757` with a 3px halo), then in the plain working state only the "Stop MoPilot" button (the text "MoPilot is working in this tab" exists but is hidden until another state needs the text, `say()` at lines 110-114), Stop button 12px/600. The pill takes no pointer events until the mouse is within 8px.
- Waiting state: dot turns yellow `#facc15`, text "Waiting for your OK", a "Review" button (title "Open this chat in MoPilot") appears.
- Other tabs of the chat's group: no glow, text "MoPilot is active in this tab group", a "Go to tab" button.
- Stop: only a real click; pill text "Stopping…"; after 1,500 ms if the frame is still there: "Stop didn't reach MoPilot. Press Esc there." and Stop is enabled again.
- Favicon marks (`agentTabMark.cjs`): the tab's icon dimmed to 30% under the agent's arrow while it works, a yellow dot while waiting or at handoff, a green dot on a finished deliverable; cleared when the tab is seen.
- Chrome's own "started debugging this browser" bar appears for any tab with an attached debugger; it is Chrome's, not the extension's.

| State | UT | Spec |
| --- | --- | --- |
| Group title ⌛ running | `chromeGroupStatus` | none |
| Group title 🔔 waiting, then ✅ done, never an id | `chromeGroupStatus`, `controlMatrixChromeGroups` | side-panel (polls `^🔔 ` then `^✅ `, asserts no `claude:`) |
| Plain "MoPilot" title with no chat title | `chromeGroupStatus` | none (the spec asserts the negative only) |
| Group color blue, serialized grouping | `chromeGroupSerialization` | current-tab (one group owner) |
| Glow and pill, Stop, "Stopping…", missed Stop | `agentControlFrame` | design (takes `page-indicator.png`, no assertion) |
| "Waiting for your OK" + Review, group role + Go to tab | `agentControlFrame` | none |
| Favicon mark present, dot colors, cleared on view | `agentTabMark`, `agentTabMarkCursor` | side-panel (mark link exists only) |

---

## 15. Per-tab behavior and persistence

Each tab has its own panel (`sidepanel.html?tabId=N`, `ext/src/panelTab.mjs:9-35`); the toolbar button, Cmd/Ctrl+E (`manifest.json` `_execute_action`, mac `Command+E`, others `Ctrl+E`) and the page context menu "Ask MoPilot" open the clicked tab's panel; the extension-wide panel is off, so tabs without one show none (`perTabPanels`). The chat shown is kept per tab in `chrome.storage.session` (`panelChat:<id>`), restored on reopen, cleared on New chat or tab close; a tab replaced by Chrome keeps its chat and draft (`panelState.mjs`). A tab in a chat's tab group opens that chat. A panel without a tab id follows the tab in front.

| State | UT | Spec |
| --- | --- | --- |
| Chat kept per tab, other tab empty, draft and chat restored after reload, New chat forgets | `chromePanelTab`, `chromePanelState`, `chromePanelTabMain` | per-tab |
| Group chat opens from a tab in its group | `chromePanelTab` | none |
| Tab replaced follows | `chromePanelState`, `chromePanelTab` | none |
| Cmd/Ctrl+E shortcut | none found (manifest only) | none |
| Context-menu draft | `chromePanelTab` | none |

---

## 16. Keyboard summary

| Key | Where | Effect | Code | Spec |
| --- | --- | --- | --- | --- |
| Enter | message box | send (ignored while composing) | `sidePanel.mjs:441-448` | all send specs use `requestSubmit` or Send click; Enter itself none |
| Shift+Enter | message box | newline | same | none |
| Enter / Tab / ArrowUp / ArrowDown / Escape | `/` and `@` menus | pick / move (wrap) / close | `panelSlash.mjs:109-123`, `panelMention.mjs:133-147` | Escape in `/` only (side-panel) |
| Escape | header menu | close | `panelChrome.mjs:35-38` | none |
| Cmd+Enter (hold 1 s) | first card with a hold button | allow | `panelCards.mjs:204,220-226` | none |
| Cmd/Ctrl+E | Chrome | open the tab's panel | `manifest.json:15` | none |
| Tab | menus and cards | default browser tab order; no roving focus, no focus trap, no arrow navigation in the model, permission, plus, header or row menus | none | none |
| Escape | model, permission, plus menus, sidebar | nothing (menus close on a second click or a pick; the sidebar closes with its × button or the History button) | none | none |

Focus: `button:focus-visible, select:focus-visible` get `outline 2px solid var(--fg); offset 1px` (`sidepanel.css:129`). The box is focused after New chat, a slash/mention pick and dictation text.

---

## 17. Animations

In the side panel document:

| Element | Animation | Detail |
| --- | --- | --- |
| `.spin` (connection spinner, first-read spinner) | rotate 360deg, 0.9s linear, infinite | `sidepanel.css:52-54`; off under reduced motion |

Everywhere else the panel has none, listed so a gap analysis can rely on it:

- No streaming fade or caret on the live reply; no per-token or per-line animation; the live-to-row swap is instant.
- No step or fold expand animation (native `<details>`); the chevron rotates by class with no transition.
- No menu open/close transition (header, model, permission, plus, slash, mention, row menus), no sidebar slide, no card enter or exit, no toast.
- No progress-dot pulse for "Working…" (the dot is static amber); no shimmer on the progress text; no skeleton rows.
- No smooth scroll (`scrollTo` uses `behavior: 'auto'`); the jump button appears and disappears with no fade.
- No hold-to-confirm fill (static ring).
- No send/stop button morph (hidden/shown swap).
- No transition on button hover (instant `--soft` background).

In the user's page (not the panel):

| Element | Animation |
| --- | --- |
| `.mp-frame` entrance | opacity 0 to 1, 200ms `cubic-bezier(0.19, 1, 0.22, 1)` |
| `.mp-glow` | opacity 1 / .68 / 1 "breathing", 2400ms ease-in-out infinite, starts after 200ms; opacity only |
| `.mp-pill` entrance | opacity 0 and 8px rise, 200ms same easing |
| Overlay leave | whole overlay fades out, 200ms `cubic-bezier(0.8, 0, 0.4, 1)`; 120ms under reduced motion |
| `.mp-stop/.mp-review/.mp-go` hover | background-color 120ms |
| Reduced motion | frame and pill fade 120ms linear; glow, hover transitions off |
| Favicon mark | none (redrawn as a static SVG) |

Chrome's own tab-group title change and the native debugging bar have no extension control.

Coverage: the panel spinner has a UT (`chromePanelWelcome` for the first read spinner) and no spec; the page-side animations have `agentControlFrame` UT for structure and no spec asserting any animation.

---

## 18. States with no real-Chrome spec

Every state below has no assertion in any `tests/e2e/cuj-chrome-*.spec.ts`. The UT column names the unit file that covers it (or "none").

| # | Surface | State | UT |
| --- | --- | --- | --- |
| 1 | Connection page | offline, starting, connecting, update-required (extension / app), updating, missing; their strings | `chromeSidePanel` |
| 2 | Connection page | asking / unpaired page text and Connect button (only the app's Allow side is exercised by `pairWithAllow`) | `chromeSidePanel` |
| 3 | Welcome | storage-unreadable consent re-show; pin tip show, dismiss, auto-hide | `chromePanelWelcome` |
| 4 | Header | "Extension settings" and "Scheduled tasks" rows, title chevron, harness/account meta text (outside harness-switch) | `chromePanelPresentation` |
| 5 | Sidebar | Archived filter, By project, project filter and project-scoped New chat, Scheduled rows and time formats, "Waiting" tag, status dots, row menu "Open in MoPilot", View all, sidebar Extension settings, empty / loading / failed list strings | `chromePanelSidebar`, `chromePanelSidebarMain` |
| 6 | Composer | Queue a follow-up while a turn runs (Send visible during running) | `chromePanelThread` |
| 7 | Composer | Harness list asked again when the model menu opens | `chromePanelHarnessRefresh` |
| 8 | Composer | Full access two-step confirmation; "Set by <harness>" disabled permission pill | `chromePanelMenus` |
| 9 | Composer | + menu: Add a screenshot (chip, errors), Add files (chip, remove ×, "Adding…", 10-file cap), "Don't include this tab" toggle | `chromePanelAttach`, `chromeSidePanel` |
| 10 | Composer | `/` navigation (arrows, Enter pick), skill chip; `@` chat rows, arrows, Tab | `chromePanelSlash`, `chromePanelMention` |
| 11 | Composer | Mic / Dictate in every state, `mic.html` | `chromePanelDictate`, `chromePanelDictateUI` |
| 12 | Composer | Project chip | `chromePanelSidebar` |
| 13 | Composer | Tab notice (admin block, other-extension block with Retry) in the panel | `chromeExtensionTabNotices` |
| 14 | Composer | Usage banner and its dismiss | `chromePanelPresentation`, `chromePanelMetadataUI`, `chromePanelLimitState` |
| 15 | Composer | Ask MoPilot context-menu draft | `chromePanelTab` |
| 16 | Composer | Enter, Shift+Enter, Cmd+Enter hold, Escape in header menu | `chromeSidePanel`, `chromePanelCardControls`, `chromePanelPresentation` |
| 17 | User bubble | long-message fold, truncated "Copy shown text"; immediate echo and a refused message returning to the box | `chromePanelPresentation`, `chromePanelThread`, `chromePanelSendDraft` |
| 18 | Assistant | inline code / bold / italic / link rendering; whole-reply Copy row; "Earlier messages are in MoPilot." line | `chromePanelMarkdown`, `chromePanelBubbleSpace`, `chromePanelThread` |
| 19 | Steps | open state surviving refresh; own-tool wording ("Wrapped up", "Wrapping up", "Couldn’t wrap up"); the step vocabulary beyond the few lines seen incidentally | `chromePanelSteps`, `chromePanelOwnTools`, `chromePanelLive` |
| 20 | Progress | "Watching Ns" elapsed, "+N" activity count; jump button and auto-follow rules | `chromePanelPresentation` |
| 21 | Cards | plan card, prefix confirm, all-sites "Confirm permission", file-edit card, extra permissions, ACP permission, native grants, "Answer in MoPilot", delivered / queued / busy / another-client / stale-version states, Cmd+Enter hold | `chromePanelCards`, `chromePanelCardControls`, `chromePanelQuestionLifetime`, `chromePanelCardReplies`, `chromePanelApprovalRecords` |
| 22 | Errors | usage banner (above), account-moved note, "Couldn't load this chat." + Try again, chat gone, request timeout, connection dropped, not connected, unconfirmed send, queued / waiting / discarded warnings, page could not join the chat (failure), no harness, panel could not restore tab | `chromePanelWelcome`, `chromePanelTab`, `chromeSidePanel`, `chromePanelSendAdmission`, `chromePanelDelivery`, `chromePanelAdmissionRecovery` |
| 23 | Handoff | "Handed the tab to you" step; tab-handoff failure warning; blocked page | `chromePanelLive`, `chromePanelAdmissionRecovery`, `chromeExtensionTabNotices` |
| 24 | Scheduled | all (sidebar list only) | `chromePanelSidebar` |
| 25 | Group / page | group title ⌛ running; plain "MoPilot" title; page pill "Waiting for your OK" + Review, group-role "Go to tab"; Stop flow ("Stopping…", missed Stop); favicon dot colors and clearing; every page-side animation | `chromeGroupStatus`, `agentControlFrame`, `agentTabMark` |
| 26 | Per tab | group chat opens from a tab in its group; tab replacement; Cmd/Ctrl+E shortcut | `chromePanelTab`, `chromePanelState`; the shortcut has no UT |
| 27 | Animation | the panel spinner (the only panel animation) | `chromePanelWelcome` |

Facts a gap analysis should not miss, taken from the code above:

- (Closed in B5, #3046) The plan-approval card used to show only a title and two buttons; it now draws the plan (section 10).
- The panel has no brand header, no per-message avatars, no streaming animation, no turn failure state, no sign-in card, no task-list view, and no menu keyboard navigation beyond `/` and `@`.
- The live reply is plain text until a read replaces it with Markdown; headings render at body size; nested lists, blockquotes and images are not rendered.
- "Done" is also what a stopped or failed turn reads, except an account limit ("Limit reached").
- "Watching Ns" counts from when this panel saw the turn, not from the turn's start.
- Model, permission and plus menus close only by a second click or a pick (no Escape, no outside click).
