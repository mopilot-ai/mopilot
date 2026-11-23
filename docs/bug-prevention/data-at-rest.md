# Data at rest

One of the [bug classes](README.md#bug-classes). A pull request adds its note about this class as a file of its own in
`notes/data-at-rest/` (one note per file), not below; the bullets below are the earlier notes.

What MoPilot keeps on disk or hands to another process can be read by more than the user meant: a sign-in or
API key saved in plain text (#2144: Codex accounts' `auth.json`, the Claude API key), a "fallback" that stores a
secret base64-encoded when encryption is unavailable, a secret on a child's command line (any local process can
list it), or user content (chats, browsing history, screenshots) in files other users could read.

## Search for and ask

- Search for writes whose file names a credential (`auth.json`, `api-key`, `token`, `secret`, `password`,
  `credential`), `toString('base64')` stored as if it were encryption, `enc: 'plain'`, secrets passed in `args` or
  `-c key=value`, and `writeFileSync`/`writeAtomic`/`mkdirSync` of user content without a private mode.
- Ask: *who else can read this file or this process's arguments, and does it still hold when the OS key is
  unavailable?* A secret is encrypted with safeStorage (`electron/platform/secretFile.cjs`) and never saved otherwise; the
  answer to "encryption is unavailable" is to refuse and say so, not to save it readable.

## Notes

- Guard: `plugin/plain-secret` (lint/rules/plain-secret.grit) warns on a credential file written as it is.
- A secret in a URL is not private either: Codex logs the URLs it calls in its own log database (`~/.codex/logs_*.sqlite`). The model relay therefore checks the peer process of every connection (`electron/identity/accounts/relay.cjs` `admits`), and its address goes to the app-server with each thread request (`threadConfig`), never as `-c` on the command line. Guard: `plugin/argv-secret` warns on a secret built into a child's arguments.
- A process MoPilot hands a secret to may save it: Codex writes an `account/login/start` of type apiKey to its `auth.json` in plain text. An added Codex key goes to Codex only through the thread's own model provider (`auth.command` reads it from the keychain), named on `thread/start`, `thread/resume` and `thread/fork` alike: a real app-server refuses a resumed thread whose provider is missing and sends a forked one to its own login (#2201). Guard: `plugin/apikey-login` (lint/rules/apikey-login.grit).
- Owner-only files: the data folder is registered at startup (`electron/platform/privateFiles.cjs` `keepPrivate`), so `writeAtomic` and `writePrivate` make files 0600 and folders 0700 there whatever the umask, and `tightenTree` takes group and other access off what was left open, at every start. A store that writes with plain `fs` passes a mode or uses `mkdirPrivate`. Chromium's own folders (caches, Local Storage, IndexedDB) are made 0700/0600 by Chromium and rely on the data folder being 0700; the startup pass skips them. Guards: the 0700 data folder plus `tightenTree` at each start hold for every writer, and `plugin/open-mode` (ratcheted) warns on any write or mkdir with a plain fs call and no mode, wherever it writes.
- Owner-only files: the data folder is registered at startup (`electron/platform/privateFiles.cjs` `keepPrivate`), so `writeAtomic` and `writePrivate` make files 0600 and folders 0700 there whatever the umask, and `tightenTree` takes group and other access off what was left open, at every start. A store that writes with plain `fs` passes a mode or uses `mkdirPrivate`. The guard that holds for every writer is the data folder itself being 0700 plus `tightenTree` at each start; `plugin/public-data-file` only catches a plain write into a path built from `userData` by name (most stores get their path as `this.file` or `dir`).
- Large user content MoPilot keeps in one file is sealed with `electron/platform/sealedFile.cjs` (AES-256-GCM under a data key kept with safeStorage): the browser history lives in memory while the app runs and is saved sealed a few seconds after a change and at quit. Without the OS key it is kept for the run only; a sealed file another key made is never saved over.
- Encrypting a file from now on does not reach the copies made before: an earlier plain version may survive in Time Machine backups, APFS local snapshots and the disk's free space. FileVault covers those; after an upgrade that encrypted secrets, rotate the keys that were stored in plain text (an API key, a sign-in), and turn on "Encrypt backups" for Time Machine.
- Stated limitation: a key a child needs is handed over in its environment (Claude Code's `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` for an API key or MoPilot credits, `harness/claude/auth.cjs`), where processes of the same user can read it (`ps -E`) and the child's own commands inherit it. A helper command instead (Claude Code's `apiKeyHelper`) would not raise the bar: any process that can read another's environment can also run that helper and get the same key from the keychain. The boundary is the user account; other users and the disk are what at-rest protection covers. Never put such a key on the command line (`plugin/argv-secret`) or in a file the child reads.
- A migration of a plain secret is not one-way: an older version run after it (a downgrade) can write the plain file again. Migrate whenever the plain file exists, not only when no encrypted copy does, and keep the newer of the two (`claudeAuth.migratePlainKey`).
