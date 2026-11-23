# Antigravity

MoPilot connects to Google's standalone Antigravity ACP server through the shared ACP adapter. After admission
succeeds, it offers chats, streamed replies, permissions, history, plugins, and MoPilot's browser and computer tools. Models and
other native capabilities come from the server's own responses; the CLI's model list is not substituted for them.

## Install and connect

This integration detects and launches the standalone ACP server. Installing `agy` alone does not make it available
in MoPilot. Google also documents [`agy acp` in newer CLI versions](https://antigravity.google/docs/ide/extensions/acp/);
that command is not used by this integration,
and older CLIs such as 1.4.7 do not expose it. Google distributes the standalone server through the
[ACP Registry](https://github.com/agentclientprotocol/registry/tree/main/antigravity-acp).

1. Open the registry's `agent.json`, choose the archive for your operating system and CPU, download it from
   `dl.google.com`, and verify its SHA-256 against the entry. Extract the complete archive into a permanent folder.
2. Keep `localharness_external` beside `agy_acp_server.par` (or the corresponding Windows executables). Both are
   required. On macOS and Linux, ensure both files are executable.
3. In Settings → Harnesses → All harnesses, expand **Install another harness**, find **Antigravity**, click
   **Set location…**, and select `agy_acp_server.par` (`agy_acp_server.exe` on Windows). Alternatively, put the server
   on your login shell's PATH. MoPilot also recognizes the name `agy_acp_server`.
4. Re-check it. If sign-in is required, open Antigravity's settings page and use the authentication method the
   server offers. Credentials remain managed by Google's server. Its settings are under
   `$GEMINI_HOME/antigravity-acp/settings.json` (default `~/.gemini/antigravity-acp/settings.json`), independently of
   the `agy` CLI's settings.
5. Select Antigravity in the chat harness picker after admission succeeds.

An initialization handshake or a sign-in request alone does not establish that the agent is ready. If Settings
reports that MoPilot cannot connect its computer and browser tools, retain that failure and use **Re-check** after
addressing it. The message does not establish that an update or another sign-in will help. An update is offered
separately only when MoPilot finds one.

Admission requires ACP v1, a session, and a successful connection to MoPilot's tool server. Missing files, an
unsupported protocol, a missing sign-in, or a failed tool connection keep the harness out of the picker and show
the reason in Settings. Google documents its ACP integration in the
[Zed setup guide](https://antigravity.google/docs/ide/extensions/zed).

## Scope

Each chat owns its own ACP process and tool channel. Native permission modes default to asking unless MoPilot has
an explicit mapping; no unverified full-access or read-only mapping is assumed. The server's startup syslog event
is disabled; this does not change the Google account's data-sharing choices.

Sessions reopen through the server's advertised history capabilities. ACP session IDs are not assumed to be `agy`
conversation IDs, so **Copy resume command** is not offered. The server does not have a verified MoMo isolation
contract, so it is available for coding chats only. Installing or updating `agy` does not install or update the
separate ACP server; replace its complete archive and re-check to update it.
