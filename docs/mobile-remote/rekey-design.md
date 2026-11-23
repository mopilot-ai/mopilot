# Mobile Remote: pair key refresh (rekey)

Status: Part A (§4.3) is implemented (pairing version 2, tests in `tests/remotePairingEphemeral.test.ts`). Part B (§4.4 onward, the rekey exchange) is a proposal for the external cryptographic review and is not implemented. Closes gap P9 of `design/mobile-remote/status.md` once both are in. Written to be read without the code; file and function names are given so a reviewer can check each claim. A first review pass against the code (counter anchoring, redelivery, stale accepts, a lost final message, migration) changed the design from an earlier draft; §8 lists what changed.

## 1. Why

The design promised "pair keys rotate when either side asks, and every 30 days" (`design/mobile-remote/protocol.html`, Revocation and rotation). Today nothing rotates: `DeviceList.dueForRotation()` reports pairs whose `rotatedAt` is 30 days old and calls an `onRotationDue` hook, but nothing sets that hook, nothing calls `checkRotation()`, and `rotatedAt` is only ever the creation time (`electron/remote/deviceList.cjs`). There is no rekey message on either side.

Reading the key schedule for this document turned up a larger issue than the missing timer. **Until part A landed, the root key was a pure function of the two static identity keys and the two device ids** (`deriveRoot`, `shared/remote/crypto.mjs`): `root = HKDF(X25519(idSk, peerIdPk), "root|macId|phoneId")`, and both direction chains start from it (`dirKey`), with no one-time code, pair id or ephemeral secret in it. Consequences for pairs made that way:

