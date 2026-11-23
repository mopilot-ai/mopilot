# Strings, paths and keys

One of the [bug classes](README.md#bug-classes). A pull request adds its note about this class as a file of its own in
`notes/strings-paths-and-keys/` (one note per file), not below; the bullets below are the earlier notes.

User text and file names break parsing: spaces, tabs, newlines, leading dashes, `%`, Unicode surrogate pairs,
and names such as `__proto__` or `constructor` used as plain-object keys (#463, #484–#487, #495, #545).

## Search for and ask

- Ask: *what if the name contains whitespace, a newline, or is `__proto__`?*

## Notes

- Test selection and merge reach share `resolveSpecifier`: query strings and fragments used to reload a module must resolve to the same source path. Pin the dependency graph with regression cases before narrowing mandatory test bundles; keep cross-harness control tests for app code, fixtures and test helpers, and global structural safeguards for every change.
- Bookmark deduplication keys serialize the folder array and URL as a structured tuple. A delimiter inside a user-authored folder label must not become a hierarchy boundary or silently skip another bookmark; test persistence and repeated imports for both paths.
- Transcript inventories: decoding or reading metadata for one filename is a per-entry boundary. Require a nonempty ID whose canonical filename matches the entry before publishing its modification time, so alternate URI spellings cannot duplicate a chat or borrow another file's metadata. Diagnose and skip damaged entries while preserving their files and keeping valid histories available; never let one malformed URI escape reject the whole list.
- Encoded directory keys: `encodeURIComponent` leaves empty strings, `.` and `..` untouched. Reject these before joining an encoded key as a directory, including recursive deletion; a fixed filename suffix makes a different boundary. Test the containing folder and its parent survive rejected IDs.
- Use `Map` (or `Object.create(null)` with own-property checks) for anything keyed by user data. Do not trim or
  split command output that can contain paths; use `-z` and the parsers. Cut bounded user-text prefixes by code point with `shared/textPrefix.mjs` (`prefixUnits`/`suffixUnits` where
  the limit is a size budget; lint: `plugin/cut-text`); test an astral character
  at the limit and persistence round trips, since a split surrogate can become a replacement character.
- Use `Object.hasOwn(table, key)` when validating a caller's key against a named lookup table. The `in`
  operator also accepts inherited names such as `constructor`; `plugin/inherited-table-key` guards tables
  named with uppercase constants.
- Numeric filenames must round-trip through their canonical writer without losing identity: reject leading zeros, negative zero and unsafe integers before using them as scheduler watermarks or reconstructing a path.
- Test with hostile names: `a b`, `a\tb`, `a\nb`, `-x`, `%41`, `__proto__`, `constructor`, `🙂`.
- URI query display text: use `wellFormedUriText` before encoding external titles or search text, preserving valid surrogate pairs while replacing unpaired units. Keep identifiers and filesystem paths strict; replacing an identity can redirect its owner. Exercise the actual send, navigation and deep-link entrypoints.
- Local URI readers separate query/fragment metadata before decoding the pathname (`localLinkParts`, `decodeLinkPath`); encoded `%23` and `%3F` remain filename characters, and plain tool paths retain literal reserved characters and percent sequences. Use URI mode for Markdown href/src and literal mode for tool paths and inline code; file URLs are always URIs. Share this reader across links, images and skill references, preserving supported numeric citations separately.
- Build `file://` URLs with `pathToFileURL(path).href`, never by pasting the path in (`#`, `%`, spaces and
  drive letters break it). Lint: `plugin/file-url`. The same goes for the `codex-asset:` local-image URLs:
  `assetUrl(path)` (src/lib/paths.ts). Lint: `plugin/asset-url`.
- Pick the newest of several version folders by comparing versions as numbers, skipping names that are not a
  version (`latest`, a staging copy): text order puts `1.10` before `1.9`. Use `versionsNewestFirst`
  (`shared/skyComputerUse.mjs`). Lint: `plugin/version-sort`.
- Download collision checks inspect directory entries with `lstat`, not target existence: a dangling symlink still owns its name. Share the reservation reader across user and agent downloads, and propagate inspection errors before reserving a path.
- Restore manifests: matching hashes do not establish path ownership. Accept only declared regular profile files, reject traversal, backup links and destination ancestor links, and check destination types plus rollback's threads root before deleting current data, including UI-only or empty manifests. Restore ordinary files with atomic replacement so leaf-link and hard-link targets cannot be overwritten; retain existing permissions and source permissions for newly restored files. Resolve a linked profile root as the intended physical root.
- User content read as a command: a computer-use click asked "pay in Reminders: Buy milk" because a reminder's title (a text field's value) matched the payment words. Judge an element's label only for controls that act; pass the AX role with every element (`NOT_ACTIONS` in `electron/capabilities/contract/policy.cjs`; guard CM-Q14).

- CSS behavior tests should resolve keyframes from the active animation declaration rather than duplicate its name. Keep exact motion-token and timing checks in the dedicated motion tests so a harmless rename cannot stale a second behavioral contract.

- Named-table fallbacks, truthy admission checks and optional handler dispatch must operate on an own-key namespace: `TABLE[key] ?? fallback` and `TABLE[key] || fallback` otherwise accept Object.prototype values, including objects/functions that cannot be rendered or dispatched as the intended entry. Use `ownTable` for shared, main and renderer maps, and the same intrinsic construction inside serialized script/extension realms. Preserve declared reserved keys, valid values, and normal unknown-input fallbacks; numeric-only array indices and qualified platform status-code tables are separate domains.

- Long user text in a fixed-width control: a path outside home, a device or project name can be far longer than the control was drawn for. A `flex: none` control in a Settings row (`.settings-row-control`) grows with its label and squeezes the row title to one word per line. Cap the shared control (`.select-btn` `max-width`), let only its label shrink with an ellipsis, and say the cut-off text whole on hover (`src/lib/clippedTitle.ts`, also used by every menu row, `MenuRow`). Test with a path longer than the row.
- #1869: a hand list that names what the UI shows drifts from it. Settings search answered to a keyword list per page, and "notifications", "language" and 43 other row titles found nothing. `tests/settingsSearchCoverage.test.ts` now searches every literal `<Row title>` on a Settings page; a new hand list that mirrors UI labels needs the same kind of test against its source.
- A hand-rolled version comparator that splits on both "." and "-" reads a prerelease's parts as more numbers: `0.163.0-alpha.10.2` sorted above `0.163.0`, so the default Codex was an alpha bundled with ChatGPT.app that quit on every start. Pick installed copies with `preferredInstalls` and compare with `compareVersions` (electron/harness/versions.cjs; src/harness/compat.ts in the renderer), where a prerelease sorts below its release; `[version-sort]` flags the split.
- A mark carried as a `Symbol` property on request params (`ISOLATED_THREAD`) is dropped by `JSON.stringify` and `structuredClone`, so a key or cache id built that way can't tell a marked request from an unmarked one: the prewarm key (`codexPrewarm.cjs`) read an isolated start and a plain start with the same params as one warm thread (#2139). Anything that keys, caches, queues or claims by serialized params must either refuse marked params (`key()` is null for them) or put the mark in the key. Search: `JSON.stringify(` and `structuredClone(` on params that may carry a symbol mark; `tests/momoCodexShellOff.test.ts` lists every file that opens a Codex thread.
- A harness switch fell back to the user's home folder for a MoMo chat whose old session no longer named a folder (a Claude Code session no message has started forgets its folder at a restart and has no transcript), so the new Codex thread ran in `~` (#2139). A chat kept apart from the coding side has one folder of its own (`momoWorkspace`); the switch asks the chat's rule (`SwitchRunner.workspaceOf`) before it reads the old session.
