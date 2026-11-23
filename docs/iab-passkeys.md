# System passkeys and security keys in the built-in browser (design spike)

Status: phase 1 implemented (§5). It waits on the entitlement (phase 0); until then the app keeps
Electron's own path. Phases 2 and 3 are open.

Scope: let pages in the built-in browser (IAB) on macOS use the
user's existing passkeys (iCloud Keychain / Apple Passwords, and third-party credential providers such
as 1Password that register with macOS), passkeys on a nearby phone (hybrid/QR), and USB/NFC security
keys, through the same system sheet Chrome and Safari show. Windows and Linux are out of scope here.

## 1. Today

- Electron 44 is the browser engine. Its whole WebAuthn surface is `app.configureWebAuthn({ touchID })`
  and the session's `select-webauthn-account` event. Nothing lets the main process see a
  `navigator.credentials.get/create` request or answer it. Nothing drives the security-key PIN,
  authenticator choice or phone (hybrid) UI, which live in Chrome's UI layer that Electron does not ship.
- A package signed with our provisioning profile turns on Electron's Touch ID authenticator
  (`electron/capabilities/browser/auth.cjs`, `scripts/signing.mjs` `webAuthnSigning`). Its passkeys are
  **new, device-bound, kept in MoPilot's own keychain group** (`<team>.ai.mopilot.code.webauthn`). It
  never sees iCloud Keychain, Chrome or password-manager passkeys. The installed build (team
  `7392DG77JZ`) has this group.
- `electron/capabilities/browser/passkeys.cjs` wraps `navigator.credentials` in each frame. It reports
  modal requests that hang, and its "Use another method" button ends them with `NotAllowedError`. It
  also fixes `getClientCapabilities` so sites stop offering the hybrid transport Electron lacks.
- The result: on a site that asks for "your passkey", the user's real passkey is unreachable. The pane
  offers another sign-in method or "Continue in Chrome".

## 2. Reference: how a real browser does it on macOS

Chrome 118+ (and, presumably, other Chromium browsers that hold the entitlement) calls
AuthenticationServices in **browser mode**. The browser computes the origin itself and hands macOS the
client data, so macOS serves any relying party, not only the app's associated domains:

| Need | API (macOS SDK 26.4, checked in the local headers) | Min macOS |
|---|---|---|
| Permission to list/use passkeys for websites | `ASAuthorizationWebBrowserPublicKeyCredentialManager requestAuthorizationForPublicKeyCredentials:` | 13.3 |
| Platform passkey create/get for any origin | `ASAuthorizationPlatformPublicKeyCredentialProvider` (`ASAuthorizationWebBrowserPlatformPublicKeyCredentialProvider`): `createCredentialRegistrationRequestWithClientData:name:userID:`, `createCredentialAssertionRequestWithClientData:` | 13.5 |
| Client data (origin, topOrigin, crossOrigin, challenge) | `ASPublicKeyCredentialClientData` | 13.5 |
| Phone / QR (hybrid) | `shouldShowHybridTransport` on the browser assertion request | 13.5 |
| Security keys (USB/NFC, with PIN UI by macOS) | `ASAuthorizationSecurityKeyPublicKeyCredentialProvider` (`ASAuthorizationWebBrowserSecurityKeyPublicKeyCredentialProvider`) | 14.4 |
| Autofill list (conditional mediation) | `platformCredentialsForRelyingParty:completionHandler:` | 13.3 |

All of this requires the managed entitlement
**`com.apple.developer.web-browser.public-key-credential`**. Apple grants it per App ID on request.
It goes in the provisioning profile like our keychain group. Without it the browser-mode calls fail.
Signing alone can't get around it.

We could not inspect Cursor (it is not installed here). Because it is also Electron, it most likely
uses this entitlement plus a native bridge. To confirm on a Mac that has it:
`codesign -d --entitlements - --xml /Applications/Cursor.app | plutil -p -`.

## 3. Options

| Option | Reaches real passkeys? | Verdict |
|---|---|---|
| A. CDP `WebAuthn` virtual authenticator | No. It holds its own keys, and iCloud private keys never leave the keychain. | Rejected |
| B. Separate helper app (like `native/helper`) calls AuthenticationServices | Yes | Rejected. It needs its own App ID with its own entitlement grant. The sheet would not attach to our window. macOS would list the helper, not MoPilot, under "Passkeys Access for Web Browsers". |
| C. Upstream Electron: `configureWebAuthn({ systemPasskeys: true })` routes Chromium's request to `device/fido/mac` iCloud Keychain and security-key code that Chrome already uses | Yes, with no page shim | The right end state. The timeline is not ours, so pursue it in parallel (phase 3). |
| **D. In-process native addon + page bridge** (recommended) | Yes | The main process (the app that holds the entitlement and the windows) calls AuthenticationServices. The page's `navigator.credentials` wrapper (already in `passkeys.cjs`) forwards requests to it. Password-manager extensions (1Password, Bitwarden) answer WebAuthn the same way. |

