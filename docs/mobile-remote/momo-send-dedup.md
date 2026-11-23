# MoMo send replay

`machine.hello.capabilities.momoSendDedup: 1` is additive and specific to
`momo.chat.send`. It is absent unless MoMo is allowed and the shared disk-backed
send ledger has loaded successfully and passed a durable write probe. A subsequent
reservation still must persist before controller admission. A failed write removes
readiness; a successful durable probe restores it. An unreadable ledger stays
blocked until the saved history can be recovered and reloaded. `sendId: true` alone
does not certify MoMo retries or crash-safe ordinary-chat completion.

For automatic reconnect retry or restored replay, a phone must retain the inner
`params.id`, normalized `text` and `followUp` (`queue` by default), and pin
`params.expectedChatId` from `momo.chat.follow`'s snapshot `chatId`. The envelope id
may change. `expectedChatId` is an equality guard, never permission to target
another chat. Legacy/manual calls may omit it; that omission does not authorize
automatic replay. The server checks the authoritative main identity immediately
before admission, including after reservation waits and reset/replacement.

The phone must also preserve `reply.error.code` through its runtime, outbox and
reconnect paths, and persist the expected chat id, inner id, text and follow-up
atomically. Until that mobile integration and its physical-device gates pass,
phone replay stays disabled even when the Mac advertises this capability. The
capability alone is not permission to enable replay.

The ledger scopes a request by authenticated pair, method, resolved main chat and
inner id, with an unambiguous structured key. Every delivery-affecting payload field
participates in its canonical fingerprint. Equivalent requests share the running
operation or return the original `{ sent: true, warning?: string }` receipt.
Ordinary `chat.send` uses the same ledger while preserving existing v1 receipts.

| Error code | Meaning and recovery |
| --- | --- |
| `send_conflict` | The scoped id names different content. Do not replay altered content under it. |
| `stale` | The expected main chat changed. Read the current chat; do not retarget an old queued message automatically. |
| `send_uncertain` | The reservation exists but completion is unknown. Keep the existing id for receipt checks; never silently create another id. Inspect the chat before an explicit, informed decision to send another message. |
| `send_unavailable` | This attempt did not dispatch because storage could not reserve/release safely. Previously uncertain ids remain uncertain. Recover storage before retrying. |
| `send_capacity` | This new id did not dispatch because the bounded ledger is full. Existing receipts and uncertainties remain readable. Contact support; do not delete the ledger or mint ids automatically. |

The durability boundary is a reservation before controller admission and a saved
receipt after acceptance. Admission and an external harness effect are not one
transaction: a crash or exception between them remains uncertain on every replay.
Only a rejection proven to precede controller admission can release a reservation,
and that release must persist first. This certifies chat-input admission only;
preparation can already have changed browser tab state. Healthy hello calls reuse
readiness; concurrent recovery probes share one write. Whole-ledger serialization
is bounded by the entry limit. Pending records and completed receipts are
never automatically expired or evicted. Historical identities forgotten by older
versions cannot be reconstructed. This contract does not promise exactly-once
completion of an external effect.
