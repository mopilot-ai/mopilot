# Spike: Mobile Remote M0

Questions (from milestones.html M0): do `sodium-native` (Mac) and `react-native-libsodium` (phone) seal the same frame, is a ~100-line in-memory relay enough for routing, mailbox and presence, does an Expo dev client carry libsodium, and what does iOS really allow in the background?

## Run

```bash
npm install
npm run vectors    # rewrites vectors.json (deterministic; the file is checked in)
npm run interop    # 30 checks: both libraries against vectors.json, cross-sealing, replay and tamper cases
npm run bench      # relay scenarios + 1000 round trips on localhost; writes result.json
```

Files: `crypto.mjs` (frame, ratchet, replay guard, two backends), `relay.mjs` (the relay, 102 lines), `interop.mjs`, `bench.mjs`, `vectors.json`, `result.json`, `expo/` (dev-client skeleton). Nothing here ships; `apps/mobile` and `electron/remote` are other sessions' areas.

## Construction under test

- X25519 between the two identity keys, then `HKDF-SHA256(salt = "mopilot-remote/v1|macId|phoneId", info = "dir:p2m" | "dir:m2p")` gives one chain key per direction.
- Symmetric ratchet: `mk = HKDF(ck, salt = 0^32, "mk")`, `ck' = HKDF(ck, salt = 0^32, "ck")`, one step per counter. A rewound counter cannot be opened even if the guard were missing, because the chain only moves forward.
- Frame `{ pair, dir, ctr, nonce, box }`; `box` is XChaCha20-Poly1305 (`crypto_aead_xchacha20poly1305_ietf`) with AAD `pair || 0x00 || dir || 0x00 || u64be(ctr)`. The header is authenticated, never encrypted.
- Receiver rule: `ctr` must exceed the last accepted one (`replay`), may skip at most 1000 (`gap`), and receiver state moves only after the box authenticates, so a forged frame cannot desync the ratchet.

## Result (2026-10-26, Node 24, macOS arm64)

| Check | Outcome |
| --- | --- |
| Interop | **Works.** `sodium-native` 5.2 and `libsodium-wrappers` 0.8.4 reproduce `vectors.json` byte for byte (keys, boxes) and open each other's frames (200 random frames each way). 30/30 checks pass. |
| Replay / rewind | **Rejected** by the receiver, also when the relay forwards the duplicate. Changing `ctr` in the header fails authentication; changing `dir` or `pair` is refused on routing. A forged frame leaves the ratchet unchanged. |
| Relay | **102 lines**, `ws`, in memory: per-pair mailbox (cap 1000 frames, TTL, `dropped` notice to the sender), presence (`online`/`gone`), ping/pong (3 missed = gone), frame validation (256 KB, header shape). It sees only `pair`, `dir`, `ctr` and the box size. Push hook fires when a frame is queued for an offline peer. |
| Round trip, localhost | Mac (`sodium-native`) → relay → phone (`libsodium-wrappers`) → relay → Mac, 1000 samples after 100 warm-up: **p50 0.4 ms, p95 1.3 ms, p99 2.7 ms, max 5.6 ms** (seal + open on both sides included). This is the floor. The Wi-Fi bar (300 ms) is dominated by the network and the relay's location, not by crypto. Not measured here. |
| Expo skeleton | `expo/` typechecks (`tsc`), `expo config` resolves the `react-native-libsodium` plugin, and `expo export --platform ios` bundles the screen to a 1.87 MB Hermes bundle. The screen opens the shared vectors with `react-native-libsodium`. **No native build or simulator run was done** (see Unverified). |

## What did not work, and what changes

1. **`react-native-libsodium` 1.7.0 has no X25519.** Its native module exports no `crypto_scalarmult`, `crypto_scalarmult_base` or `crypto_kx_*` (only `crypto_box_keypair`/`seed_keypair`, `crypto_box_easy`, `crypto_sign_*`, `crypto_sign_ed25519_pk_to_curve25519`; the type file lists more than the JSI layer implements). The skeleton uses `@noble/curves` `x25519` for key agreement; it matches `sodium-native` on public keys and shared secret (checked). It runs once per pairing or rotation, so pure JS is fine. The alternative is a patch upstream or a small local native module.
2. **HKDF-SHA256 exists on the phone only as `_unstable_crypto_kdf_hkdf_sha256_extract/expand`** (native build). `libsodium-wrappers` 0.8.4, including the sumo build, has the HKDF constants but no HKDF function and no SHA-256 in the standard build. The wrappers backend here builds HKDF from `crypto_hash_sha256` in `libsodium-wrappers-sumo`, and matches `node:crypto` `hkdfSync`. Consequence: the app must pin `react-native-libsodium`, and `App.tsx` runs the vectors at launch as an on-device self-test, so an API change fails loudly.
3. **`sodium-native` has no HMAC/HKDF.** The Mac side uses `node:crypto` for HKDF (fine in Electron main).
4. The wrappers stand-in is not the phone library. It proves the wire format and construction, not the React Native binding. Differences that matter are items 1 and 2.
5. In the bench, a reconnecting client must keep its ratchet state across sockets (the phone persists `ck` and `last` per pair, e.g. in the Keychain). A fresh session cannot open queued frames; the test reuses the old receiver for that reason. M1 must store ratchet state durably on both sides.

