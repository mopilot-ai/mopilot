# Cross-session messaging

Status (2026-10-11): implementation and code/design review complete; native installation and full reference-product acceptance remain to be verified. Unit tests establish code behavior, not full Codex experience parity.

## Reference and intended interaction

The user reported that typing `@` showed only files instead of other conversations. The reference requirement is to find an existing conversation, reference it, and explicitly ask it to do work and return a reply. Exact Codex controls, copy, version, timing, and recovery behavior require observation in the installed reference product. Proposed MoPilot behavior below must not be presented as observed Codex behavior.

1. Typing `@` with an empty query shows recent conversations alongside existing reference candidates. Search narrows by title. Same-title conversations retain separate stable identities.
2. Selecting a conversation inserts an atomic reference token. Copy, deletion, undo, and draft restoration preserve its identity.
3. Clicking the token opens the conversation. Its context menu offers Open chat and Send message; the latter preselects the recipient. The general message entry also lists recipients and their current project and availability.
4. Like Claude Code's `SendMessage`, an agent may read or message any chat `list_chats` returns, whatever the user's wording (#3364 recurred when a word list decided it). The receiving chat's gate (deleted, archived, crashed, running elsewhere, goal paused, harness off) and the user's pause decide delivery. The tool tells the agent never to ask a peer for work this chat denied.
5. Explicit UI submission persists the request before native dispatch. The source sees an outgoing card and the recipient an incoming card. Links open the corresponding chat. Unread state and notification follow actual delivery.
6. The recipient works in its own project, account, permissions, and approval policy. Explicit replies and an accurately correlated final-answer fallback return to the source. An automatic reply does not request another reply.

## Shared architecture and harness support

`electron/session/peerMessages.cjs` owns the journal and delivery protocol. `peerRuntime.cjs` owns authenticated tool/IPC boundaries. `controller.cjs` owns queueing and dispatch through the recipient's current adapter. Renderers submit intents and display results; they do not infer capability from harness names or native id prefixes.

Route by stable MoPilot chat id. Resolve the current native segment immediately before dispatch, including pending harness switches. Both participants must support the core request/reply outcome across Codex, Claude Code, and admitted ACP harnesses, without requiring an open recipient window. Nine sender/recipient family pairs are covered by focused service/controller tests. Native protocols and stable client input ids remain in adapters.

| Receiver state | Outcome |
| --- | --- |
| Idle | Start through the current adapter after durable preflight |
| Running | FIFO queue by default |
| Explicit immediate delivery | Codex/Claude native steer when available; preserve queue and reason otherwise |
| ACP running | Queue; native steer is unavailable |
| Awaiting approval or a question | Queue without answering or bypassing approval |
| Pending harness switch | Queue and dispatch through the receiving adapter after the switch |
| User stopped/paused | Block until explicit recovery; never wake automatically after restart |
| Linked-session message (`send_message`, a parent's follow-up) to a running chat | Steered into the current turn where the recipient's harness can steer (`traitsOf(kind).steers` and its declared peer steer capability); the sender's receipt is `delivered`. Otherwise queued with the reason in the receipt note: ACP (cannot steer), a turn awaiting the user, a pending switch, compaction, a voice conversation, or an older message from another session still waiting. It never steers past that older message (`electron/session/familyDelivery.cjs`) |
| Linked-session message already steered | It has left the queue, so there is no Remove row; removal and the sender's `removed_messages` apply only while it is queued |
| Archived, missing login, disabled harness, external owner, crashed | Retain an accurate blocked/failed state and recovery action |
| Target deleted | Reject new sends; do not report successful delivery |
| Source deleted | Retain its correlated reply in the collaboration journal; show the retained source id |

Adapter capability declarations expose messaging, reading, steering, and the required tool channel. Directory results combine these declarations with recipient gates and channel configuration. A configured channel is not proof of a completed native handshake. Disabled bridges show an explicit reason; direct UI sends and correlated final-answer fallback remain available when delivery itself is available. Steered requests need the explicit reply tool because the surrounding native turn's final answer is not necessarily their answer.

## Identity, permissions, and tools

Tool calls derive source ownership from authenticated chat and native segment context. IPC validates trusted windows and their followed chat. Quick Chat is a source only for the chat it owns, identified by its stable MoPilot chat id in `quick-chat.json`, and does not acquire arbitrary send privileges from this API. Incoming prompt envelopes are user-level source data, not system/developer instructions. Peer input remains `human: false`; it cannot inherit the sender's full access or elevate screen-control attendance.

A trusted human steer may add an attendance contribution. Contributions expire with that turn, remain separate from original provenance, and are removed on rejected native input. Peer input and queued input cannot mark the current automatic turn as attended. Existing scheduled, subagent, idle, permission, and approval rules remain enforced.

| Tool | Contract |
| --- | --- |
| `list_chats` | Bounded directory/search with title, stable id, project, state, capabilities and cursor |
| `read_chat` | Bounded history with cursor and omission metadata |
| `send_message_to_chat` | Validate source and target, persist intent, return actual delivery state |
| `reply_to_message` | Reply only to an actually delivered request received by this chat; main chooses the reverse target |
| `get_message_status` | Read delivery/reply state for a participating chat |
| `wait_for_message` | Observe state changes for at most 30 seconds; timeout/abort do not cancel recipient work |

Default collaboration scope is one request and one reply. Self-send and automatic reply loops are rejected, and agent-to-agent relay loops are cut (below). Concurrent waits do not hold dispatch locks. When two running chats request each other, both requests queue; bounded waits return, and finishing each current turn releases its queue. This is asynchronous collaboration, not an unsupported synchronous suspend/resume guarantee.

## Receiver-side hold and loop bounds

Reference: Claude Code 2.1.311 (read from the shipped binary). It sorts sessions into two permission classes, `bypass` (runs tools without asking) and `prompting` (everything else). Only a recipient that bypasses holds a message, when the sender's class differs or the sender stated none: a prompting recipient's own prompts already guard it. The held message shows as "Held message from another session" with a preview and Deliver / deny. It expires after the user-dialog timeout (5 minutes by default) and is released by itself once permissions are prompting again. The sender gets a notice for held, approved and released, denied, and expired, each telling it not to wait or resend. Its inbox guard refuses, per sender: a burst over 30 (refilling 0.5 per second), the same body again within 30 s, a message that passed through the session 10 times (`hop-loop`), and a chain longer than 28 (`hop-runaway`).

MoPilot (`electron/session/peerHold.cjs`, `peerInboxGuard.cjs`):

- **When it holds.** A chat whose permission is Full access holds a new request from a chat in any other mode, or whose mode is unknown, as `held` (`held_mode_mismatch` or `held_mode_unknown`). The permission is the one the composer shows (`chatPermission`): the harness's reported mode, an ACP chat's mode anchors, then the saved choice. Matching modes, or a prompting receiver, deliver at once. A reply is never held: it answers the receiving chat's own request.
- **Answering.** The receiving chat's card offers Allow and Decline, through `peer:approve` and `peer:decline` from that chat's own window only. No tool can answer a hold. Allow marks the message `allowedByUser` and delivers it like any other. Decline ends it as `declined`. The sender's card shows "Waiting for approval" and can only cancel it.
- **Expiry, with no window open.** Main sweeps held messages every 15 s. One past `heldUntil` (10 minutes) becomes `expired` (`hold_expired`), and one whose two chats' modes now match is delivered. A receiver that switches to Full access while a message waits in its queue holds it at dispatch. A held message is never submitted, so a restart keeps it held.
- **Notices.** A held message marks its chat unread and notifies once: "Message from … needs your approval" (`electron/app/peerNotices.cjs`). The sender's tool text tells its agent not to report a held message as delivered, wait on it or resend it.
- **Loops.** Each message records `hops`: the chats its agent-to-agent chain passed through. A turn that a peer message started (input token `pending-<id>`) continues that message's chain, and a reply continues its request's chain. A user's turn starts a new one. A new request to a chat already in the chain 10 times is cut as `peer_loop_cut`, and one with a chain over 28 as `peer_relay_runaway`. A cut message is kept as `blocked`, so both chats show it, and the sender's Retry sends it with a new chain.
- **Floods.** Per sender and receiver, in memory: past a burst of 30 (refilling 0.5 per second) a send fails with `rate_limited`, and the same body within 30 s fails with `duplicate_message`. Neither is journaled. Replies are not counted.

## Persistence and recovery

Delivery states: `accepted`, `queued`, `submitting`, `delivered`, `blocked`, `failed`, `cancelled`, `uncertain`, and the hold's `held`, `declined`, `expired`. Reply state is independent: `notRequested`, `awaiting`, `received`, or `timedOut` when applicable. A wait timeout reports that observation timeout without claiming delivery failure or cancelling the message.

The journal contains message/conversation ids, stable participants, source turn, body, reply linkage, timestamps, request fingerprint, native kind/session/turn/item receipt, and error reason. Atomic private-file replacement precedes native submission. Presentation failures do not reverse a committed delivery decision.

Deduplicate by source, request id, and target, verifying body/reply fingerprint including concurrent lookups. Native acceptance—not controller queue acceptance—moves delivery to `delivered`. Final replies require the exact original input/turn association; commentary, incomplete turns, unrelated final answers and reply-to-reply turns cannot trigger fallback. Explicit and fallback replies share deduplication.

After restart, accepted/queued requests become blocked and require explicit resume. In-flight submissions become uncertain and never blindly resend. Reconciliation reads the original native history using exact client/session/kind/turn identity. Missing or unavailable proof keeps uncertainty. Native acceptance followed by an ACK write failure remains uncertain while the target's actual turn continues. Do not promise end-to-end exactly-once delivery.

Cancel only before irreversible native submission; delivered input cannot be withdrawn from context. Retry/resume is an explicit sender operation that rechecks target state. Stop persistence failures still pause peers in the current app run; unsuccessful recovery cannot clear the gate. Damaged or unreadable journals remain intact, disable messaging with `journal_unavailable`, and do not prevent app startup or silently create a replacement outbox.

Temporary conversation bodies are excluded from the durable collaboration journal. Unsent message drafts live only for the current application run, matching composer behavior; navigation/remount restores body, recipient, reply id, and failed request id. Late acknowledgments cannot erase newer drafts or clear another submission's busy state.

## History and limits

Both reference attachments and messaging tools use the shared main-side native reader and segment slicing. Claude and ACP use shared translators; Codex uses bounded paginated native turns. Each historical segment retains its original project context; the directory uses the recipient's current project and preserves unknown values rather than substituting the sender's directory.

Bounds: 32 KiB send body, 32 KiB history page/reference output, 50 directory results per page, 100 pending requests per target, 30-second waits, and 20 ids per reference-history IPC call. Reject oversized send bodies without silently truncating the draft. History omission is explicit, oversized items advance pagination through a bounded excerpt, repeated native cursors stop, and incomplete switched history cannot fabricate segment offsets. Read-only history access does not start or resume a native turn.

## Review and validation

The design/code audit covers default entry, selection, explicit action, durable native receipt, correlated reply, failure/recovery, persistence, current adapter routing, trusted source, recipient project/permissions, tool availability, and UI late-response races. Code fixes also cover screen-control attendance after actual human steering and a text-pacer wake-up race that could strand later streamed text.

Actual acceptance still requires the updated installed app: empty `@` state, search/selection, send/reply, mixed harness pairs, closed recipient window, current project/account/permissions, real tool handshake, cancellation, failures, restart/reconciliation, unread notification, and reference-product version/screenshots/actions/results. UT and component previews cannot establish complete Codex parity. Record supported, degraded and blocked native cases accurately; retain the full goal until this evidence exists.
