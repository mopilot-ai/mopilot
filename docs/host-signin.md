# Signing in on a Host

The goal is to sign in once, not once per machine. Vendor terms decide how far that goes, so model access comes in three tiers (#3361, plan v2; design: `design/host/index.html`, "Sign-in tiers"):

| Tier | Who | Per machine | State |
|---|---|---|---|
| 1 | Everyone | One click per machine and agent, or nothing when the app holds an API key | Built |
| 2 | Organizations whose model access runs through their own IdP and LLM gateway | Nothing: sign in once on the Mac | In main (#3423, #3439, #3440) |
| 3 | A Claude.ai or ChatGPT subscription login brokered to many machines | – | Out of scope: Anthropic's terms forbid third parties to "collect, store, or intermediate Claude.ai credentials or session tokens" |

What never changes: nothing is read or copied from the Mac's `~/.codex` or `~/.claude` (`tests/hostVendorFiles.invariant.test.ts`), and a credential the app lends a Host lives in the Host's memory and the harness child's environment only, never on the Host's disk, a command line, a log or `status`.

## Tier 1: the machine's own login

The Host runs each harness's own sign-in (`mopilot-host login <harness>`, `host/src/login.mjs`) with no browser on the Host's own screen (`BROWSER=true`). The app side is `electron/host/signin.cjs`: it starts the sign-in over the Host's control channel, opens the relayed link in the Mac's browser (https only, no credentials in the URL), shows the code in the machine row, polls until the Host reports an end, and then asks the Host itself, not the registry cache, whether the harness is signed in. The vendor's token is written by the vendor's CLI on the Host.

Ends: `signed-in`, `failed` (the Host's words), `cancelled`, `expired` (the code ran out; the row offers a new one), `unreachable` (three failed reads in a row). A new attempt for the same Host and harness joins the one under way; `retire(hostId)` drops every attempt and in-flight read for a Host whose accounts changed. A Host whose Claude Code login sits in a locked keychain says so instead of "Sign in".

The machine row reads **Ready** when an agent the user works with can run there, and names each agent's state ("Claude Code ready · Codex not installed · Gemini needs sign-in"). Every **Sign in** names its agent.

## From a phone

A paired phone runs the machine row's buttons through this Mac (`electron/remote/methods/host.cjs`, `electron/app/hostPhone.cjs` `agents`): `machines.install` / `machines.installCancel`, `machines.signIn` / `machines.signInInput` / `machines.signInCancel`, `machines.update`, and `machines.agentStatus` (`{ install, signIn }`, each the same view the Mac's row follows, or null), all for an account with Host and refused first for a machine that is not listed or is away. They call the same operations as the windows, so the same refusals and words apply. A phone's sign-in is not opened on this Mac: its view carries `url` and `codes`, and the phone opens the page in its own browser (`openHere: false` in `electron/host/signin.cjs`). An install is the pinned recipe with no sudo; nothing here asks for or keeps a password.

## Git on a remote machine

A Git HTTPS operation that reports the Host's missing-sign-in diagnostic, or a signed-out GitHub CLI operation,
shows a recovery card above the chat's composer. The card names the repository provider and machine. For
github.com, **Sign in to GitHub** runs `gh auth login --web` on the remote Host for HTTPS. The device page
opens on the Mac, where **Copy code** copies the one-time code for entry on GitHub. The GitHub CLI stores the
credential on the remote Host. The Host needs GitHub CLI installed.

The Host configures its Git credential helper with `gh auth setup-git`, invalidates old credential readings and
verifies that Git can retrieve its credential before reporting success. The flow is shared by Codex, Claude Code
and admitted ACP chats. Cancellation, expiry, sign-in failure and connection loss remain visible and retryable;
an active sign-in is read from main when a window opens. Older Hosts must be updated for this capability.

After sign-in the card confirms success and the chat draft stays intact. The user can retry the interrupted
operation separately. A failed GitHub HTTPS clone also offers remote sign-in and keeps the clone form available.
The Mac credential option is available for one clone. Other repository providers get guidance and, for
SSH-connected machines, an action to open the remote terminal.

## Tier 1: an API key held by the app

Settings → Connections → Machines → **How machines sign in** → **My API keys** (`HostSigninMethod.tsx`, `HostApiKeys.tsx`): one field per provider, shown only while that choice is picked. The key is kept on this Mac, encrypted with safeStorage in a 0600 file (`electron/host/apiKeys.cjs`), and lent to a machine with each message of a chat whose agent takes it (`host.modelKey`, `electron/host/remoteCredentials.cjs`, `shared/host/credentials.mjs`). The Host keeps it in memory (`host/src/credentialLease.mjs`): Claude Code gets `ANTHROPIC_API_KEY` in its environment; Codex is told the OpenAI key over its app-server protocol (`account/login/start`) by an ephemeral `codex app-server` with no credential store (it ignores `OPENAI_API_KEY` in its env), restarted when idle. Nothing is written on the Host.

**Sign out everywhere**, the small red text button under the sign-in row (`HostSignOut.tsx`, `electron/host/signOut.cjs`), removes the keys here and, on every machine, takes the key back and signs Claude Code and Codex out with their own CLIs (`host.logout`), listing each machine's result.

## Tier 2: organization sign-in

In main (#3423, a startup fix #3439, and #3440: the Claude key helper's TTL scales with the lease).

- **Shape.** Model access goes through the customer's LLM gateway, authorized by the customer's OIDC access token. Workload identity federation and a static org key are typed adapters beside it. MoPilot runs no issuer and no gateway in v1.
- **Admin.** Settings → Connections → Machines → **How machines sign in** → **My organization**: sign-in URL (the IdP issuer) and gateway URL, with the client ID, a separate OpenAI gateway and the session length (the lease lifetime, default 8 h, 1–24 h) under More.
- **User.** Signs in once on the Mac with system-browser PKCE on a 127.0.0.1 loopback. The refresh token is kept in safeStorage; the access token stays in memory.
- **Dispatch.** The app sends `host.orgLease` {harness, identity, token, gateways, expiresAt} (`shared/host/orgAccess.mjs`; `token: null` takes the lease back). The Host keeps it in memory per (Host, harness, org identity = hash(issuer, sub)), with an expiry timer that tolerates ±15 min of clock skew: chats of one identity share a lease, and a second identity on the same Host never reuses it. Claude Code: `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`, refreshed through `apiKeyHelper`. Codex: a custom model provider pointed at the gateway (config override or an ephemeral `CODEX_HOME`), never touching the user's own Codex login. ACP: env pairs, so only agents that read them benefit.
- **Renewal.** At about 80% of the lifetime; a child with no refresh hook restarts between turns, never mid-turn. A failed refresh queues the message as "Organization sign-in needed · Sign in" and the queue resumes after sign-in.
- **Revocation.** Signing out clears only that identity's leases. Sign out everywhere and the admin's **Remove organization access** send null leases and revoke at the IdP. An account disabled at the IdP shows the re-auth state.
- **One process per agent.** Codex and ACP run one process per agent on a Host, so a message from another identity during a turn is refused (`org_identity_busy`) and stays queued.
- **Remove after a restart.** A removal made before an app restart reaches each machine with its next message.
- **Test IdP and real check.** A self-hosted Keycloak fixture: 15/15 on an Ubuntu VM with Keycloak 26, a gateway stub, Claude Code 2.1.316 and codex-cli 0.162.1 (#3361, comment 6570043850); then 9/9 VM checks for a Claude turn spanning a lease renewal and the Codex app-server restarting between turns (#3361). Not yet verified: the UI in a running app, and the WIF and static-key adapters.
- **Real-customer check needs** an IdP tenant (Okta or Entra), a gateway that validates its JWTs, vendor org keys, and a WIF Console admin.

## Codex account relay on a Host

A Host runs no account relay (`electron/identity/accounts/relay.cjs` stays a Mac-side feature): a chat on a Host uses the machine's own login, the lent key or the organization lease, so a subscription at its limit shows the harness's own limit error from the Host.

## Why the v1 rule changed

v1 said "sign in on the Host, never copy tokens": the only credential on a Host was the login the Host itself made. That made every machine need its own login, which the north star ("pick any machine, sign in once") rules out. It was replaced on 2026-11-01 by the tiers above; the ban on reading or copying vendor token files stays.
