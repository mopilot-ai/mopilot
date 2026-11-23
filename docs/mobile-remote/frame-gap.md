# Mobile Remote: a gap in the frame counters

Status: implemented on the phone and on the Mac in the same PR. Tracks #4996.

## The problem

Each direction of a pair is a one-way hash chain (`shared/remote/crypto.mjs`). A receiver keeps the last counter it opened and the chain key after it. A frame whose counter is more than `MAX_SKIP` (4096) past the saved one was refused with `gap`. That limit exists because the counter in the header is **not authenticated**: anyone on the relay path can name any counter, and reaching it costs the receiver one hash per skipped counter before the tag can be checked.

Before this change a refused frame left the saved counter where it was, so the next frame, further ahead, was refused too. The phone ended on "too many frames are missing" with Retry (which reconnects with the same counters) and Sign out. The Mac ended with the phone's frames dropped for good and a `pair.resync` notice that led to "remove the computer and pair it again".

## The invariant

**A gap is closed only by a frame that opens under the pair's own chain, or by pairing again.**

- The walk reads no secret and trusts nothing: it derives the chain forward from the saved state. The frame is accepted only if its AEAD tag opens (the header, with the counter, is the AAD) under the key at that counter.
- State is committed only after the tag opens. A frame with a forged far counter walks, fails its tag and leaves the saved counter and chain exactly as they were. It cannot poison the session.
- Counters stay strictly increasing: replay and rewind are refused as before. Frames inside the gap are lost by design (their keys are never derived).
- A gap is never accepted without authentication, and a successful catch-up is not a new key exchange: it adds no trust that the pair did not already have. A new key exchange for existing pairs is the separate, unimplemented Part B of `rekey-design.md`.

## The cap and what it costs

| | |
|---|---|
| Usual walk | `MAX_SKIP` = 4096 counters |
| Catch-up walk, Mac | `CATCH_UP_SKIP` = 131072 counters (2^17), one hash per counter |
| Catch-up walk, phone | `PHONE_CATCH_UP_SKIP` = 32768 counters (2^15). Measured on an iPhone (Dev build): 120000 steps took about 27 s, so a step costs about 230 µs and the bound is about 7 s; further than that the phone says so at once and offers Pair again |
| Cost | about 1 s of hashing in Node (2.2 s for 262144 steps); on an iPhone 13 not measured yet, to be read from the device row |
| Work bound | no time limit. Each side keeps a checkpoint cache of the true chain (`createWalker` in `shared/remote/crypto.mjs`): the chain at every 1024 counters past the saved one (both sides), plus one more point: the furthest target walked to (the tail), derived only from the saved state. A walk resumes from the largest cached point at or below its target, so forged far frames can only make later real ones cheaper. Frames that repeat one target, or only go further, cost at most the cap plus one stride in all, however many arrive; a target below the tail resumes from the aligned point under it (at most one stride for that frame; a forged sequence that keeps stepping down inside one stride pays that each time, bounded per frame, not in all). The cache is dropped when the saved counter or the saved chain changes. Cached points are kept only for counters ahead of the saved state: a chain value at counter k derives every later message key, so once a frame opened and was saved (on the phone in `receive`, on the Mac in `#openFrame` after the counters are saved, via `forgetWalked`) both ends call `walker.reset()`, which drops every point and the base, and nothing at or below the new saved counter stays in memory A forged frame therefore cannot lock real far frames out |
| Chunks | the breaks that let the app (or the main process) draw are apart from the cache spacing. The phone breaks every 128 steps: measured on an iPhone (Dev build) a step costs about 230 µs, so a break about every 30 ms (2048 steps would have blocked JS for about 470 ms). The Mac breaks every 1024 steps (about 25 ms in Node). Both cache a point every 1024 steps. The home screen says "Catching up with your computer…", and clears it however the walk ends, a teardown, a switch or a sign-out included |
| Beyond the cap | not walked at all. The phone says "Can't read this computer's messages. Try again, or pair it again." with **Retry** (a new session) and **Pair again** for that computer only (Sign out stays a separate choice). A forged and a real beyond-cap frame cannot be told apart, so the line never tells the person to pair again as the only way, and nothing pairs again by itself |

## What happens after a catch-up

Frames inside the gap are gone, so the phone does not assume continuity. When the walk is done it brings the computer back by the path a computer that went away and returned takes (`connectionLost` then reconnect): the chat list and the open chat read again from what the computer now holds.

## The two directions

