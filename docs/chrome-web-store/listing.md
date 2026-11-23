# Chrome Web Store listing (draft)

MoPilot's own Chrome extension (`electron/chrome-extension`, design D5, B2 step 2 in
control-plane/design.md) as it is submitted to the Chrome Web Store. Tracked on #1632.

## The package

`npm run build:chrome-extension -- --store` checks the manifest and writes `dist/chrome-extension-store` and
`dist/chrome-extension-store-<version>.zip`, the file to upload. It differs from the unpacked build only in:

- **No `key`.** The store refuses a manifest with one and assigns the extension its own id when the item is
  created. MoPilot accepts that id beside the dev key's (`EXTENSION_ID`) once it is configured.
- **The version** is the store's own, `STORE_VERSION` in `scripts/build-chrome-extension.mjs`, bumped once per upload:
  each upload needs a higher `version` than the last one. 0.3.0 was submitted first, then 0.3.1 to 0.3.5 (0.3.5: the
  panel's parity pass with Claude's and ChatGPT's, B1 to B6); 0.3.6 (the empty state's tip cycle, dark mode tokens, the
  refusal card and the usage banner's approaching and limit-reached states, plan links in the link colour, and the
  pairing that asks again after a refused host) is the next. An upload while a version is in review
  cancels that review, so the next one waits for the approval.

The icons are `electron/chrome-extension/icons/icon-{16,32,48,128}.png`, scaled from `build/icon.png` (the app's
icon, with its own transparent margin). The build fails when one is missing.

## Store fields

- **Name:** MoPilot
- **Summary (132 characters at most):** Chat with MoPilot's agents from Chrome's side panel. They work in the tabs they open, one tab group per chat.
- **Category:** Developer Tools
- **Language:** English

**Description:**

> MoPilot is a desktop app that runs coding agents (Claude Code, Codex and other ACP agents). This extension
> lets those agents work in your own Chrome when you ask them to: open a page, read it, click and type, take a
> screenshot.
>
> - Chat from Chrome's side panel: click the toolbar button or press Cmd+E (Ctrl+E on Windows and Linux). Start a
>   chat with the page you are on, pick up a recent one, choose the agent, model and permissions, add files or a
>   screenshot of the tab. The chats are the same ones as in the app.
> - Select text on a page, right-click and choose Ask MoPilot: the side panel opens with the text in its message
>   box, ready to edit.
> - Agents only use tabs they open themselves. Each chat gets its own tab group, titled for the chat. Your other
>   tabs are never attached or read.
> - It works only with the MoPilot app on the same computer, over a local connection that both sides
>   authenticate with a pairing code. Nothing is sent to any server by the extension.
> - While an agent works in a tab, the page shows it: a frame around the tab, the agent's pointer and a Stop
>   button. MoPilot asks before an agent uses a site for the first time, and asks again before sensitive
>   actions such as payments or password changes. Press Stop, press Esc in MoPilot, or drag a tab out of its
>   group, to take it back.
> - When an agent downloads a file in its tab, MoPilot tells it where Chrome saved the file.
>
> - The extension's settings list the sites you allowed agents to use in this Chrome, with Revoke, and let you name
>   this Chrome.
>
> Requires the MoPilot app. Once both are installed, the app asks you to allow this Chrome; no code to copy.

## Single purpose

> Let the MoPilot desktop app's agents control the browser tabs they open in this Chrome profile, at the
> user's request.

## Permission justifications