## iOS background (research, sources below)

What Apple documents, and what follows for the design:

- **No held socket.** iOS "suspends your app shortly after the user has moved it to the background", and there is "no general-purpose mechanism for running code continuously in the background" or "resuming in the background in response to a network or IPC request" (Apple DTS, *iOS Background Execution Limits*). A running app keeps its sockets; a suspended one does not run code, so the WebSocket is dead until the app runs again. `UIApplication` background tasks give a short grace period (about 30 s per DTS in the forum thread), enough to finish a send, not to wait for work. Background modes such as audio or VoIP must not be used to keep a socket alive (App Review 2.5.4). A dead connection can take over a minute to surface via `sendPing`, so the app must reconnect and drain the mailbox on every foreground, not trust the old socket.
- **Silent push is a hint, not a transport.** `content-available: 1` with `apns-push-type: background` and `apns-priority: 5` wakes the app for about 30 s, but "the system doesn't guarantee their delivery", may throttle ("don't try to send more than two or three per hour"), holds only the newest one while waiting, and discards it if the app was force-quit; the user launching the app delivers it. Low Power Mode and rarely used apps are throttled further (secondary source). So the mailbox is the source of truth and a silent push only shortens the delay; the app drains on launch and foreground.
- **Visible push + Notification Service Extension is the reliable path.** An alerting push with `mutable-content: 1` and an `alert` with title/subtitle/body runs the extension, which has about 30 s to rewrite the content (Apple's own example "decrypts the contents of a secret message"); on timeout the original payload shows. It does **not** run for silent or sound/badge-only pushes. For the design's fixed-title push ("Needs you", empty body) this means the alert must carry a title, which the design already has. For the opt-in chat title the relay sends a sealed blob in a custom key and the extension decrypts it.
- **What the extension needs, and the design does not yet say.** It is a separate native target with its own process and tight memory (commonly cited ~24 MB, unverified). It needs libsodium linked into the extension (Swift/C, not the React Native module), the pair's decryption material in a shared Keychain access group + App Group, and a ratchet that tolerates the extension and the app both consuming counters (it must not advance the app's state on its own; use a per-notification key or a read-only peek). Android's FCM data message has no such constraint. In Expo, this requires a config plugin or a custom native target, which is a prebuild/EAS step, not JS.
- **Design impact.** Push + mailbox is confirmed as the model (the M0 risk "iOS background sockets behave as assumed (they don't stay open)" is retired by documentation, not by a device run). Wording to change: M0 acceptance says "iOS wakes the app on a push and drains the mailbox"; that must read "usually, within the throttle limits, never after a force-quit", and "needs you" must be an alerting push, not a silent one.

Sources: Apple, [Pushing background updates to your App](https://developer.apple.com/documentation/usernotifications/pushing-background-updates-to-your-app) · Apple, [Modifying content in newly delivered notifications](https://developer.apple.com/documentation/usernotifications/modifying-content-in-newly-delivered-notifications) · Apple Developer Forums, [iOS Background Execution Limits](https://developer.apple.com/forums/thread/685525) · Apple Developer Forums, [Prevent WebSocket from closing when app goes into background momentarily](https://developer.apple.com/forums/thread/716118) · Apple Developer Forums, [Keep a socket server alive in the background](https://developer.apple.com/forums/thread/750136) · Pushwoosh, [content-available and mutable-content](https://help.pushwoosh.com/hc/en-us/articles/36024371569053-iOS-Push-Payload-Keys-content-available-and-mutable-content) (secondary; Low Power Mode claim) · [react-native-libsodium](https://github.com/serenity-kit/react-native-libsodium) 1.7.0 source (`src/lib.native.ts`).

The two Apple documentation pages were read from Apple's documentation JSON; the forum threads partly via a summarizer, so the quoted DTS lines are exact only for 685525.

## Unverified

- A native dev-client build and an iOS simulator run (whether `react-native-libsodium` links and the self-test screen shows PASS). Per AGENTS.md, native builds and simulator runs go through `scripts/vm-exec.sh` in a VM; not done in this session.
- `npm install` in `expo/` ran the library's postinstall (unpacks prebuilt libsodium); in a CI or an install with `--ignore-scripts` it would not, and the native build would fail.
- `sodium-native` inside the packaged Electron app (it uses N-API prebuilds; the Node run here is not Electron).
- Anything on a real device: silent push wake-up, throttling in practice, Notification Service Extension decryption, WebSocket behaviour across lock/unlock, battery.
- Wi-Fi round trip, any real relay host, TLS, authentication (the spike relay has none).
- The `card.answer` through the real ApprovalBroker (the spike sends a sealed JSON string only; M1 owns the broker).

## Coverage gate

`design/` is outside the unit-coverage denominator (electron, src, shared, web), so these scripts add no exclusion and carry no unit tests; they are runnable documentation like `design/multi-harness/spike/`.