1. A later leak of either identity secret key (Mac `safeStorage`, phone Keychain) lets whoever recorded the ciphertext decrypt **all of it**, from counter 1. The relay keeps up to 7 days of ciphertext and a malicious relay can keep more. The per-message ratchet gives forward secrecy against a leak of chain state, not of the identity key.
2. Removing a device and pairing it again with the same ids and identity derives **the same root and the same chains**. Anyone who kept the identity secret key or the root (a former holder of the phone's state, a backup) reads the new pair too.
3. A leak of chain state is never repaired: nothing mixes in fresh secret material, so the attacker keeps up by ratcheting. That is not post-compromise security (the design page flagged this as open).

A fresh ephemeral Diffie-Hellman fixes all three. So this document proposes: (A) ephemerals in the pairing hello for **new** pairs, (B) a rekey exchange that existing pairs run once on upgrade, every 30 days and on request.

## 2. What exists and is reused

| Piece | Where |
| --- | --- |
| Identity keys: X25519 (agreement) and Ed25519 (signing) per device; the peer's Ed25519 public key is stored at pairing (`PhonePair.macEdPub`, `Device.edPub`). `edSign`/`edVerify` exist in both primitive sets but **nothing calls them**: the Ed25519 keys authenticate nothing today, and (until version 3) the user-compared safety number covered only the X25519 public keys; since version 3 it covers the Ed25519 keys too | `identity.cjs`, `phonePairing.mjs`, `sodiumPrimitives.cjs`, `phonePrimitives.mjs`, `crypto.mjs` `pairTranscript`, `safetyNumber` |
| Per direction: one strictly increasing counter, chain `step(chain) -> {key, next}` (key for counter `ctr+1` is `HMAC(chain,1)`, next chain `HMAC(chain,2)`), XChaCha20-Poly1305, AAD `mopilot-remote-v1|pair|dir|ctr`, `MAX_SKIP` 4096 | `crypto.mjs` |
| Durable per-pair state: `tx`/`rx` `{ctr, chain}`, `rotatedAt`; atomic update on the phone (`vault.updatePair`) and on the Mac (`devices.update`, sealed file); the Mac saves rx before dispatch, the phone commits rx inside `updatePair` | `deviceList.cjs`, `phoneVault.mjs`, `channel.cjs`, `phoneSession.mjs` |
| Relay: ordered, acknowledged, at-least-once delivery, 7-day mailbox. The durable store accepts counters with gaps, acks a repeat as `duplicate`, rejects different bytes under a stored counter (`conflict`), and for a counter at or below the stream high-water with no stored frame answers `expired` (the sender sees an ack with `via: "consumed"`). The counter is stored in the clear. The word "epoch" in `relay/` means a pair incarnation; this document says **generation** (`gen`) for a key generation to avoid the clash | `relay/src/durableStore.mjs`, `durableMailbox.mjs`, `hub.mjs` |

## 3. Prerequisites that are missing today

These are existing gaps a rekey bug would fall into; they are recorded as rows R1 and R2 in `status.md` and should land first:

- **R1.** The Mac's channel sends a sealed `pair.resync` notice when it closes a session (`channel.cjs`), but no phone code consumes it.
- **R2.** A closed Mac session never reopens: `#close` sets `s.closed`, and `#sync` skips existing sessions, so a `gap`, `header` or `replay` error is an outage until the app restarts or the device is removed. A rekey bug that ends in one of these must not have that cost; the channel needs a "session failed, re-pair required" state the UI shows, or a reopen path.

## 4. Design

### 4.1 Goals and non-goals

Goals: fresh secret material in every generation; forward secrecy across generations even if an identity key leaks later; recovery after a chain-state leak; **no change to the relay, the frame format or the nonce**; no frame lost, duplicated or stranded by a rekey; an offline device is never locked out by a half-finished rekey.

Non-goals: protecting against theft of an identity secret key (that is a re-pair, as the design says); post-quantum; hiding that a rekey happened.

### 4.2 State

Per pair, on each device, in the existing durable record (legacy `tx`/`rx` stay as the active generation, so a downgrade reads a valid record):

```
gen        uint32   current key generation, 0 for pairs made before this feature
rk         32 bytes rekey key of `gen`
tx, rx     { ctr, chain }       as today, for `gen`
next       null | { gen+1, rk', txChain, rxChain, a, b }   the pending generation, once derived
rotatedAt  ms       when `gen` began
```

The per-direction counter stays one strictly increasing sequence across generations, so the relay's counter handling and the acknowledgements need no change. A generation switch is announced by the sender's last frame under the old generation (a **boundary frame**, §4.4); every frame with a higher counter uses the new generation. Receivers pick the chain by counter, never by a tag in the frame.

Migration: existing pairs have no `rk`. Both ends compute `rk_0 = HKDF(salt = LABEL, ikm = root, info = "rk|0")`, since `root` is derivable from the static keys they already hold. No re-pair is needed.

### 4.3 Part A: new pairs get an ephemeral at pairing

The hello (phone → Mac) and its reply are already sealed under a key bound to the one-time QR code (`helloKey`). Add `ephP` (hello) and `ephM` (reply), X25519 public keys, inside those sealed bodies, and derive

`root = HKDF(salt = LABEL, ikm = X25519(idM, idP) || X25519(ephM, ephP), info = "root|2|macId|phoneId|pairId")`

then chains and `rk_0` from it as today. The pair id (derived from the one-time code) is now an input, so re-pairing never reproduces a root. Forward secrecy holds from the first message; gen 0 of a new pair needs no rekey. The ephemeral secrets are deleted as soon as `root` is computed.

### 4.4 Part B: the rekey exchange (existing pairs, 30 days, on request)

The Mac initiates. A phone may ask. Control messages are `kind: "event"` frames, sealed like any other, with `ev` one of the names below; they are parsed in the receive path **in the same durable write that advances the ratchet** (Mac: inside `#openFrame` before the rx save; phone: inside the `updatePair` callback of `receive`), because they need the frame counter, which the dispatch path does not expose today.

| Message | From | Content |
| --- | --- | --- |
| `rekey.request` | phone | `{gen}` the generation it holds |
| `rekey.offer` | Mac | `{gen: g+1, ePubM, sig}` |
| `rekey.accept` | phone | `{gen: g+1, a, ePubP, sig, confirm}` |
| `rekey.commit` | Mac | `{gen: g+1, confirm}`: the Mac's boundary frame |
| `rekey.ack` | phone | `{gen: g+1}`: the phone's boundary frame |

`a` is the offer's counter, `b` the accept's, `c` the commit's, `d` the ack's; all are frame-header counters, so both ends know them. Transcript `T` is a canonical length-prefixed encoding of: `LABEL`, `"rekey"`, `pairId`, `macId`, `phoneId`, `g+1`, `a`, `b`, `ePubM`, `ePubP`; `H(T)` is its SHA-256.

- `offer.sig = Ed25519(macEdSk, LABEL | "offer" | pairId | macId | phoneId | g+1 | a | ePubM)`
- `accept.sig = Ed25519(phoneEdSk, LABEL | "accept" | H(T))`. `T` includes `ePubM` and `a`, so the accept is bound to exactly one offer.
- `dh = X25519(ephM, ePubP)`; reject an all-zero result. `rk' = HKDF(salt = rk, ikm = dh, info = "rk'" | hex(H(T)))`. New starting chains `dirKey'(d) = HKDF(salt = LABEL, ikm = rk', info = "dir|" | d | "|" | g+1)` (the HKDF `info` is text in `crypto.mjs`; binary inputs are hex encoded).
- `accept.confirm = HMAC(rk', "accept" | H(T))`, `commit.confirm = HMAC(rk', "commit" | H(T))`.

```
Mac                                        Phone
 |-- offer(ePubM, sig)  at m2p ctr a ------>|  verify sig (pinned macEdPub), gen = g+1; make ephP; derive rk', chains
 |                                          |  one write: store `next`, allocate p2m ctr b
 |<-- accept(a, ePubP, sig, confirm) b -----|  still sealed under gen g
 |  verify sig and confirm; derive rk'      |
 |  one write: store `next`; seal commit under gen g at m2p ctr c; set tx = {ctr: c, chain: dirKey'(m2p)}
 |-- commit(confirm)  at c ----------------->|  verify confirm; one write: rx = {ctr: c, chain: dirKey'(m2p)}, old rx deleted
 |                                          |  seal ack under gen g at p2m ctr d; set tx = {ctr: d, chain: dirKey'(p2m)}
 |<-- ack  at d ----------------------------|
 |  one write: rx = {ctr: d, chain: dirKey'(p2m)}, old rx deleted; gen = g+1, rk = rk', rotatedAt = now, next = null
 |  (the phone does the same final write when it seals the ack)
 |  from here both sides seal and open under gen g+1
```

Rules that make this safe (the part to check closely):

1. **A sender switches only after proof the peer can read the new generation.** The Mac switches (commit) only after a valid `accept` (its `confirm` proves the phone derived `rk'`, and the phone stored `next` in the same write that sent the accept). The phone switches (ack) only after a valid `commit`. Neither side is ever sending a generation its peer cannot open.
2. **A receiver switches by counter.** After the peer's boundary frame at counter `x`, the new rx state is `{ctr: x, chain: dirKey'}`; the next frame (`x+1`) opens with the first step of the new chain. Old-generation frames all have counters ≤ `x`. A redelivered old frame has a counter at or below the receiver's `ctr` and is a `rewind`/`replay`, which the existing code already acknowledges as a harmless duplicate (`channel.cjs`, `phoneSession.mjs settleFailure`). It never reaches a chain lookup that has been deleted. No anchoring at the offer or accept counters, so `MAX_SKIP` cannot be exceeded by frames sent while the exchange was waiting.
3. **Stale or unmatched messages are ignored silently.** An `accept` whose `a` or `H(T)` does not match the Mac's pending offer, or a `commit` that does not match the phone's `next`, changes nothing and sends nothing. There is no `rekey.failed` message: it would be forgeable by anyone holding chain state, which would let them abort every rekey and defeat post-compromise recovery. The initiator simply retries on a timer.
4. **Pending state.** The Mac keeps `ephM` and the offer in memory only; a crash abandons the offer (a later `accept` finds none and is ignored). The offer expires after 1 hour. The phone persists `next` (no ephemeral secret) and replaces it when a newer offer arrives.
5. **Exactly-once effects.** Every row marked "one write" is a single durable update together with the ratchet advance of the frame being handled, so a crash leaves either the state before or after, never half. If the phone's accept is written but never sent (`o.send` fails after the write), its counter is a skipped counter, which receivers already tolerate, and the Mac's offer expires and is re-issued.

### 4.5 Triggers and policy

- 30 days since `rotatedAt`, checked at service start, daily, and when the relay reports the phone online; also after 2^20 messages sealed in one direction in a generation; also when the user taps "Refresh keys" on the Mac, or on the phone (a `rekey.request`).
- One offer outstanding per pair. Offers at most once per hour and `rekey.request` at most once per hour per pair; the counters are durable (an app restart does not reset them).
- Existing pairs run the exchange once at the first connection after the upgrade, before ordinary traffic is served, so that no content is protected only by static keys longer than necessary.
- Soft deadline: if `rotatedAt` is 37 days old (30 plus 7) the Mac answers every method except `rekey.*` and `device.unpair` with `error.code = "rekey_required"`; the phone shows "Refresh keys" and the Mac lists the device as "needs key refresh". Open question: hard expiry (§7).

## 5. Threat analysis

| Attack | Result |
| --- | --- |
| Relay or network drops, delays, reorders or duplicates rekey frames | Counters and AEAD decide as for any frame. A lost `offer` or `accept` leaves generation g in force on both sides (rule 1); the initiator retries. A lost `commit` or `ack` is a lost ordinary frame: the existing `mailbox.dropped` handling (session interruption, R1/R2) applies, as it does for any frame; a rekey adds no new failure mode that way. |
| Relay strips or blocks rekey frames | Denial of service only: the pair stays on g until the soft deadline shows the user. An endpoint never accepts an older generation (the old chain is deleted at the boundary). |
| Relay replays an old offer | The sealed frame is rejected by its counter; a recorded plaintext offer cannot be wrapped in a new frame without the chain key. |
| Attacker with current chain state, no identity key | Can read and forge ordinary frames until the next rekey, but cannot sign an offer or accept, so cannot join the exchange: the next rekey locks it out. It can drop or delay rekey frames only like the relay can. |
| Attacker with an identity secret key | Impersonates that device: treat as a lost device, remove and re-pair (unchanged). Earlier generations stay safe: their ephemeral secrets were deleted. |
| Forged `rekey.request` flood by a chain-state holder | Costs one hour of the request budget; the Mac's own timer is unaffected. Over-limit requests are dropped silently (an error reply would consume mailbox quota). |
| Different `rk'` on the two sides (bug, tamper) | `accept.confirm`/`commit.confirm` fail; the exchange is abandoned silently (rule 3); generation g continues. |
| Crash mid-exchange | Rule 5; the Mac's in-memory offer is lost and re-issued; the phone's `next` is replaced by the next offer. |
| State that is behind the peer's (backup restore) | Counters only move forward; `rewind`/auth failure ends the session as today (R2). Recovery is re-pair. |
| Unknown-key-share, reflection | Signatures and MACs cover `pairId`, both device ids, both ephemerals and both counters under a versioned label. |
| Re-pair reproduces a root (§1, finding 2) | Fixed for new pairs by §4.3 (pair id and ephemerals are inputs) and for existing ones by their first rekey. |

