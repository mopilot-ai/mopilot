# MoPilot Chrome extension: privacy policy (draft)

Draft for the Chrome Web Store listing ([listing.md](listing.md)); it is published at a public URL before
submission and reviewed before the extension is.

**What the extension is.** The MoPilot extension lets agents running in the MoPilot desktop app use
the Chrome tabs they open, at your request.

**What it reads.** Only the tabs it opened for a MoPilot chat, and tabs you drag into that chat's tab group:
their address, title, page content and screenshots, and screen recordings (saved as GIF files in the chat's folder on
your computer), as the agent asks for them. When the agent downloads a file
in one of those tabs, it reads that download's address, file name, saved location and whether it finished. It does
not read your other tabs, your own downloads, your history, your bookmarks, your cookies outside those tabs, or your
passwords.

**Where that goes.** The extension sends what it reads only to the MoPilot app on the same computer, over a
local connection (`127.0.0.1`) that both sides authenticate with a pairing code. The extension itself sends
nothing to any server. The MoPilot app passes what the agent reads to the AI model provider you chose for
the chat (for example Anthropic or OpenAI), as part of that chat, under that provider's terms. MoPilot's own
data practices are described in its privacy policy.

**Pairing.** The extension pairs with the MoPilot app through a native messaging host the app installs on the same computer. The host passes only a one-time pairing code between them, and only when you asked to pair in MoPilot or an agent needs Chrome.

**What it stores.** The pairing code, in Chrome's extension storage, which only this extension can read; and the
list of each chat's tabs while Chrome runs. Unpairing, or removing the extension, deletes them.

**What it never does.** It does not sell data, use it for advertising, or use it for any purpose other than
letting the agents you run use the tabs they open. It loads no code from the network.

**Your control.** MoPilot asks before an agent uses a site for the first time and before sensitive actions.
Press Esc in MoPilot to stop an agent, drag a tab out of the chat's group to take it back, or remove the
extension at `chrome://extensions`.

**Contact.** Questions go to the MoPilot project's issue tracker.
