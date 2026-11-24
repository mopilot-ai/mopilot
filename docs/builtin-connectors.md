# Quick Actions and built-in connectors

Two optional integrations, both off until the user turns them on in Settings → Connectors. Neither writes outside
the app's own folders, or downloads anything, before that switch.

## macOS Quick Actions

Three Services workflows, written to `~/Library/Services/MoPilot - <id>.workflow` by
`electron/platform/quickActions.cjs` (our own generator, not Claude Desktop's files):

| Action | Receives | Opens |
| --- | --- | --- |
| Ask MoPilot | selected text (up to 16 KB) | a new chat with the text drafted |
| New MoPilot Chat Here | a folder in Finder | a new chat in that folder |
| Send to MoPilot | up to 32 files or folders | a new chat with their paths drafted (one folder alone starts the chat there) |

Each workflow runs `open -a <this app> "mopilot://chat/new?..."`. `shared/deepLink.mjs` (`parseNewChatLink`) parses the
link, `electron/platform/openLinks.cjs` holds links that arrive before the app is ready, and
`electron/platform/quickActionLinks.cjs` checks the paths exist and sends the window the `new-chat-link` command
(`src/session/newChatLink.ts`). A link only prefills a new chat; it never sends one, and the chat runs on the default
harness. The scheme is registered by the packager (`scripts/package.mjs`, `protocols`).

Only workflows carrying the `MoPilotQuickAction` marker are replaced or removed; a user's own workflow with the same name
makes the install fail with a message. A workflow written for another copy of the app reads as stale until turned on again.

## GitHub connector

GitHub's own `github-mcp-server` (MIT) as an optional connector for Codex, Claude Code and the basic-tier harnesses.
Turning it on (`electron/platform/builtinConnectors.cjs`):

1. checks that a `gh` login (or `GITHUB_PERSONAL_ACCESS_TOKEN`) exists;
2. downloads the pinned release (`VERSION`) for this platform from github.com/github/github-mcp-server and compares its
   SHA-256 with the pin in the source, so a changed or tampered archive is never installed;
3. writes a small plugin (`.mcp.json` plus a wrapper `run.sh`) and installs it into the plugin store as
   `github@mopilot-builtin`, which delivers it to every harness like any plugin.

No token is stored: the wrapper reads it from the environment or `gh auth token` each time the server starts. Windows has
no build pinned yet and shows the connector as unavailable. Updating means changing the pinned version and hashes.

## Not offered

- **Web search.** Claude Desktop's built-in `websearch` is a bring-your-own-key MCP over Brave, Tavily, Exa or a custom
  endpoint; it is not an Anthropic proxy. Claude Code and Codex search natively, and basic-tier agents bring their own,
  so no fallback is shipped. One would be a keyed connector on this same mechanism.
- **Microsoft 365.** Needs an Azure AD app registration owned by MoPilot (Claude Desktop's client id must not be reused).
  Required: a multi-tenant public-client registration with a loopback redirect (`http://localhost`), a verified publisher
  so organizations can consent, and the delegated Graph scopes Claude Desktop's connector asks for: `User.Read`,
  `offline_access`; read: `Mail.Read(.Shared)`, `Calendars.Read(.Shared)`, `Files.Read.All`, `Sites.Read.All`, `Chat.Read`,
  `OnlineMeetings.Read`, `MailboxSettings.Read`, `People.Read`, `Team.ReadBasic.All`, `Channel.ReadBasic.All`; write:
  `Mail.Send`, `Mail.ReadWrite`, `Calendars.ReadWrite`, `Files.ReadWrite.All`, `Sites.ReadWrite.All`, `ChatMessage.Send`,
  `ChannelMessage.Send`, `Chat.Create`, `MailboxSettings.ReadWrite`; admin-consent only: `ChannelMessage.Read.All`,
  `OnlineMeetingTranscript.Read.All`. With that client id the connector would run on this mechanism like GitHub.