## 6. Failure and recovery

- An abandoned exchange has no message. The Mac retries after 1 h, 6 h, 24 h while the phone is online; the next offer is a new attempt with the same target generation and a different transcript.
- Phone offline: the offer waits in the mailbox up to 7 days; if the mailbox drops it, the Mac discards its pending offer and retries when the phone is next online. A device returning after the soft deadline can still rekey (it is the one method allowed).
- Corrupt or missing `rk`/`next`: treated like corrupt ratchet state today: the pair is unusable until re-paired, and the UI says so (R2).

## 7. Questions for the reviewer

1. Is transcript signing with the identity Ed25519 keys plus a fresh ephemeral DH enough, or should each rekey also mix static-ephemeral DHs (`X25519(ephM, idP)`, `X25519(idM, ephP)`, as Noise XX does) for key-compromise-impersonation resistance? Two more scalar multiplications per side.
2. Is the switch rule (§4.4 rules 1 and 2: each direction switches at the sender's boundary frame, only after proof the peer holds the new keys) enough to exclude a stranded pair in every crash, loss and redelivery interleaving? A model of the five messages in Tamarin or ProVerif is proposed as part of the review.
3. The intended statement: `rk' = HKDF(rk, dh, T)` is secret if the ephemeral DH is secret **or** `rk` is. After a leak of chain state alone, the next rekey restores secrecy and the attacker cannot take part (no signing key). After a leak of `rk` (stored in the same record as the chains) together with a passive record of the next exchange, `rk'` is still not derivable without an ephemeral secret. Is that the right statement, and does keeping `rk` next to the chains weaken it in practice?
4. 30 days and 2^20 messages: right pair of triggers?
5. Should a pair that never rekeys expire (proposal: hard stop at 90 days, then re-pair)?
6. Part A changes the pairing hello and reply bodies (sealed under the code-bound key). Does it alter the pairing proof or the safety number's meaning? Resolved with the version 3 wire: the proof is unchanged and the safety number covers the Ed25519 public keys, both ephemeral keys, the ids and the pair id (see the safety number section of `docs/architecture/mobile-remote-desktop.md`). Open for the reviewer: whether the transcript should also be bound into the root key (it is not, so version 2 chains stay valid).

## 8. What changed after the first review pass

- Chains anchored at the offer and accept counters could hit `MAX_SKIP` after a long exchange and closed the session even with every frame delivered; now a switch is announced by a boundary frame and the new chain starts at that counter.
- A nonce epoch tag made redelivered old-generation frames fail as a missing chain; removed, receivers choose by counter and the existing duplicate handling applies.
- A forgeable, state-changing `rekey.failed` and a lost final `done` could strand a pair; there is no failure message now, and each direction has its own boundary frame sent only after proof of readiness.
- "Epoch" renamed to generation (relay clash); canonical transcript encoding and versioned signature labels; zero-DH check; durable rate limits.
- Added Part A (ephemerals in the pairing hello) so new pairs have forward secrecy from the first message, and prerequisites R1/R2.

## 9. Test plan

Unit (100% of changed lines):

- Shared vectors in `shared/remote/vectors.json` for `rk_0`, `rk'`, `dirKey'`, `confirm` MACs, signatures and the Part A root, run on the Mac (sodium) and on the phone (libsodium) to catch drift.
- State machine, table-driven over every step: lose, duplicate or reorder each of the five messages; crash before and after each durable write; offer replaced by a newer one; timer and phone request at once; stale `accept`/`commit` ignored with no reply; redelivered old-generation frames after the boundary are acknowledged as duplicates, never a closed session.
- Counter handling: more than `MAX_SKIP` frames sent between offer and commit still open; boundary counters at the maximum safe integer; chain start equals boundary.
- Attacks: wrong or cross-offer signature, replayed offer wrapped in a new frame, flipped `confirm`, generation skipped or repeated, zero DH, rate limit overrun, soft deadline (`rekey_required` with `rekey.*` still allowed).
- Migration: a pair with no `rk` rekeys, and then behaves like a pair made with Part A. A legacy peer without the capability bit is never sent `rekey.*`.

Full stack (`tests/support/mobileStack.ts`, real relay): Part A pairing; rekey while a turn streams and the user answers a card; relay restart between each pair of messages; phone offline across the offer (mailbox) and past the mailbox lifetime; revoke during a rekey; both devices agree on counters afterwards.

Invariants: the durable record holds at most the current generation and one `next`; no ephemeral secret key appears in any persisted record; the relay database contains no new plaintext (the existing zero-knowledge test, rerun with a recorded rekey).

Review and release: external cryptographic review of this document and the vectors before the first public TestFlight (already required by the milestones page); a Tamarin or ProVerif model of §4.4 as part of it.

## 10. Rollout

1. R1 and R2, then the capability bit (`rekey: 1` in `machine.hello`), `rk` storage and migration. No behavior change.
2. Part A for new pairs. Then the exchange, the first-connection rekey for existing pairs, the 30-day timer, limits, soft deadline and the Settings controls.
3. After one release, require the capability: the Mac refuses a phone that does not advertise it.

Size: about 700 lines of source and 1,400 of tests across `crypto.mjs`, `pairing.cjs`/`phonePairing.mjs`, `channel.cjs`, `phoneSession.mjs` and the two stores; 5 to 6 days including vectors and the full-stack cases, plus the external review.