## 4. Design (option D)

### 4.1 Pieces

1. **Native addon** `native/passkeys` (Objective-C++, N-API, built for arm64 and x64 and signed with the
   app). Packaging already unpacks and signs `**/*.node` (node-pty's `pty.node`, `scripts/package.mjs`);
   only its build step is new. It exposes:
   - `available()`: macOS version ≥ 13.5 and the entitlement present (`SecTaskCopyValueForEntitlement`).
   - `authorize()`: the one-time "Allow MoPilot to use your passkeys" prompt.
   - `create(request, windowHandle)` / `get(request, windowHandle)`: these return a promise and a
     `cancel()`. They build platform + security-key requests (hybrid shown for both) from
     `ASPublicKeyCredentialClientData`, run one `ASAuthorizationController`, and anchor the sheet to
     the NSWindow behind `BrowserWindow.getNativeWindowHandle()`.
   - The result is plain bytes (credential id, clientDataJSON, authenticatorData, signature, userHandle,
     attestationObject, attachment, transports), or an error code. Each result is keyed by the
     controller that produced it, so a late delegate callback from a cancelled controller cannot answer
     a later request. The addon never throws into Node: Objective-C exceptions and nil arguments become
     error codes, because a crash here takes down the main process and every chat.
2. **Main bridge** `electron/capabilities/browser/passkeyBridge.cjs` (new) owns validation, the request
   queue and delivery. It never trusts anything the page says about where it is.
3. **Page shim**: an extension of `passkeyWatch` in `passkeys.cjs`. When the bridge is on for the page, a
   modal `get/create` with `publicKey` goes to a CDP `Runtime.addBinding` function. This needs new CDP
   work: `documentScripts.cjs` keeps sessions only for out-of-process frames and enables only the Page
   domain. At each arm the bridge adds only the binding to the page's own session. It turns on
   `Runtime.enable` the first time a page calls the binding from a context it doesn't know, because bot
   checks look for an enabled Runtime domain. It then tracks `executionContextCreated`
   (context → frame). If neither an answer nor an ack (sent when the sheet comes up) arrives within
   5 seconds, the wrapper takes Electron's path, so a call main never heard can't hang the page. The
   wrapper runs in the page's main world, so the
   binding is **not a secret**: any page script can call it. That is acceptable because calling it
   grants nothing the page couldn't get by calling `navigator.credentials` itself. Every check is in
   main (§4.2). The page side resolves an answer only by a single-use request id held in the wrapper's
   closure, so a new document never receives an old answer. The answer comes back through
   `frame.executeJavaScript` and is built into an object whose
   prototype is `PublicKeyCredential.prototype`. Its own `id`, `rawId`, `type`, `response`
   (`AuthenticatorAttestationResponse`/`AssertionResponse` shape, including `getPublicKey`,
   `getAuthenticatorData`, `getTransports`), `authenticatorAttachment`, `getClientExtensionResults()` and
   `toJSON()` match what password-manager shims return.
4. **Pane**: the existing "waiting for a passkey" notice becomes "Finish in the passkey window" while
   the system sheet is up. It keeps "Use another method", "Continue in Chrome" and, for passkeys made
   in older builds, "Use a passkey saved in MoPilot" (§4.4).

### 4.2 Change contract

- **Invariant:** A browser page gets a WebAuthn result only for a relying party its own frame origin is
  allowed to use. Each request gets exactly one answer: a credential, `NotAllowedError`, `AbortError`,
  `InvalidStateError`, `SecurityError`, `TypeError` or `NotSupportedError`. That answer reaches only
  the document that asked.
- **Owner:** `passkeyBridge.cjs` in main. It derives the origin, top origin and cross-origin flag from
  `WebFrameMain` (`frame.origin`, the main frame's origin) for the context that called. It never uses
  anything from the payload for this, the document name included. The page shim only carries requests.
- **Input validation (before the addon):** types and lengths are checked against the WebAuthn IDL:
  `challenge` and `user.id` are buffers, `user.id` ≤ 64 bytes, `allowCredentials` and
  `excludeCredentials` are capped, and `pubKeyCredParams` is limited to algorithms macOS supports.
  A malformed request gets `TypeError`; an unsupported one gets `NotSupportedError` and never reaches
  native code. Extensions we don't serve are dropped. The `appid` extension is checked like an RP ID,
  or dropped.
- **RP ID check:** the `rpId` defaults to the origin's host. Once lowercased, punycoded and stripped of
  a trailing dot, it must equal the host or be a registrable-domain suffix of it, ignoring the port.
  IP-literal hosts get `SecurityError`, as in Chrome. The origin must be secure: https, or http on
  `localhost` / `*.localhost`. Opaque origins (`data:`, sandboxed `srcdoc`, which report `"null"`) fail.
  `about:blank` and unsandboxed `srcdoc` frames inherit their creator's origin through `frame.origin`.
  The check needs a real Public Suffix List: add `tldts` **with `allowPrivateDomains: true`**, so
  `github.io` counts as a suffix. The heuristic in `import/sites.cjs` is not safe for this. Related
  origins (`/.well-known/webauthn`) are refused in phase 1 and fall back to today's path. **Without
  this check, any page could get assertions for any site, which would be phishing.**
- **Response check:** the returned clientDataJSON's `type`, `challenge` and `origin` must match what was
  sent; otherwise `NotAllowedError`.
- **Frames:** phase 1 serves a frame only when every ancestor up to the main frame has the same origin,
  and the main frame's response carries no `Permissions-Policy` that denies
  `publickey-credentials-get/create`. Policy that can't be read counts as denying. Anything else
  (cross-origin iframes, nested A-in-B-in-A) keeps today's native path.
- **Focus:** only the tab showing in the pane, in a focused window, may raise the sheet, as Chromium
  refuses unfocused documents. A background tab gets `NotAllowedError` and its pane notice says why.
- **Invalidators:** the frame navigates or is destroyed, the tab closes, is hidden or loses the pane,
  the renderer exits, the page calls `signal.abort()`, the request's `timeout` passes (default 5
  minutes, since `ASAuthorizationController` has none), the window closes, the debugger detaches, the
  user picks "Use another method" or "Use a passkey saved in MoPilot" in the pane, or the app
  quits. Each one calls `cancel()` on the controller and answers the request exactly once (or drops it
  if the document is gone).
- **Overlap:** macOS shows one sheet per app, so requests are **serialized app-wide**. The slot is
  released only when the controller's delegate reports completion or failure, not at `cancel()`. A new
  request while another is up is refused with `NotAllowedError` (Chromium answers "request already
  pending" the same way), not queued behind a sheet the user is looking at. Its pane notice says a
  passkey window is already open. A second request from the same document replaces nothing.

### 4.3 Failure scenarios

| Class | Scenario | Handling / test |
|---|---|---|
| Async, stale context after `await` | The page navigates while the sheet is up (same-origin too: A/1 → A/2), and the answer arrives for a new document | Navigation cancels the controller. On completion, main delivers only to a live frame of the same origin. The page resolves only by the request id in the old wrapper's closure, which a new document doesn't have, so main's check-then-act gap can't misdeliver. UT: same- and cross-origin navigation between call and resolve. |
| Reversed completion | A late delegate callback from a cancelled controller arrives while the next request's sheet is up | Results are keyed by controller; the slot frees only on the delegate callback. UT: cancel, start a second request, then complete the first. |
| Overlapping runs, second writer | Two tabs ask at once; or the pane's fallback re-runs Electron's path while the sheet is still up | App-wide single flight, so the second request gets `NotAllowedError` at once. The pane actions cancel the controller first, and the request has a single answer latch. UT on both. |
| Malformed input | Page passes wrong types, a 1 MB `user.id`, 10k `allowCredentials`, a nested `appid` for another site | IDL and length checks in main → `TypeError`/`NotSupportedError`/`SecurityError`; nothing malformed reaches the addon. UT table. |
| Timeout | The user walks away from the sheet | The page's `timeout` (default 5 minutes) cancels the controller and answers `NotAllowedError`. UT with a fake clock. |
| Retry | The user cancels, then the site retries at once | The slot is free once the delegate reports; the retry gets a new controller. UT. |
| Shared write | None: no MoPilot state is written. Credentials live in macOS. | n/a |
| External response | Every ASAuthorization error code (unknown 1000, canceled, invalidResponse, notHandled, failed, notInteractive, matchedExcludedCredential (macOS 15+), credentialImport/Export, preferSignInWithApple, deviceNotConfiguredForPasskeyCreation), an unmatched client data, missing fields | One table maps each code to a DOMException name. An unknown code → `NotAllowedError`. On macOS < 15 an excluded credential has no code, so we accept whatever the system answers. A missing field or a mismatched clientDataJSON → `NotAllowedError`, never a half-built credential. UT on each code. |
| External assumption | Entitlement missing (dev, ad-hoc, a profile without the grant) or macOS < 13.5; security keys < 14.4; the user denies or later revokes "Passkeys Access for Web Browsers" | `available()` false → today's path, unchanged. A denied or revoked authorization falls back to today's path, and the pane notice says how to allow it in System Settings. UT on each. |
| Identity | A page calls the binding directly: claims another origin, uses another frame's or an old request id, or replays after the debugger re-attaches | Origin comes from the context that called (`executionContextId` → frame → `WebFrameMain`), never the payload. Request ids are random and single-use, and contexts are forgotten on detach. The binding is not treated as a secret. UT with a forged context, a replayed id and a re-attach. |
| Debugger detach | An agent's turn releases the page debugger, which drops the binding and the context map | Detach cancels the pending request (`NotAllowedError`). While the bridge isn't armed, the wrapper uses today's native path. UT. |
| No window | A parked view tab or a hidden window asks | Anchor to the visible window as `auth.cjs` does today (`viewWindow`); with none, show the pane first or refuse with `NotAllowedError`. UT. |
| Exit for pending states | The renderer crashes, or the app quits during the sheet | `render-process-gone` / `before-quit` cancel the controller. UT. |

### 4.4 Passkeys made in earlier builds

Users may have registered device-bound passkeys through Electron's Touch ID authenticator. The system
sheet cannot see them. The pane notice keeps a "Use a passkey saved in MoPilot" action. It
re-runs the page's original request through Electron's own path (the shim keeps the native function),
so those keep working. New passkeys go to the system (iCloud Keychain or the user's provider). Once the
system path ships and is proven, we can stop `configureWebAuthn({ touchID })` for new registrations.

### 4.5 Agents and every harness

- The browser is shared main-process code, so Codex, Claude Code and ACP chats get the same behavior.
  No harness-specific code is needed.
- A passkey always needs the user (Touch ID, password, phone or key touch). Agents' browser and
  computer-use tools never act on the system sheet (computer use already refuses security prompts). An
  agent that triggers one sees the page waiting, as today, and should hand the tab to the user with
  `request_signin`.

### 4.6 Settings and switches

`shared.browser.systemPasskeys`, on by default when `available()`. Off restores today's behavior
exactly, so it is a kill switch for a broken macOS update.

## 5. Phases

0. **Gating (user, Apple):** request `com.apple.developer.web-browser.public-key-credential` for App ID
   `ai.mopilot.code` (team `7392DG77JZ`). It is a managed capability requested for the App ID in the
   developer account (the exact form name is unconfirmed). Then regenerate the Developer ID
   provisioning profile and confirm the entitlement shows in
   `codesign -d --entitlements - "/Applications/MoPilot.app"`. Forum reports say approval can take
   weeks, or show as issued before profiles carry it. **Risk:** Apple may grant it only to
   general-purpose browsers. Nothing past this step works without it.
1. **Modal get/create:** the addon, bridge and shim. Platform, hybrid and security keys; main frame and
   same-origin frames; RP ID check with PSL; the switch; the pane notice; the legacy fallback.
2. **Autofill and extensions:** conditional mediation through `platformCredentialsForRelyingParty:`
   and our own address-bar-style dropdown, PRF and largeBlob, cross-origin iframes with
   permissions-policy checks, and related origins.
3. **Upstream:** propose option C to Electron (reuse Chromium's `device/fido/mac` iCloud Keychain and
   security-key paths behind `configureWebAuthn`). If it lands, retire the shim and the addon.

## 6. Verification

- UT (100% changed lines, branches and functions): the shim's credential objects (shape, `toJSON`,
  `instanceof PublicKeyCredential`, abort), the bridge (RP ID table with PSL edge cases such as
  `github.io` and `co.uk`, frame gone, navigation, overlap, forged contexts, error mapping, no window,
  switch off), and the addon's JS boundary, mocked.
- Real-app check (needs a profile with the entitlement, a real iCloud account and a security key, so it
  is a release-style manual run by the user, not on CI): sign in to github.com with an iCloud passkey,
  register a new passkey on webauthn.io, use a YubiKey with a PIN, use a phone via QR, cancel each one,
  navigate during the sheet, and use a passkey made by an earlier build.
