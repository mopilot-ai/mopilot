# Lost user input

One of the [bug classes](README.md#bug-classes). A pull request adds its note about this class as a file of its own in
`notes/lost-user-input/` (one note per file), not below; the bullets below are the earlier notes.

A draft, queued message, attachment or setting is dropped when the send is refused, fails, is cancelled or
races with an edit (#390, #472, #475, #476, #477, #502, #517, #518, #519).

## Search for and ask

- Search for: every caller of the refused/failed path in `electron/session/controller.cjs` and `src/store/send.ts`;
  places that clear a draft before an `await`.
- Ask: *where does the user's input go if this call is refused or throws?*

## Notes

- Clear the user's input only after the operation it feeds has succeeded, and restore it on refusal and
  failure. Every start path (first send, queued drain, retry, resume, peer delivery) needs the same handling.
- Message transport markers and partial directives must stay literal inside code examples. Share the Markdown code-boundary reader across decoding, display and export; test real metadata beside examples.
- Moving persisted user settings or scheduled tasks: save the destination before deleting the source or changing a native copy. Keep the destination inactive with a durable transfer intent until source retirement succeeds; retry that intent after cleanup failure or while a native app remains open. A pending native edit still needs arbitration against its existing native copy. Test denied destination writes in both directions and every harness transition, as well as failures after the destination is saved.

- Cookie import cleanup retains failed targets until removal, session flush and ledger persistence succeed. Commit ledger snapshots after the private atomic write, serialize physical import/removal effects, stop stale work before each further cookie removal, and retire only observed target identities. Keep actual external writes in visible recovery ownership if their ledger save fails, separate from committed state; a later save or removal persists that recovery. Hand off every successful session write even when flushing fails, preserving the flush error if bookkeeping fails too. Keep newer imports and summaries intact. Report partial refusal so Settings can reload the remaining targets and offer a retry.

- Saved credential, bookmark, project and permission stores may show recognized entries, but writers must validate the complete persisted collection before serializing that subset. Missing files are writable; malformed JSON, null/non-collection roots, unknown declarations, unsupported entries and colliding canonical identities retain the original and oldest unreadable copy. Use the checked-store reader across login save/import/delete, Never-save, Chrome tokens, site/web permissions and computer grants (global and chat-local), and projects with their import metadata/tombstones. Roll back refused durable edits, retain intentional in-memory caches, and reload restored files before deriving a retry; explicit destructive recovery must keep its backup.

- Before clearing a composer, validate every input kind against the selected transport, including attachment-only and mixed drafts. A text-only remote route must reject unsupported chips before expansion or reads, retain their exact draft, and explain removal or local execution. Keep typed chat references distinct from chips that the prompt does not represent. `tests/composerCloudInput.test.ts` is an always-selected app guard with an exhaustive attachment-kind matrix and route/input retirement cases; reference preparation belongs to its exact input, never to a replacement draft.
- A side-panel page is an identity, not just a URL. Send its native tab with a one-use UI grant before dispatch, retain that page's receipt on a queued message, and select it only at its own dispatch. An initial send that fails after creating a chat must return that chat to a capable panel for retry; older clients still receive an explicit error. A timeout or disconnection after forwarding input cannot prove rejection: show unconfirmed delivery and retain the original text for inspection without automatically restoring a duplicate draft. Test concurrent panel sends, native grouping rollback, initial transport refusal, old-client compatibility and timeout after acceptance, in addition to the model's tool call.
