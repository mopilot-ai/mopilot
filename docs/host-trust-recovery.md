# Recovering an interrupted Host trust change

A signed key change updates both the paired-client set and the update-key trust set. These files share the config directory's process-owned trust lock. Before changing either file, the Host durably publishes a versioned target snapshot in `trust-pending.json`, with owner-only permissions.

That durable intent is the commit point. A failure after it may leave an unacknowledged change to finish; it is not evidence that remote trust stayed unchanged. Every subsequent trust read or write first finishes the recorded snapshot under the same lock. Replay is idempotent and needs no new authority: the intent was authorized before publication. Both state files are durably written before pending intent is removed. No new operation may overwrite the snapshot before recovery finishes.

Malformed or unreadable intent blocks trust access and remains on disk. It is never silently discarded to restore an older trusted key. A process that dies while publishing a file leaves the same recoverable intent; the existing PID/token protocol recovers its abandoned lock.

This repairs the pairing/update-key persistence boundary. The update archive, next pointer and downgrade floor are not part of this snapshot transaction. Existing authenticated sessions are not cancelled by replay. Old unpatched binaries do not understand the intent; the current-Host-build prerequisite for key rotation remains necessary. There is no change to expiry, provider logout, offline Remove, or authenticated recovery policy for revoked keys.