- **Mac ahead of the phone** (the report in #4996): handled on the phone as above (`shared/remote/phoneSession.mjs`).
- **Phone ahead of the Mac:** the Mac drops the frame, acks it so the relay forgets it and sends `pair.resync` at most once a minute (`electron/remote/sessionPause.cjs` `noticeGap`). Before this change the Mac never recovered. The Mac now does the same bounded, chunked, tag-checked walk (`electron/remote/catchUp.cjs`, called from `channel.cjs` on `gap`), with the same cap and the same work bound per saved counter, so the two directions are symmetric. A session that pauses (a full queue, a failed save) while the walk runs leaves the frame unacknowledged, so the relay sends it again after the session reopens; the cached points make that walk cheap. The Mac's walk is not paid from the per-session read budget (1000 steps a second): paying it would hold the session's later frames for minutes, and a forged far counter could keep them held. The cap and the checkpoint cache bound it instead (about a second of hashing in all per saved counter).
- **Host-direct pairings** (`shared/host/relaySession.mjs`) keep no persisted counters: every connection derives a fresh session root and both counters start at zero, and any gap ends that one session (`A frame from the relay was lost.`). The next connection re-handshakes, so there is no dead end to fix.

## Why a merely absent phone gets this far ahead (prevention, not yet fixed)

The Mac seals every event frame for a pair without asking whether the phone is connected (`RemoteChannel.#seal`), and the relay holds frames for an offline phone (a mailbox of 5000 frames, 7 days). A phone that is away while a long run streams can fall more than 4096 counters behind, and a relay that expired or refused frames leaves the Mac's counter advanced for frames nobody received. Stopping that needs the Mac to know the phone's presence or to coalesce stale stream events, which is a relay protocol addition, tracked separately. The catch-up makes the state recoverable whatever the cause.

The prevention for that cause is the section below (#5020).

## Events skipped for an absent phone

The Mac does not seal the live-view events in `electron/remote/awayEvents.cjs` (`AWAY_SKIPPABLE`) for a phone the relay says is away (`phoneAbsent`, from `electron/remote/phonePresence.cjs` `isAbsent`). The send chain then does not run ahead of what the phone can read (#5019). A skipped event is gone: the phone must rebuild that view by reading again on its return. Anything not listed is always sealed.

### The Mac can be wrong about the phone

The relay's `peer online` can arrive late. So presence also flips to present on a frame from the phone that opened under the pair's own chain and whose message was decoded (`channel.cjs` `#openFrame`, then `awayEvents.cjs` `phoneHeard`, after the tag opens, the counters are saved and the frame is acknowledged; a forged frame never gets that far, and a failure in the hook is noted, never a `storage` pause of a frame that was already acknowledged). When that flip ends an absence, the Mac seals one `live.missed` marker (`patch.reason: 'late-presence'`), through the notice path, so it is sealed although the phone was absent. A return that the relay announces first (`peer online`) sends no marker: the phone's own connect already re-reads.

The relay sends its hello and then flushes the mailbox (`relay/src/hub.mjs`: `start`, then `kick`), so a phone that is gone still has its backlog arrive right after the hello, authentic and newer than any mark the Mac made at the hello. A frame therefore flips the phone to present only if both hold (`phonePresence.cjs` `markPresent`):

1. **Grace.** It was received more than 5 s after the relay's last news of that pair's absence (the hello, or `peer offline`). The backlog flush happens inside that window.
2. **Authenticated freshness.** The message's own `t` (the phone's clock, inside the sealed payload, so it cannot be set by the relay) is within 2 minutes of the Mac's clock (`|now - t| <= 120000`). A message without a usable `t` never flips. The relay's own `peer online` still does.

Without these a stale frame would mark an absent phone present, the relay would never say offline again, event skipping would stop, the counter would grow unboundedly again (#5019) and a spurious `live.missed` would be sealed. The marker is sealed at most once a minute per pair.

On `live.missed` for the selected pair the phone drops its connection and reconnects at once (`mobile/src/runtime.ts`, `connectionLost('Catching up with your computer…', 0)`), the same path a lost connection takes. Every screen then reads again (see the table). An older phone ignores the event: every listener filters by `ev` name or by `chatId` (`Thread.tsx` `event.chatId !== chatId`, `useChatList.ts:132`, `Terminal.tsx:48`, `Momo.tsx:115`, `useReviewEvents.ts:15`, `machines.ts:150`, `push/controller.ts:333`, `presentation/thread.ts` `update`, which acts only on named `ev` values), and `shared/remote/phoneSession.mjs` does not branch on `ev`.

Side effect to know: a reconnect leaves `online`, so the Changes, Terminal and quick review screens close (`MobileApp.tsx:204-210`) and the chat list is read again on return (`MobileApp.tsx:212`). It happens only when the Mac wrongly thought the phone away.

### Skipped events and what restores each

| Event | Phone-side read that restores it on return | Verified |
| --- | --- | --- |
| `items.append`, `items.replace`, `items.delta`, `turn.state`, `session.patch` | A followed chat reads itself again from the start: the Thread effect keyed on `offline` (`mobile/src/screens/Thread.tsx:177`, `if (offline) return;`, then `createFollowFeed({ read: chat.follow ... })`). The snapshot is the chat's items, turn state and session state. | Read in code. Not run on a device. |
| `cards.changed` | Cards are part of the `chat.follow` snapshot (`thread?.session.cards`, `Thread.tsx:154`), so the same re-follow restores them. The quick review sheet follows the chat itself on open (`remote/useChatCards.ts`), and it closes when the phone leaves `online` (`MobileApp.tsx:206`). | Read in code. |
| `chats.changed` | The chat list is read on every return to `online` (`MobileApp.tsx:212`, `list.read(true, ...)`) and again when a chat opens (`useOpenChatList`). The `chats.changed` listener only coalesces extra reads while online (`useChatList.ts:132`). | Read in code. |
| `pty.data` | Terminal screen: `pty.open` replays from the offset the screen has (`Terminal.tsx:61`). While the screen stays open, the next live slice that starts beyond the screen's offset is a gap (`remote/mirror.ts:32`), which reopens from `state.at` (`Terminal.tsx:83-85`). After a reconnect the screen is closed (`MobileApp.tsx:209`) and a new open replays the stream. | Read in code, including the Mac's replay of the ring from `from` (`mirrorPty.cjs:106-111`). |
| `frames.frame` | No phone code uses it: no match in `mobile/src` or `shared/remote`, only the Mac emitter `mirrorFrames.cjs:74`. Nothing on the phone is stale. | Verified by search that no consumer exists. |
| `machines.changed` (added to the skip list) | `followMachines` is keyed on `generation:selectedPair` and reads `machine.hello` and `machines.list` again on every new connection (`macLink.ts:84-91`, `remote/machines.ts:146-170`). | Read in code. |

### Events still sealed for an absent phone

| Event | Why it stays sealed |
| --- | --- |
| `momo.changed` | Only `area: 'chat'` has a clear re-read (`useFollowedChat` follows again when `online`, `Momo.tsx:117`). The other areas only bump counters (`Momo.tsx:119-123`); that each one is read again on return was not verified. |
| `review.changed` | The Review screen closes when the phone leaves `online`, but the Changes chip (`useChangeCounts.ts`, keyed on `request`, `chatId`, `offered`, `enabled`, `version`) is not verified to read again after a reconnect when `request` does not change. Not verified. |
| `frames.state` | No phone consumer (as for `frames.frame`), so skipping it would lose nothing, but this was not needed and it carries on/off state, so it stays sealed. |
| `pty.exit` | A stream that ended while the phone was away is only known if the replay carries the exit; `#resume` (`mirrorPty.cjs:106-111`) replays output only, so this was not verified. It is also sent once per terminal. |

All other events (replies, notices, `push.titleKey`, `pair.resync`, `live.missed`) are always sealed.

## Known limits

Found by the independent review of #5020 and accepted:

- With two or more computers a failed frame drops the connection, and the error line does not name the computer; Retry and Pair again are hidden until one is chosen. With one computer, a forged beyond-cap frame puts a one-tap **Pair again** on screen (the owner's choice; Retry works too, because the forged frame is gone by then).
- **What bounds the holes.** A counter the relay refuses (`mailbox_full`) is taken back only while no later frame was sealed; otherwise it stays a hole the phone must walk over, and nothing else bounds how many pile up (the phone's catch-up bound `PHONE_CATCH_UP_SKIP` is 32768). The Mac counts them per session (`s.holes`, `awayEvents.cjs` `refusedFrame`). At `HOLE_LIMIT` (16384, half of the phone's bound) it seals nothing but replies to the phone's own requests and notices (`skipsSeal`), so the chain stops growing; any authentic frame from the phone resets the count (`phoneHeard`). The count is not lowered by a taken-back refusal (the earlier holes are still there) nor by a relay acknowledgement (the relay sends none for a stored frame). Not bounded: replies and notices themselves, and the 64-counter checkpoint a restart skips.
- `momo.changed`, `frames.state`, `pty.exit` and `review.changed` are still sealed for an absent phone (see the table above). Their volume is low, so they cannot run the counter ahead the way the stream events did.