| Permission | Justification |
|---|---|
| `debugger` | The agent reads and acts on pages through the Chrome DevTools Protocol (navigation, DOM snapshots, input events, screenshots and screen recordings the user's agent asks for). The extension attaches only to tabs it opened for a MoPilot chat, or that the user dragged into that chat's tab group, and detaches when the chat lets go, the tab leaves the group, or the user cancels the debugging bar. In those tabs it also empties frames other extensions inject (Chrome refuses a debugger on a tab with another extension's frame), so the agent never reads or clicks them; the user's other tabs are untouched. |
| `tabs` | Open the tabs an agent asks for, report their URL and title back to the agent, and notice when the user closes one. |
| `tabGroups` | Keep each chat's tabs in its own titled group, so the user sees which chat uses which tab and can take a tab back by dragging it out. |
| `webNavigation` | Tell which tab opened a new tab: a link or `window.open` in a chat's tab opens a tab that belongs to the same chat (it joins the chat's group), while a tab the user opens stays the user's. Chrome's `openerTabId` names the tab in front instead, which is the user's when the chat's tab is in the background. When another extension's frame in an agent's tab keeps the debugger out, the extension reloads that tab once and attaches as its new page commits (`onCommitted`). When a tab an agent holds starts loading a site the browser's administrator blocks for MoPilot (the managed `blockedUrlPatterns` policy), the extension shows its own blocked page instead (`onBeforeNavigate`). No navigation is recorded. |
| `storage` | Keep the pairing code (`chrome.storage.local`, readable only by this extension) and each chat's tab list across service-worker restarts (`chrome.storage.session`). |
| `alarms` | Reconnect to the MoPilot app every 30 seconds while it is not reachable, so pairing survives the app restarting. |
| `nativeMessaging` | Pair with the MoPilot app on this computer without passing the pairing code through a page address: the app installs a native messaging host (`ai.mopilot.code.chrome`) that hands the extension a one-time code, only when the user asked to pair in the app or an agent needs Chrome. |
| `sidePanel` | Show the chat with MoPilot beside the page: the toolbar button and Cmd/Ctrl+E open the panel. The panel's messages go only to the MoPilot app on this computer, through the extension's existing connection. |
| `contextMenus` | One item, Ask MoPilot, on pages and selected text. Choosing it opens the side panel with the selected text in the message box; nothing is sent until the user presses Send. The text is held in memory (`chrome.storage.session`) only until the panel takes it. |
| `downloads` | Tell the agent where a file it downloaded in one of its own tabs was saved, or that the download failed, as MoPilot's built-in browser does. Only downloads that a chat's tab began while the agent controlled it are reported, and only to that chat. Chrome saves the file according to the user's own download settings; the extension never starts, opens or deletes a download. |

No host permissions are requested: `chrome.debugger` reaches only the tabs the extension attaches, and the in-page
indicator (the frame around an agent's tab, its pointer and the Stop button) is drawn over that same debugger
session, in an isolated world, so no content script runs on any site. No page is web-accessible, so a website
cannot open the pairing page.

Considered and not requested:
`declarativeNetRequest` (site permissions are enforced by the app before each navigation and action, and a network
rule would reach the user's own browsing too), `offscreen` (WebSocket traffic and the 30-second alarm keep the connection), `notifications`
(the app notifies), `scripting` and `<all_urls>` (the debugger covers page access in the agent's tabs). Adding a
permission with an install warning later would disable the extension for existing users until they accept it, so
this is the set for the first upload.

**Remote code:** none. Every script is in the package; the extension loads nothing from the network.

## Data use disclosures

The extension itself sends data only to the MoPilot app on the same computer (`ws://127.0.0.1`). What the
agent reads in its tabs (page content, URLs, screenshots) goes to the model provider the user chose in MoPilot, as part of the chat, which is the feature's purpose. Declare:

- **Website content** and **Web history** (the URLs of the agent's own tabs): collected, used only to provide
  the feature the user asked for.
- Not sold, not transferred for unrelated purposes, not used for creditworthiness or lending.

Privacy policy: [privacy-policy.md](privacy-policy.md), published at a public URL before submission.

## Screenshots and promotional images

1280x800 PNGs, taken in a real Chrome against a dev instance of the app with scratch data (no personal chats), the
page on the left and the side panel at its usual width on the right:

1. `store-1-panel-chat.png`: a finished chat in the side panel, started from the page it is about.
2. `store-2-agent-tab.png`: the agent working in its tab (frame, pointer and Stop) while the panel shows its steps.
3. `store-3-site-permissions.png`: the settings' Site permissions tab with a saved site and Revoke.

They are taken again for each upload that changes what they show, and handed over with the zip rather than kept in
the repository. Small promotional tile 440x280: optional, none yet.

## Uninstall survey

When the user removes the extension, Chrome opens the survey (`SURVEY_URL` in
`electron/chrome-extension/src/uninstallSurvey.mjs`, with the version as `v`), as Claude in Chrome does. It is a
Google Form owned by admin@mopilot.ai, open to anyone with the link and collecting no email address.

## Review notes

> The extension does nothing on its own: it needs the MoPilot desktop app. To try it, install MoPilot and
> open it; the app asks "Allow Chrome to connect?" (or press Connect in Settings > Browser). Then open
> the side panel from the toolbar button or with Cmd+E, and ask an agent to open a website.
