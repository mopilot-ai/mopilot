# Mobile Remote desktop ownership

Mobile Remote is available only while the remote switch permits it, a MoPilot account and desktop device are signed in, and the person has opted in locally. The sealed identity and device list are scoped to that account and device. Signing out or replacing either owner retires the running channel; returning to an owner requires opting in again. The local document that shows Connect your phone and starts a pairing alone receives its QR and can confirm the safety number. Navigation, cancellation, expiry and relay removal retire an uncommitted pairing.

Consent is main-owned: the generic renderer preference endpoint cannot set or delete it, including through malformed deletion names. A supported state schema and a successful per-file write receipt are required before opt-in takes effect. Consent publication synchronizes the file and its parent directory before acknowledgment. Failed persistence blocks access in the current process and shows recovery in Settings; if withdrawal could not be saved, restarting can restore an earlier consent, so the failure is never reported as a successful saved change.

Runtime shutdown is terminal. A late storage load, token reply or reconciliation callback cannot create or reattach a relay after close. Flag, consent and account transitions instead retire one stack and permit a later valid owner to start. Channel readiness has its own generation: stop retires a pending load, while an explicit replacement start can install its listeners.

A confirmed pairing is staged inactive in the sealed device list before activation. Once activation starts, the approved commit is allowed to finish; cancellation does not promise to undo it. A relay removal fences that exact pair immediately and, if activation is underway, prevents a paired-success result and removes only that pair. A late removal cannot delete a replacement pair for the same phone. When local deletion fails, the transport drops the retired pair immediately and Settings retains a recovery entry for the person to remove.

A sealed-file failure before rename leaves the old file authoritative and permits retry. A directory-sync failure after rename makes the outcome indeterminate: the device list fences its effect leases and writes until a fresh runtime reads the sealed file. Settings reports recovery is needed; an uncertain activation does not report paired success. The reloaded file may contain the old inactive state or the approved active pair, so the person should check paired devices. This is not a guarantee that a failed local file removal survives restart.

The relay's authenticated pair removal is the phone's authoritative leave operation. The v1 `device.unpair` request is not advertised unless a host provides an implementation that confirms removal; the default service refuses it.

## Pair keys

A pair's root key is `HKDF(X25519(identity keys) || X25519(ephemeral keys), "root|2|macId|phoneId|pairId")` (`deriveRoot`, `shared/remote/crypto.mjs`). The phone's ephemeral public key travels in the sealed hello (under the key bound to the one-time QR code) and the Mac's in the QR itself, with the Mac's Ed25519 key; each side deletes its ephemeral secret as soon as the root exists, and neither is ever stored. Pairing the same two devices again therefore gives a new root, and a later leak of an identity key opens nothing that was recorded. The QR payload, the hello request and the answer carry `v: 3`; anything else is refused (a phone reads only the new QR, and an older phone cannot read it: Mac and phone need to be on the same release to pair), as is a low-order public key. Root derivation is unchanged since version 2 (`root|2|…`), so a phone paired earlier keeps its stored chains and needs no migration; the safety number is shown only while pairing and is never stored.

### Safety number (version 3)

Both screens show twenty digits in five groups of four (about 66 bits). They are computed from the pairing transcript, `SHA-256("mopilot-remote-v1|transcript|3|" || field(macId) || field(phoneId) || field(pairId) || field(macPub) || field(phonePub) || field(macEdPub) || field(phoneEdPub) || field(macEphPub) || field(phoneEphPub))` with each field length-prefixed (two bytes, big endian), then `SHA-256("mopilot-remote-v1|safety|3|" || transcript)` cut into five 40-bit groups, each taken modulo 10,000 (`pairTranscript` and `safetyNumber`, `shared/remote/crypto.mjs`; vector in `shared/remote/vectors.json`, reproduced by the Mac's sodium primitives and the phone's noble ones). The pair id is derived from the one-time code, so the number also binds the code. Every field is known to both ends before the Mac asks to confirm, because the QR carries the Mac's half and the hello the phone's, so nothing is added after the comparison. Someone who swaps any key on the way (a forged hello, a QR changed in transit) gives the two screens different numbers. Grinding a matching number needs about 2^66 key generations, instead of the one million that six digits allowed. The rotation of a pair's keys every 30 days is not implemented: see [rekey-design.md](../mobile-remote/rekey-design.md).

## When a session fails locally

A frame that does not open (a repeated or rewound counter, a gap, a failed tag) is dropped and counted; it changes nothing and cannot end the session. A gap is also told to the phone (`pair.resync`, at most once a minute), and the phone checks the notice with one request before it tells the person anything. A local failure (more than 64 frames or 4 MB waiting to be read, or a failed save of the receive counters) **pauses** the pair's session instead: frames that arrive are held without an acknowledgement, a failed save puts the counters back to what was saved, and the relay client reconnects (waits of 0.5 s doubling up to 30 s while pauses keep coming) so the durable mailbox sends every unacknowledged frame again, in order. The new relay connection reopens the session. Replies stay possible while it is paused. A new relay socket reopens the paused session as soon as it is being made, before its hello, because the relay may send its backlog ahead of the hello. Pauses that keep coming within a minute wait longer each time (0.5 s doubling to 30 s); a quiet minute starts the wait over, so one phone cannot make the Mac reconnect to the relay more than twice a minute for long. The receive queue holds up to 256 frames or 4 MB per phone.

