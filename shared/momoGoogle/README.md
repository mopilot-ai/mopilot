# MoMo Google connector (home side)

Design: Function 2 "Knows your work", section 3.3, decisions D7, D10, D17. Plain JavaScript (`.mjs` with `.d.mts` types, because the Host bundle follows only JS), no I/O of its own: the Host injects `fetch`, the clock, `safeStorage` and the file operations. Nothing is wired to a Host, a flag or the UI yet.

## Sign-in that finishes on the home (`consent.mjs`)

Google's device-code flow does not allow the Gmail or Calendar scopes, so the consent runs in a browser on a client, and only the **code** crosses to the home:

1. `GoogleConsent.begin({ purpose, redirectUri })` on the home: one-time PKCE verifier, `state` and an X25519 key, all in memory; returns `{ flowId, authUrl, sealTo, expiresAt }`. `redirectUri` must be `http://127.0.0.1:<port>/callback` (the client's own loopback).
2. The client opens `authUrl`, catches the redirect (`parseCallback`), and `sealHandoff(flowId, sealTo, hand)`s it. The relay and the phone carry ciphertext only.
3. `complete(flowId, sealed)` on the home opens it, checks state and redirect, exchanges the code with the verifier and the client secret, and saves the tokens through `GoogleAccount.connect`. A flow is single use and lives ten minutes; a stolen code is useless without the verifier.

Send-only step (D10): `purpose: 'send'` asks for `gmail.send` alone (`include_granted_scopes`, `login_hint`), refuses another account, and adds the scope to the grant.

iPhone: Google's Desktop client allows loopback only. A phone-started consent needs an iOS OAuth client (owner action); until then the phone asks the Mac, or the Mac client runs step 2.

## Pieces

| File | Owns |
|---|---|
| `account.mjs` | sealed record, single-flight refresh, `needs_sign_in` with a cause (`revoked`, `testing_expired`, `scope_missing`, `client_rejected`), disconnect with revoke, `export`/`import` |
| `store.mjs` | sealed account file and durable cursor store (the notice `VersionStore`) over the Host's `safeStorage` and file ops |
| `client.mjs` | `GoogleClient` of `momoNotice/types.d.ts` over `@googleapis/gmail` and `@googleapis/calendar` (the same Apache-2.0 libraries as `googleapis`, 2 MB instead of 240 MB in the Host bundle), plus `getMail` (headers whitelist, Gmail-only `Authentication-Results`, body cap) |
| `send.mjs` | `createSender`, single-use `createSendGrants` (`mint` for the approval gate only, `redeem` for the sender), `not_granted` when the scope is missing |
| `seal.mjs` | X25519 + HKDF-SHA256 + XChaCha20-Poly1305 sealed box over the shared remote primitives (node on the Host and Mac, libsodium on the phone) |

## Rules the review asked for

- OAuth endpoints are Google's, pinned in `clientConfig.mjs`; a client file only supplies the client id and secret. `configure` is refused while an account is connected.
- A refresh saves only into the record it started from (a lock, a generation and a compare of the grant); a disconnect, a new sign-in, a move or a pause makes an old reader or refresh drop its result. An account object is `dispose`d when the lease changes.
- One Google account: a sign-in for another account is dropped and revoked; disconnect first. A reconnect keeps the first connect day; the grant's own age (`grantedAt`) is what Testing mode counts.
- Errors out of the Google client are `GoogleApiError` (a status and Google's reason word); the raw error, which carries the bearer token, never leaves `client.mjs`. A 403 ends the grant only for a missing scope; rate limits, 429 and 5xx are retried after 1, 2 and 4 seconds (the HTTP client's own retries are off; a send is never retried).
- Every token answer is checked: both read scopes must remain, and `canSend` is only the scope really granted.
- Mail parts are cut before decoding; HTML is read in one linear pass. Cursors are pruned (5000) and written in batches. Wipe revokes at Google first (3 seconds at most), but not while the data is moving.

## Windows

Mail: the last 30 days before the connect day. Calendar: nothing before the connect day (the home's local day), up to 92 days ahead. Reads throw on 429/5xx, return `null` on 404/410, and a 401/403 marks the source `needs_sign_in`.

## Testing mode (closed alpha)

A project in Testing mode allows 100 listed test users and ends refresh tokens after 7 days (the `testing_expired` cause when `testingMode` is set); leaving it needs Google's verification (restricted Gmail scope).

## Move

The account file and the cursors live in MoMo's data folder (`<momo dir>/google/`), sealed with the home's data key in the shared `{enc:'safe', data}` envelope (the one every sealed MoMo file has, so the move's travel check opens them), so the move bundle of `host/src/momoMove.mjs` carries them with everything else, closed to the target's one-time move key. There is no separate export.