Limits on what a paired phone's bad frames can cost: reading a frame walks one hash step per skipped counter before its tag is checked, so each phone has a budget of 8,192 steps that refills at 1,000 a second (measured on a clock that never goes back); a frame it cannot afford yet waits its turn, so frames are still read in order and none is lost or read past, and forged frames slow a pair for seconds but never pause or close it. Frames in order, and frames refused before any walk (replayed, rewound or more than 4,096 ahead), cost one step. A frame more than 4,096 ahead is dropped, counted as a gap and may send the phone the `pair.resync` notice (at most once a minute per pair; the phone checks it with a probe), because the check happens before the tag can be verified. Nothing is logged per frame; the counts are kept per phone and shown with its entry in Mobile Remote's status (`remoteSettings:state`, `devices[].frames`: dropped, duplicates, gaps, held, throttled, paused), and in total in `channel.stats`, which the dev host logs when a session pauses or comes back. With a relay that does not keep frames until they are acknowledged, frames held during a pause are lost.

## Relay delivery

The Mac and the phone exchange sealed frames through the relay (`relay/`), which sees ciphertext only. This page describes how a frame is kept and delivered; the wire is `relay/src/frames.mjs`, and the peer side of the receipt is `shared/remote/ack.mjs`.

### Plain mailbox (the original behavior)

A frame for a peer that is connected goes out live. Otherwise it is stored in `relay_mailbox` and sent when the peer connects, and each batch is **deleted once the socket took it**. A backlog is therefore lost if the connection dies, or the receiving app crashes, after the send and before the frame is saved. This is the known limit the durable mailbox removes.

### Durable mailbox (acknowledged delivery)

Enabled by giving the `Hub` a `DurableStore` (`durable` option); the relay's hello then carries `acks: true`. The relay process builds one by default (`relay/src/main.mjs`, transactions through `relay/src/pgTransaction.mjs`, one dedicated pool connection per call) and migrates `remote_durable` at start; `DURABLE_MAILBOX=0` returns to the plain mailbox.

- **Store first.** A frame with counter ≥ 1 is stored (`remote_durable.frames`), whether or not its peer is connected. The sender gets `{ t:'ack', pair, dir, ctr, via:'mailbox' }`. The peer, if connected, is then sent every stored frame it has not been sent on this connection, in counter order.
- **Stay until acked.** The receiver sends `{ t:'ack', pair, dir, ctr }` (`dir` is the direction the frame travelled: the Mac acks `p2m`, the phone `m2p`) once the frame is safely its own. Only then does the relay delete it. The two `ack` messages differ by direction: relay→sender carries `via`, receiver→relay does not.
- **Redelivery.** A new connection starts with nothing sent, so every unacked frame is sent again, oldest first. A connection never sees the same frame twice.
- **Idempotent.** The same frame sent again is acked again (stored once). Other bytes under a stored counter are refused (`ctr_conflict`). A counter at or below the pair's high-water mark with no stored frame was already acked or expired: the sender gets `via:'consumed'`. For that to be true, a frame whose storing throws (a database error) is tried again in place; if it still fails the sender gets `unavailable` and the connection is closed `4500` with nothing queued behind it stored, and a sender that resends its unacknowledged frames after reconnecting starts again from it. A repeated or unknown receipt changes nothing; a receipt for the wrong direction, a stranger's pair or a revoked device is an error.
- **Caps and TTL.** Per-pair frame and byte caps (`mailbox_full`) and a 7-day TTL come from the relay's config. The sweep expires frames past the TTL and tells the sender with the existing `mailbox.dropped` event, now or at its next connect; the notice is removed only after the sender's socket took it. Expired frames are never delivered, even before the sweep runs.
- **Counter 0.** Pairing hellos stay on the plain mailbox: they carry no ratchet counter.
- **Epochs.** The wire carries no epoch; the relay resolves it per pair and re-resolves when a removed pair is created again.

### Peer rules (Mac and phone)

A peer acks only when the outcome is final (`ReceiptOutcome` in `shared/remote/ack.mjs`), and only when the hello said `acks: true`:

| Outcome | When | Ack |
| --- | --- | --- |
| accepted | the receive ratchet is saved (the Mac saves before dispatch; keep that order) | yes |
| duplicate | the ratchet is already past the frame (a redelivery after a lost ack or a crash between save and ack) | yes, then ignore it; do not close the session |
| dropped | forged, malformed, unknown or closed session, a session retired mid-flight | yes |
| retry | the save failed | no; the relay redelivers after the next reconnect |

On a relay without acks the Mac keeps the old rule: a repeated or rewound counter closes the pair's session.

### Not covered

- No multi-process PostgreSQL test of the pool runner: it is tested with a fake pool and an in-process database.
- Revocation does not take the pair lock (see `remote-durable-store.md`), so a revoke racing a send is not serialized.
- Delivery within a live connection is TCP's: a frame sent on a socket that dies silently is resent only on the next connection.
- The phone adopts the contract in `shared/remote/phoneRelay.mjs` (`acker`, enabled by the hello) and `phoneSession.mjs` (ack after the vault saved the ratchet; a redelivery is acked and ignored). Tested with fakes; not exercised against a real relay and a real device.
- Exactly-once execution is not promised: a crash after the save and before dispatch can lose the dispatch, as before.
