# MoPilot relay

The relay connects a phone to the Mac it controls (design: `design/mobile-remote`, PR #2612). It forwards **sealed
frames** and keeps them for an offline peer; it can never read one. This folder is the whole service: Node, `ws`,
`jose`, Postgres. No secrets of its own.

## What it sees and keeps

| Sees | Keeps (Postgres) | Never has |
|---|---|---|
| account id and device id (from the JWT), pair ids, frame sizes and timing, push tokens, the clear push request `{pair, kind, ref}` | per pair: sealed frames (`nonce`, `box`, `size`, counter, timestamps) for at most 7 days; drop notices (counts and counters); push tokens; revoked device ids; the ids of accounts whose relay access is switched off, and when; per Host: its id, account, issuing device, pair and the SHA-256 of its credential (no Host frame is ever stored) | message text, keys, chat titles, MoMo memory, harness credentials |

`tests/relayZeroKnowledge.invariant.test.ts` enforces it: the schema may only have the columns it lists, and a recorded
session is searched (rows, three encodings, and the database's raw files) for the plaintext both sides exchanged.

## MoPilot Hosts

The same relay carries the app's traffic to a MoPilot Host on a machine it cannot reach directly (#2709; `relay/src/hosts.mjs`).
The Host dials out with the credential an app issued for it (`Authorization: Bearer mh1.<host id>.<secret>`); the relay keeps only the
secret's SHA-256 in `relay_hosts`, with the account, the issuing device and the one pair it may use. The app talks to its Hosts on
its **host lane** (a desktop or a phone): the account's relay token on `/v1/ws?as=hostlink`, under the relay id `<device id>~h`, so it never replaces the
phone lane's socket. On that lane `host.register` `{host, pair, hash}` adds a Host (at most `HOSTS_PER_ACCOUNT` enrollments for the account; each client's enrollment with a Host is one), `host.revoke`
`{host}` removes one and closes its socket with `4403` (safe to repeat), and `host.list` names the lane's Hosts. A Host that dials with a
credential the relay does not hold (removed, or replaced by a new enrollment) is let in only to be closed with `4403`, which its link
reads as revoked and deletes; a refused upgrade would read to a WebSocket client as a bare network error and be dialed again for good.

Host frames are **live only**: the relay never stores them, and a frame for an end that is not connected is answered `peer_offline`.
Each end hears the other come and go (`{ t:'event', ev:'peer', pair, online }`). The endpoints seal everything (shared/host/relaySession.mjs);
the relay sees pair ids, sizes and timing only. A Host socket counts against the account's Host cap, not `MAX_CONNECTIONS_PER_ACCOUNT`;
the frame, pair, connect and message limits and the slow-consumer drop apply as to any device. A desktop revoked on mopilot.ai, or a
purged account, takes its Hosts' credentials with it.

## Run it yourself

The steps below were followed literally on a clean Ubuntu 24.04 (arm64) machine with Docker 29 and Compose 5 (2026-10-29): build, start,
the checks, `docker stop`, a database outage, a backup and a restore all work as written.

1. Put a TLS proxy in front (Caddy, nginx, a load balancer). Phones connect with `wss://`. Route `/v1/ws` and `/v1/revoke`
   to port 8787; do not route `/metrics`.
2. `cp relay/selfhost.env.example relay/selfhost.env`, set `POSTGRES_PASSWORD` (letters and digits: it goes into a URL). Compose reads this file
   itself, so a `$` in a value starts a variable (`ab$cd` reaches the relay as `ab`): keep to letters and digits, or put the value in single quotes.
3. `docker compose -f relay/docker-compose.selfhost.yml --env-file relay/selfhost.env up -d --build`
4. Check `curl http://127.0.0.1:8787/healthz` → `ok` and `curl http://127.0.0.1:8787/readyz` → `ready`.
5. Configure the clients for your relay and token issuer. See [the self-hosting guide](../docs/mobile-remote/self-hosting.md)
   for what the clients need for pairing.

Set `AUTH_ISSUER` and the issuer's `AUTH_JWKS_URL` or `AUTH_PUBLIC_KEY`. Every variable in `selfhost.env` reaches the relay, so any setting in the
table below goes there. A configuration the relay refuses is printed (`relay: Set only one of AUTH_PUBLIC_KEY and AUTH_JWKS_URL.`)
and the container restarts until it is fixed: `docker compose ... logs relay`.

Without Docker: `cd relay && npm ci && DATABASE_URL=... AUTH_JWKS_URL=... node src/bin.mjs`. The schema is created on start.

### Endpoints

| Path | Answers |
|---|---|
| `GET /healthz` | `200 ok` while the process is up and the database answers `SELECT 1` within `HEALTH_DB_TIMEOUT_MS` (2 s); `503 database unavailable` otherwise. It is the container's health check |
| `GET /readyz` | `200 ready`, or `503 draining` while the relay is shutting down, or `503 database unavailable`: what a load balancer should check before sending traffic |
| `GET /metrics` | Prometheus text, only with `METRICS_TOKEN` set (`Authorization: Bearer <token>`; `404` without a token configured, `401` with a wrong one). Scrape it from the host; the proxy should not route it |
| `POST /v1/account/access` | the account service's signed request (`aud` `relay-access`, claim `st` = `disabled` or `enabled`, `iat` = when the switch was made) that switches one account's relay access off or on (see Account switch below); answers `{sockets}`, the number it closed |
| `GET /v1/ws`, `POST /v1/revoke`, `POST /v1/account/purge` | the product (below); the purge is the account service's signed request (`aud` `relay-purge`, claim `dh` = SHA-256 hex of the sorted device ids joined by newlines, which must match the body's `deviceIds`) when an account is deleted: it revokes the listed devices, removes every pair, mailbox frame and push token of the user, tells the Macs, and answers `{devices, pairs}` (again: zeros). A device with pairs under another account is never touched |

Metrics: `relay_connections{kind}` (`desktop`, `phone`, `host`, `hostlink`), `relay_sockets` and `relay_sockets_limit` (every socket held, the ones still starting too, and `MAX_CONNECTIONS`), `relay_account_sockets_max` and `relay_account_sockets_limit` (the device sockets of the account that holds the most now, and `MAX_CONNECTIONS_PER_ACCOUNT`), `relay_pairs{state}`, `relay_mailbox_frames`, `relay_mailbox_bytes`, `relay_mailbox_frames_limit`, `relay_mailbox_bytes_limit` (the relay-wide mailbox caps), `relay_account_mailbox_bytes_max` and `relay_account_mailbox_bytes_limit` (what the account storing the most holds, and `MAILBOX_ACCOUNT_MAX_BYTES`), `relay_accounts_disabled`, `relay_database_up`,
`relay_draining`, `relay_uptime_seconds`, `relay_event_loop_lag_seconds` (p99 since the last scrape), `process_resident_memory_bytes`,
`process_heap_used_bytes`, `process_external_memory_bytes`, `process_cpu_seconds_total`, and the counters `relay_process_errors_total{event}`, `relay_frames_total{dir,via}`, `relay_errors_total{code}` (`rate_limited`,
`mailbox_full`, `bad_frame`, ...), `relay_closes_total{code}`, `relay_connections_refused_total{reason}` (`busy`: the relay was full; `account_limit`; `account_disabled`; `restarting`; each is 0 from the first scrape),
`relay_mailbox_full_total{scope}` (`pair`, `account`, `relay` for the durable mailbox, `plain` for the plain one, whose statement does not say which cap; each 0 from the first scrape),
`relay_slow_consumers_total`, `relay_push_requests_total{status,kind}`, `relay_push_provider_total{provider,outcome}` (`sent`, `invalid_token`, `rejected`, `failed`, `breaker_open`, `shed`; one per push) and the gauge `relay_push_breaker_open{provider}`. Labels are codes and kinds, never ids or content (a close code
a client chose is counted as `other`; `via` of `relay_frames_total` is `live` for a pairing frame sent straight to a connected peer and `mailbox`
for every stored frame; a repeat of a stored frame is not counted again). Use one scraper: the event-loop figure is reset by each scrape. The
pair and mailbox counts are read from the database at most every 10 s.

### Alerts

The public relay is one process on one machine with fixed caps, so these are the signals that it is full or being abused. Thresholds are for the
defaults (5000 sockets, 16 per account, 500 000 frames / 2 GiB stored); with other limits keep the ratios.

| Alert | Condition | What it means, and what to do |
|---|---|---|
| Sockets filling (warn) | `relay_sockets / relay_sockets_limit > 0.7` for 10 min | 3500 of 5000 sockets held. Capacity has to be planned now: the cap is a deliberate limit of one process, not a number to raise blindly |
| Sockets full (page) | `relay_sockets / relay_sockets_limit > 0.9` for 5 min, or `increase(relay_connections_refused_total{reason="busy"}[5m]) > 0` | People are being told "Mobile Remote is at capacity". Any `busy` refusal is a person turned away |
| One account at its cap (warn) | `relay_account_sockets_max >= relay_account_sockets_limit` for 15 min, or `increase(relay_connections_refused_total{reason="account_limit"}[15m]) > 20` | One account holds 16 device sockets and keeps asking for more: a fleet on one sign-in, or a script. Find it in the `connect` log lines and switch it off in the admin portal if it is abuse |
| Mailbox filling (warn) | `relay_mailbox_frames / relay_mailbox_frames_limit > 0.6` or `relay_mailbox_bytes / relay_mailbox_bytes_limit > 0.6` for 15 min | Stored frames are at 60% of the relay-wide cap. Past 100% every sender gets `mailbox_full` with `scope: "relay"` |
| One account at its mailbox quota (warn) | `relay_account_mailbox_bytes_max / relay_account_mailbox_bytes_limit > 0.8` for 10 min, or `increase(relay_mailbox_full_total{scope="account"}[10m]) > 0` | One account stores close to 128 MiB that nobody acknowledges: a phone gone for days with a busy Mac, or someone filling the mailbox on purpose. Several at once is the attack the quota bounds: switch them off, which deletes what they stored |
| Mailbox full (page) | either ratio `> 0.85` for 5 min, or `increase(relay_mailbox_full_total{scope="relay"}[5m]) > 0`, or `increase(relay_errors_total{code="mailbox_full"}[5m]) > 50` | Every sender is being refused (`scope="relay"`), or many are (a few `mailbox_full` an hour are single pairs at their own cap, which is normal) |
| Flooding (warn) | `increase(relay_errors_total{code="rate_limited"}[5m]) > 500`, or `increase(relay_closes_total{code="1008"}[5m]) > 20` | Clients are past their message or frame limits; the limits hold, this says somebody is leaning on them |
| Switched-off account still dialing (info) | `increase(relay_connections_refused_total{reason="account_disabled"}[1h]) > 100` | A client that ignores the refusal's wait (the shipped apps wait 15 s doubling to 5 min). Its device can be revoked on mopilot.ai |
| Slow or stuck (page) | `relay_event_loop_lag_seconds > 0.25` for 5 min, `relay_database_up == 0` for 2 min, `relay_uptime_seconds` falling, or `relay_process_errors_total` rising | See "When the process ends on its own" |

`/metrics` needs `METRICS_TOKEN` and one scraper (above). Refusal and error counters start again from 0 when the process restarts.

### Logs

One JSON object per line on stdout (`{"event":"connect","device":"...","kind":"phone"}`): `listening`, `connect`, `close` (with the
close code), `revoke`, `account_access` (a switch-off or switch-on, with the number of sockets closed; never the account), `slow_consumer`, `boot_serve` (one Add by command download: the lane's device id, the boot id's first ten characters, script or bundle, bytes sent and how it ended: `sent`, `moved`, `gone`, `offline`, `silent`, `failed`, `closed` or `dropped`; a boot id nobody registered is not logged), `error` (a bounded message), `db_error`, `shutdown`, `stopped`. They hold ids, codes,
counts and error messages; never a frame, a key, a token, a chat title or a push token.
`tests/relayLogContent.invariant.test.ts` fails when a log call names a field outside that list, and `tests/relayLogs.test.ts` plants a
secret in everything a client can send and searches what the relay printed for it.

### Stopping, restarting, upgrading

`docker compose ... stop` (or `docker stop`) sends SIGTERM: the relay answers `/readyz` `503 draining`, finishes the message each
connection is handling (so a frame it was told is stored is stored and acknowledged), closes every socket with `1012`, closes the
database pool and exits 0, in well under a second when idle and within `SHUTDOWN_SECONDS` (8) at most. The phones and Macs
reconnect at once. `docker compose ... up -d --build` after pulling a new version replaces the container the same way; the
database volume is kept and the new version migrates it on start (`CREATE ... IF NOT EXISTS`, safe to repeat, taken under a
database lock so two instances starting together run one after the other). Keep to one relay process: presence and the push
merge state are in its memory.

The Compose project is named after the folder of the compose file (`relay`), so the database volume is `relay_relay-db`; an upgrade from an earlier
version of this file keeps it.

A database that goes away (restart, failover) does not stop the relay: `/readyz` answers 503 and the relay logs `db_error`
until it is back, then serves again without a restart (checked by stopping and starting the `db` container).

**When the process ends on its own.** An error in one request (a bad message, a database error, a handler that throws, a client
that resets its socket at any moment) is answered or logged for that connection only and never reaches the process. What does reach it is
caught by `bin.mjs`: a stray promise rejection, or an error from a dead socket (`ECONNRESET`, `EPIPE`, ...), is logged
(`unhandled_rejection`, `uncaught_exception`) and the relay carries on; any other uncaught exception is logged and the process exits with
code 1, because its state can no longer be trusted. The survivable ones are counted in `relay_process_errors_total{event}` (alert on it rising); a
fatal one ends the process before a scrape can see it, so alert on the container restarting or `relay_uptime_seconds` falling. The
supervisor must start the process again: the shipped Compose file has `restart: unless-stopped`; under systemd use
`Restart=on-failure` with `RestartSec=2`. Phones and Macs reconnect and resend, and nothing the relay accepted is lost across a restart
(the chaos runs of the load harness kill it with SIGKILL twice to show it, and `--reset-rate` resets sockets in every phase of a connection to show
that none of that ends the process).

### Backup and restore

The database holds only sealed frames waiting for an offline device (at most `MAILBOX_TTL_DAYS`), pair and device ids, push
tokens and revoked device ids. Losing it costs undelivered messages and push tokens (phones register their token again on their next
connection); it contains no key and no plaintext. The dump does hold the push tokens, which are the credential of the push path, so
treat the file as a secret (the command below creates it readable by you only).

```sh
C="docker compose -f relay/docker-compose.selfhost.yml --env-file relay/selfhost.env"
(umask 077; $C exec -T db pg_dump -U relay --clean --if-exists relay > relay-backup.sql)   # backup, while it runs
test -s relay-backup.sql                                                           # it is not empty
# restore into an empty database, before the relay starts (it would otherwise create the tables first)
$C down -v && $C up -d --wait db                                                   # --wait: until the db is healthy
$C exec -T db psql -U relay -d relay -v ON_ERROR_STOP=1 -q < relay-backup.sql
$C up -d                                                                           # the relay finds the restored tables and keeps them
```

The relay runs as **one process**. Presence and the push merge state live in memory; run a second instance only when a
shared presence store exists.

## Configuration (environment)

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | required | Postgres URL |
| `AUTH_JWKS_URL` or `AUTH_PUBLIC_KEY` / `AUTH_PUBLIC_KEY_FILE` | one required | Verification key for the ES256 account token. Public half only. `https://mopilot.ai/api/desktop/jwks` for MoPilot accounts |
| `AUTH_ISSUER` / `AUTH_AUDIENCE` / `AUTH_REVOKE_AUDIENCE` / `AUTH_PURGE_AUDIENCE` / `AUTH_ACCESS_AUDIENCE` | `https://code.mopilot.ai` / `relay` / `relay-revoke` / `relay-purge` / `relay-access` | Claims the tokens must carry (same as `web/lib/desktop.ts`). Devices get the `relay` token from `POST /api/desktop/relay-token`; the access token (audience `desktop`) is refused here, so a relay never holds a token the account service accepts |
| `PORT`, `HOST` | `8787`, `0.0.0.0` | Listener |
| `MAILBOX_TTL_DAYS` | `7` | How long a frame waits for an offline peer, then it is dropped and the sender told |
| `DURABLE_MAILBOX` | on | A frame stays stored until its receiver acks it and is redelivered on reconnect; `0` deletes after send as before |
| `MAILBOX_MAX_FRAMES`, `MAILBOX_MAX_BYTES` | `5000`, `64 MiB` | Per-pair mailbox cap; past it a sender gets `mailbox_full` (`scope: "pair"`) |
| `MAILBOX_GLOBAL_MAX_FRAMES`, `MAILBOX_GLOBAL_MAX_BYTES` | `500000`, `2 GiB` | The same across every pair; past it a sender gets `mailbox_full` with `scope: "relay"`. A repeat of a frame already stored is still answered. The count is read from the database every 10 s and adjusted by this process's own stores in between. The plain mailbox has the same bound of its own, checked in the statement that stores |
| `MAILBOX_ACCOUNT_MAX_FRAMES`, `MAILBOX_ACCOUNT_MAX_BYTES` | `10000`, `128 MiB` | The same across the pairs of one account, so one account cannot use up what the relay holds for everyone; past it a sender gets `mailbox_full` with `scope: "account"`. A receipt makes room. Two pairs of one account storing at the same moment can pass it by a frame each |
| `PAIRS_PER_ACCOUNT` | `32` | Pairs one account may have joined at once (its Hosts' pairs count); past it `pair.join` answers `pair_limit`. Removing a pair makes room |
| `MAX_CONNECTIONS`, `MAX_CONNECTIONS_PER_ACCOUNT` | `5000`, `16` | Sockets the relay serves, and the devices of one account that may be connected; past either the socket is closed `4503` / `4429` (a relay that is shutting down still answers the upgrade `503` with `Retry-After`). A device that already has a socket replaces it and never counts |
| `CONN_FRAMES_PER_SECOND`, `CONN_FRAME_BURST` | `100`, `400` | Frames one device may send (the bucket belongs to the device, so a reconnect does not refill it). Past the burst a frame waits for its token (the socket is paused meanwhile): it is slowed, not refused. A Mac resending its 200 buffered frames fits in the burst |
| `RATE_WAIT_MAX_SECONDS` | `5` | The longest a frame or receipt is made to wait for its token; a device further in debt than that is flooding, and its connection is closed `1008` |
| `CONN_RECEIPTS_PER_SECOND`, `CONN_RECEIPT_BURST` | `1000`, `6000` | Receipts (acknowledgements) one device may send; the burst covers a returning receiver acknowledging a full mailbox |
| `CONNECTS_PER_SECOND`, `CONNECT_BURST` | `1`, `10` | How often one device may connect; past it the new socket is closed `1013` |
| `PAIR_FRAMES_PER_SECOND`, `PAIR_FRAME_BURST` | `200`, `800` | The same for one pair, both directions together |
| `CONN_MESSAGES_PER_SECOND`, `CONN_MESSAGE_BURST` | `20`, `60` | Pairing, presence, push and token-refresh messages per device; past the burst a message is refused with `rate_limited` and `retryAfterMs` |
| `TRUST_PROXY` | off | `1` behind a proxy you run: a client's address is the last one the proxy appended to `X-Forwarded-For`, for the Host credential limits and the address Add by command shows before Allow. Leave it off when clients reach the relay directly (they could otherwise name any address) |
| `BOOT_ORIGIN` | none | An https origin (`https://boot.mopilot.ai`) where Add by command's downloads are served. With it set, the relay serves `/v1/boot/*` only for requests whose `Host` is that origin's, serves nothing else there, answers its own host's boot links with an update notice, and names the origin in `host.boot`'s answer so the app's command uses it (finding H-2, docs/host-threat-model.md). Unset, boots are served on whatever host reaches the relay |
| `BOOTS_PER_DAY` | `20` | Add by command boots one account may start in 24 hours; past it `host.boot` answers `boot_quota` |
| `HOSTS_PER_ACCOUNT` | `40` | Host enrollments per account (one per client and Host: a Mac and a phone with the same Host are two); past it `host.register` answers `host_limit` |
| `HOST_AUTH_PER_SECOND`, `HOST_AUTH_BURST` | `1`, `10` | Wrong credentials one remote address may try for one Host id; past the burst those upgrades are answered `429` until the bucket refills (a right credential never costs a token, and another Host behind the same address is not held up) |
| `HOST_AUTH_ADDRESS_PER_SECOND`, `HOST_AUTH_ADDRESS_BURST` | `10`, `100` | The same across every Host id of one remote address, so a caller that makes up a new Host id for each try is held too (wider, as an office behind one NAT holds many Hosts) |
| `AUTH_CLOCK_TOLERANCE_SECONDS` | `5` | How far the relay's clock may differ from the account server's before a fresh access token reads as expired or not yet valid (0 to 59; revocation tokens always get 5). Keep both on NTP; raise this only to bridge a known offset |
| `PAIR_JOIN_SECONDS` | `180` | How long a registered pair waits for its phone (the QR lives two minutes) |
| `PING_SECONDS`, `SWEEP_SECONDS` | `30`, `300` | Socket ping interval (three missed pings = gone), mailbox expiry sweep |
| `DB_POOL_MAX`, `DB_STATEMENT_TIMEOUT_SECONDS` | `10`, `15` | Postgres connections the relay may hold, and how long one statement may run before the database cancels it |
| `HEALTH_DB_TIMEOUT_MS`, `METRICS_TOKEN` | `2000`, empty | How long `/healthz` and `/readyz` wait for the database; the bearer token `/metrics` requires (empty leaves `/metrics` off) |
| `SHUTDOWN_SECONDS` | `8` | On SIGTERM or SIGINT: how long to let each connection finish the message it is handling before closing it. keep it below the compose file's `stop_grace_period` (12 s): the process also ends itself `SHUTDOWN_SECONDS` + 3 s after SIGTERM |
| `PUSH_MODE` | `none` | `none`, `proxy`, `direct` or `dryrun` (below) |
| `PUSH_TIMEOUT_SECONDS` | `10` | How long one request to a push provider may take (a connection that went silent counts too) |
| `PUSH_BREAKER_FAILURES`, `PUSH_BREAKER_COOLDOWN_SECONDS` | `5`, `30` | Failures in a row that put a provider on hold, and how long (doubled, up to 5 minutes, each time its probe fails) |
| `PUSH_MAX_IN_FLIGHT` | `32` | Push requests out at once; 200 more wait, any beyond that fail at once |
| `PUSH_PROXY_URL`, `PUSH_PROXY_TOKEN` | | Endpoint and optional bearer token for proxy mode |
| `APNS_KEY` or `APNS_KEY_FILE`, `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_TOPIC`, `APNS_SANDBOX` | | Direct mode, Apple: the p8 key (PEM, `\n` allowed inline), its key id, your team id, the app's bundle id, `1` for the sandbox host |
| `APNS2_KEY` or `APNS2_KEY_FILE`, `APNS2_KEY_ID`, `APNS2_TEAM_ID`, `APNS2_TOPIC`, `APNS2_SANDBOX` | | An optional second Apple credential set for a second iOS app added next to the one `APNS_*` already serves (another bundle id, possibly another team), same rules as `APNS_*`: the key (inline PEM with `\n`, or a file) brings its three other names, all or nothing, and its topic differs from `APNS_TOPIC`. Some `APNS2_*` names without the key, or a key that is not a p8 private key, stop the relay at start |
| `FCM_SERVICE_ACCOUNT` or `FCM_SERVICE_ACCOUNT_FILE` | | Direct mode, Google: the service account JSON (`client_email`, `private_key`, `project_id`) |

## Load, soak and chaos (`scripts/relay-load.mjs`)

A harness opens N paired Mac and phone sockets (a pair is two sockets, so 500 pairs are 1000 sockets), sends frames at a
chat-like rate (a Mac 0.5 frames/s, a phone 0.05/s, sizes from 400 B to 128 KB) with a burst of 50 Macs x 200 frames 30% of
the way in, cuts random sockets every second, and restarts the relay twice. Every frame carries its pair, direction, counter,
length and send time under a checksum, and a body that depends on them, so the receiver can tell a **lost** frame (accepted by
the relay, gone from its mailbox, never received), an **undelivered** one (still in the mailbox when the drain timeout ended),
a **duplicate** (twice on one connection), a **reorder**, a **corrupt**, truncated or **misrouted** one. A redelivery on a
later connection is expected (the relay is at-least-once) and counted apart. Frames the relay never accepted stay queued at the
sender and are reported as such; they are not lost. The exit status is 1 for any of these, for a run that did not drain, and for
a run that sent nothing.

```sh
# a real Postgres: the relay runs as a child process the harness can SIGKILL and restart.
# The relay's tables in that database are emptied first, so use a scratch database on this machine.
node scripts/relay-load.mjs --database postgres://relay:relay@127.0.0.1:5432/relay --pairs 500 --seconds 60 --json report.json
# no database: the relay runs inside the harness on PGlite (small runs only; PGlite is far slower than Postgres)
node scripts/relay-load.mjs --pairs 20 --seconds 20
node scripts/relay-load.mjs --help
```

`--reset-rate <n>` adds sockets of the harness's own that are torn down with a TCP reset, `n` rounds a second, one reset in each phase of a
connection: a request line half sent, a reset the moment a complete upgrade request has gone out (while the relay checks the token),
before the first message, in the middle of a message, during the close handshake, and right after sending a receipt. The receipt phase is counted only when the phone really received the frame first; every phase is a TCP reset, which `tests/relayLoadResets.test.ts` checks against a stand-in server (the
peer sees `ECONNRESET` or `EPIPE`, never a clean close). On localhost the token check takes microseconds, so "during the token check" is a window the reset usually, not always, lands in. The report counts them and the number of times the relay process ended on its own (a child relay, so with `--database`);
any such ending fails the run, like a lost frame. The extra sockets use their own accounts and pairs (`abuse-*`, `p_abuse*`), at most 12 at a time; their
frames are left out of the mailbox figures, and their closes are in the relay's close counts.

The report has the relay's resident memory and CPU (`ps`; with no `--database` that is the harness process itself), the
mailbox depth, a `/healthz` round trip once a second (a busy event loop or database makes it slow) and the harness's own
event-loop lag, so a slow run can be told from a slow harness. A real Mac keeps only its newest 200 frames while its socket
is down; the harness keeps every one and resends all of them after each reconnect, which is harsher than the product.

**Read the numbers with the machine in mind.** They come from one Mac with 12 cores, Postgres 17 under Rosetta, the relay and the
harness on the same machine, and other jobs running on it (load average 19 to 25 during these runs; the same steady run took
a p50 of 3 to 20 s when the load average was 30 to 40). Compare runs made back to back, not against a different machine.

500 pairs (1000 sockets), 2026-10-29:

| Relay at | Run | Result |
|---|---|---|
| baseline | 30 s steady (about 275 frames/s), no chaos | 8194 frames, 0 lost, 0 duplicated or reordered; latency p50 7 ms, p95 323 ms, p99 534 ms; relay 182 MB mean (199 max), CPU 37% mean; mailbox depth up to 101; `/healthz` 10 ms |
| baseline | 60 s with the burst, 110 cut sockets, 2 SIGKILL restarts | 26 713 frames created, 25 426 accepted, **0 lost, 0 undelivered**, 1287 never accepted (still queued at their senders), the mailbox not empty after a 3 minute drain (15 frames); 1514 sockets closed `1008` and 340 682 resends; steady p50 87 ms, p95 6.2 s, p99 8.8 s |
| PR 2 (backpressure, shutdown, fewer statements) | 30 s steady, no chaos | 8207 frames, 0 lost; latency p50 6 ms, p95 67 ms, p99 108 ms; relay 172 MB mean (185 max), CPU 29% mean; mailbox depth up to 36 |
| PR 2 | 60 s with the burst, 110 cut sockets, 2 SIGKILL restarts | 26 555 frames created and **all** accepted and received, 0 lost, 0 undelivered, nothing left queued at a sender, **no `1008`**, 7928 resends (baseline 340 682), the mailbox empty at the end; steady p50 3 ms, p95 1.3 s, p99 1.7 s |
| PR 3 (limits) | 60 s with the burst, 110 cut sockets, 2 SIGKILL restarts | 26 609 frames created and all accepted and received, 0 lost, 0 undelivered, no `1008`, 6427 resends, mailbox empty at the end; steady p50 2 ms, p95 1.3 s, p99 1.8 s. The limits cost nothing here: the burst of 50 Macs x 200 frames fits in the per-device burst |
| PR 6 (final, 500 pairs) | 30 s steady, no chaos | 8361 frames, 0 lost; latency p50 1.7 ms, p95 3.3 ms, p99 6.3 ms; relay 173 MB mean (190 max), CPU 18% mean; mailbox depth up to 3; `/healthz` 1.3 ms |
| PR 6, 1000 pairs (2000 sockets) | 30 s steady, no chaos | 16 519 frames, 0 lost; p50 1.5 ms, p95 3.2 ms, p99 5.8 ms; relay 227 MB mean (274 max), CPU 32% mean (41 max); mailbox depth up to 5; `/healthz` 1.3 ms |
| PR 6, 1000 pairs | 60 s with the burst, 110 cut sockets, 2 SIGKILL restarts | 43 033 frames created and all accepted and received, 0 lost, 0 undelivered, nothing left queued, closes only `1006` (no `1008`), 5333 resends, mailbox up to 1468 and empty at the end; steady p50 1.6 ms, p95 1.2 s, p99 1.7 s (across the two restarts: p95 7.0 s, p99 8.2 s, max 8.5 s, which is the 1.5 s the relay is down plus 2000 sockets coming back); relay 231 MB mean (321 max); `/healthz` failed 4 times, all while the relay was down |
| PR 6, 500 pairs | the same, plus `--reset-rate 3` | 1014 resets, 169 in each of the six phases (60 more could not be made: the relay was down); 26 781 frames all accepted and received, 0 lost, 0 undelivered, 0 duplicated or reordered, **the relay process ended on its own 0 times**, no `1008`, mailbox empty at the end; steady p50 2 ms, p95 1.5 s, p99 1.8 s |
| PR 6, 500 pairs, soak | 10 min, one socket cut a second (599), the burst at 30%, no restart | 175 294 frames created and all accepted and received, 0 lost, 0 duplicated or reordered, 2 resends; steady p50 1.8 ms, p95 269 ms, p99 2.6 s (the burst); `/healthz` never failed (max 109 ms); relay 318 MB mean, 367 max, CPU 19% mean; mailbox empty at the end |
| PR 6, 300 pairs, database starved | 40 s with the burst, 75 cut sockets, 1 SIGKILL restart, `DB_POOL_MAX=2` (600 sockets share two connections; the relay logs `timeout exceeded when trying to connect` 32 times) | 16 453 frames created, 16 443 accepted and received, **0 lost, 0 undelivered, 0 duplicated or reordered**, 10 still queued at their senders; 13 frames failed to store even after their retries, each answered `unavailable` and followed by a close and a resend in order. Latency p50 62 s (the pool is the bottleneck by design). The run exited 1 only because 1478 receipts were still waiting to be processed when the 5 minute drain ended |

**Memory over time.** A 7 minute run with the burst at 30% (500 pairs, one cut socket a second) sampled `/metrics` every 30 s: the JavaScript heap stayed between
19 and 58 MB and the buffers outside it under 48 MB (the gauge in that run counted array buffers twice, so this is an upper bound), with no trend; the resident size went from 177 MB to 258 MB, stepped
to 360 MB when the burst came, and stayed at 360 to 365 MB for the remaining five minutes. That is memory the allocator keeps after a burst of large
frames, not growth. The report's "first tenth / last tenth" compares a time before the burst (it comes at 30% of the run) with one after it,
so it shows that step, not growth; over a longer run compare samples taken after the burst with each other. Measured: 360 to 367 MB resident at 500 pairs after a burst (10 minutes), and 321 MB at most at 1000 pairs in a 60 s run with one. A longer
run at 1000 pairs was not measured, and Postgres usually shares the host, so give a VM that carries 2000 sockets 2 GB (1 GB is tight); `process_heap_used_bytes` and `process_external_memory_bytes` tell a leak
from a high-water mark in production.

The baseline shows that the relay does not lose an accepted frame, and that a restart plus a burst sets off a reconnect loop: a
socket that sends more than 200 messages at once is cut off (`1008`), reconnects, and sends them again. PR 2 slows such a burst
instead (the relay stops reading the socket until it has caught up) and cuts the statements a frame needs from 21 to 7 (and
the round trips from 27 to 13): one frame (sent, delivered and acknowledged) is 7 statements in 3 transactions, counted by
`tests/relayStatementBudget.test.ts`, which fails when a change adds one. Each later PR records its runs in this table.

## Limits and abuse controls

What one client can ask of the relay, and what happens past it (every value is an environment variable in the table above):

| Limit | Past it |
|---|---|
| a message over 400 KB, a `box` over 256 KB | the socket closes `1009` before the message is parsed (the size is checked by the WebSocket layer as it arrives); a box over 256 KB inside a smaller message is refused `bad_frame` and the socket stays |
| frames per second, per device and per pair | the frame waits for its token (the socket is paused meanwhile, so TCP holds the sender back); nothing is refused, an invalid frame costs a token too. 100/s with a burst of 400 per device, 200/s and 800 per pair. A debt of more than 5 s closes the connection `1008` |
| other messages (pair, presence, push, token refresh) per device | the message is refused: `{t:"error", code:"rate_limited", retryAfterMs}`; 20/s, burst 60. Receipts have their own bucket (1000/s, burst 6000) |
| connects per device | the new socket is closed `1013` (1/s, burst 10) |
| messages waiting on one connection | the socket is paused at 64 and read again at 16; past 2000 messages or 32 MiB it is closed `1008` |
| unjoined pairs per Mac | `pair_limit` (25) |
| frames stored per pair | `mailbox_full`, `scope: "pair"` (5000 frames or 64 MiB); a receipt makes room |
| frames stored for one account, across its pairs | `mailbox_full`, `scope: "account"` (10 000 frames or 128 MiB, two full pairs); other accounts are not affected. Without it one account with 32 pairs of its own could fill the relay-wide cap in about two minutes and stop every user's frames for the seven days they are kept (security review AI-1) |
| pairs joined by one account | `pair_limit` on `pair.join` (32) |
| frames stored across the relay | `mailbox_full`, `scope: "relay"` (500 000 frames or 2 GiB); a repeat of a frame already stored is still answered. The plain mailbox (counter-0 pairing frames, and every frame with `DURABLE_MAILBOX=0`) has the same three caps (pair, account, relay) of its own and answers `mailbox_full` without a scope. With the defaults it takes 16 accounts at their quota to fill the relay: watch the alerts below, and switch such accounts off (Account switch), which deletes what they stored |
| sockets | the socket is taken and closed at once with `4503` (`capacity`) when the relay holds 5000, `4429` (`account_limit`) when one account already has 16 devices connected; it never reaches the hub and is ended 2 s later whatever its client does. A device refused more often than it may connect (`CONNECTS_PER_SECOND`, `CONNECT_BURST`) is answered a plain `429` instead, which costs no handshake. A device that has a socket replaces it and never counts. The apps show "Mobile Remote is at capacity" (or the device-limit wording) and ask again after 15 s, doubling to 5 minutes |
| an account switched off | `4423` (`account_disabled`) for every socket it has and every one it opens; see Account switch |
| a receiver that stops reading | more than 8 MiB unsent, or a send that does not finish in 15 s: closed `1013`, its frames stay stored |
| a client that stops answering | pinged every `PING_SECONDS`; three unanswered (a socket the relay itself has paused is not judged) ends it, and a Mac that vanished raises "machine offline" |
| a relay token | ES256 only, issuer and audience checked, `exp` required, a clock tolerance of `AUTH_CLOCK_TOLERANCE_SECONDS`; a refresh must be the same account, device and kind of device; a socket whose token ran out is closed `4401` a minute after (the clock tolerance is capped below that minute) |

**A frame the relay fails to store is tried again, then ends the connection.** "A counter at or below the stream's high-water mark with no stored frame" is answered
`via: "consumed"` (it was acknowledged and has been delivered or has expired), which is only true if no later frame of the stream was stored ahead of a
frame that failed. A database timeout on frame N, followed by N+1 being stored from the messages queued behind it, would make a resend of N be
acknowledged as consumed, and N would be gone for good (found by the load harness under database starvation; `tests/relayStoreFailure.test.ts`). A connection handles its messages
one at a time, so a frame that throws is tried again in place after 250, 500 and 1000 ms (`frame_retry` is logged; a retry does not pay the rate limits again), with everything behind it waiting: a transient failure costs a delay
and no frame, for every kind of client. Each attempt can itself wait for a pool connection (`connectionTimeoutMillis` 5 s) or a statement (`DB_STATEMENT_TIMEOUT_SECONDS`), so a database that hangs holds the connection for up to a few attempts of that on top of the 1.75 s of pauses. When it still fails the sender gets `{t:"error", code:"unavailable", pair, ctr}`, the connection is closed `4500` (the relay ended it, so the
Mac is not reported as vanished) and the messages queued behind that frame are never handled. A sender that resends what it has no acknowledgement for after a reconnect starts again from that frame.
The shipped Mac does not keep a frame it already wrote to an open socket and the phone seals a new counter on Retry, so for them the frames queued behind the failed one
are lost too, which only happens when the database keeps failing through all the attempts. The plain mailbox (counter-0 pairing frames, and every frame with `DURABLE_MAILBOX=0`) has no unique key, so a retry after a commit whose answer was lost can store a pairing frame twice.
A counter the high-water mark jumped over is recorded as a gap (`remote_durable.gaps`), so a frame for it is stored, not answered `consumed`.
That covers the two windows where a later frame is stored ahead of an earlier one: a `mailbox_full` refusal (the pair's or the relay's; a
documented answer, not a failure, so the connection stays) followed by a smaller N+1 once receipts made room and then a resend of N, and a frame still
in flight on a connection that was replaced by a reconnect reaching the store after a later frame of the new connection (#3215). The late frame is
delivered in counter order if the receiver has not gone past it; a receiver's acknowledgement of a later counter removes the gaps behind it (it can no
longer open a frame there), after which such a counter is answered `consumed` again. Gaps cost no extra statement: they ride on the store and
acknowledgement statements.

**Frames are deleted, not hidden.** The sweep (every `SWEEP_SECONDS`) deletes the frames past `MAILBOX_TTL_DAYS` with a `DELETE`, one pair at a
time, and tells the sender (`mailbox.dropped`) the next time it is connected. A late retransmission of an expired frame is answered
`consumed` and not stored again. `remote_durable.frames` is vacuumed once 2% of its rows are dead (the default is 20%) and analyzed at 5%,
set by the migration. Every query the hot path runs uses an index (`tests/relayMaintenance.test.ts` checks the plans). The only tables
that only grow are `relay_revoked_devices` (one small row per revoked device) and, per pair, one row each in `epochs`, `streams` and `drops`;
all of them go with their pair.

## Wire protocol (JSON text messages over `wss://host/v1/ws`)

The upgrade carries `Authorization: Bearer <account access JWT>`. A phone's token has claim `dk: "phone"`; any other token is a
desktop. The token lives 15 minutes: send `{t:"auth", token}` with a fresh one before it ends, or the relay closes the socket
(`4401`) a minute after expiry. Close codes: `4000` replaced by a newer socket of the same device, `4401` auth, `4403` revoked,
`4503` the relay holds all the sockets it serves, `4429` the account has its most devices connected (both: ask again later, with a wait that grows), `4423` the account's relay access is switched off (ask the account service for a token before dialing again; it refuses one while the switch is off),
`1012` the relay is restarting (reconnect at once), `1013` the relay dropped a receiver that stopped reading (reconnect; its frames are still stored). `4500` the relay could not store a frame (see below; reconnect and resend).

Client → relay: `pair.register {pair}` (Mac), `pair.join {pair}` (phone, same account), `pair.remove {pair}`,
`frame {pair, dir, ctr, nonce, box}` (`dir` is `m2p` from the Mac, `p2m` from the phone; `box` up to 256 KB),
`presence {state: "online"|"sleeping"}` (Mac), `push.register {platform: "apns"|"fcm", token}` / `push.unregister` (phone),
`push {pair, kind, ref, sealed?, card?, sealedBody?}` (Mac; `kind` is `needsYou|done|momoNeedsYou|machineOffline`, or `cleared` from a Host only (a Mac's `cleared` is refused `bad_message`); `card` is the opaque handle of the MoMo card a `momoNeedsYou` is for, forwarded as `card` unless the push is merged; `sealedBody` is MoMo's opt-in body, the user's own routine name sealed for the phone, forwarded unread as `sb` on an unmerged `momoNeedsYou`, never in the alert body), `activity.register {token}` /
`activity.unregister` (phone, the Live Activity's push-to-update token in hex), `activity {pair, state}` (Mac, a snapshot of counts;
answered `push.result`). Any message may carry `rid`, echoed in the reply.

The host lane (`as=hostlink`) and a Host's own socket (`Authorization: Bearer mh1.…`) speak `host.register`, `host.revoke`, `host.list` and sealed frames as described under MoPilot Hosts above; the `host` and `hostlink` kinds appear there and in the metrics.

Relay → client: `hello {pairs}` on connect, `ok`, `error {code}`, `frame` (to the peer), `ack {pair, dir, ctr, via: "live"|"mailbox"}`,
`push.result {status}`, and events `machine.presence`, `pair.joined`, `pair.removed`, `mailbox.dropped`, and to a Mac `peer {pair, online}`
when one of its phones connects or leaves (its hello says `peerEvents: true`).

Delivery from the mailbox is at-least-once and ordered per direction; the endpoints' strict counters (not the relay) reject
replays. `ack via:"live"` means the peer's socket accepted the frame, not that the peer read it: a half-open connection can still
lose it, so endpoints must resync on a counter gap. The relay handles a connection's messages one at a time. When 64 are waiting it stops reading that socket, so TCP slows the sender instead of the relay buffering without limit, and it reads again once 16 are left; a connection that still has more than 2000 messages (or 32 MiB) waiting is closed (`1008`). Stopping the relay (SIGTERM) finishes the message each connection is handling, answers it, then closes every socket with `1012`; nothing a client was told is stored is lost, and a message it had not been told about it resends.

## Revocation

When a device is revoked on mopilot.ai (Account › Trusted devices), `web/` signs a short-lived token with the same ES256 key
(audience `relay-revoke`, claims `sub` and `did`) and `POST`s it to `<relay>/v1/revoke` as a bearer token. The relay closes
that device's socket, deletes its pairs, mailboxes and push token, and remembers its id so a still-valid relay token cannot
reconnect. If the relay is unreachable at that moment the device stays able to connect until its relay token
ends (fifteen minutes at most); the refresh token is already revoked, so it cannot get another.

## Account switch

An admin can switch one account's relay access off on mopilot.ai (the user's page in the admin portal; audited) without touching its sign-in.
The account service then issues that account no relay token (`POST /api/desktop/relay-token` answers `403 relay_disabled`) and `POST`s a
signed request to `<relay>/v1/account/access`. The relay records the account id and the time (`relay_disabled_accounts`), closes every socket
the account has (devices, host lanes and Hosts) with `4423`, deletes the frames it stores for the account's pairs (both mailboxes; the answer
says how many, `{sockets, frames}`), and admits none while the record stands. Pairs and Host credentials are kept for the day it is switched on
again, which a second signed request does; frames that were waiting are gone, and the endpoints resync as after any gap.

Bounds when the relay cannot be told (down, or `RELAY_URL` unset): a device socket lives until its relay token ends, fifteen minutes plus the
minute of grace, because no new token is issued; a Host's credential is not a token, so a Host stays, and the stored frames stay, until the request
arrives (the admin page says the relay was not told and offers "Tell the relay again"). When the *switch-on* does not arrive, the relay lets the account in on
the first relay token issued after the switch-off it holds: the account service would not have issued it otherwise. Deleting the account
removes the record.

## Push

The Mac sends `{pair, kind, ref}` in the clear. The relay turns it into a notification whose **title is fixed per kind**, whose
body is empty and which carries no chat text, merged by the desktop notifier's rule (one per chat; "needs you" outranks
"done" for ten minutes; the same kind for other chats within 60 s becomes `<title> (n)`). `ref` is an opaque handle the phone resolves on device.
A Host may send the same `push` (and `activity`) on its own pair when the pair's lane is a phone's: the target is the phone behind the lane
(`<device>~h`), and a lane with no push token (a Mac's has none) is answered `push.result` with `no_token`, nothing sent. Any other pair is `unknown_pair`.

- `PUSH_MODE=none`: no push. Phones fall back to fetching when opened.
- `PUSH_MODE=proxy` (the **self-host default** when you use the App Store phone app): forwards `{token, platform, kind, count,
  collapseId}` (and the optional sealed title blob, which is ciphertext) to `PUSH_PROXY_URL`, a push.mopilot.ai-style service
  that holds the Apple and Google keys and knows the fixed titles. It never gets a chat handle or an account. `404`/`410`
  from the proxy deletes the token; `429` and `5xx` are retried (below).
- `PUSH_MODE=dryrun`: nothing is sent and no keys are needed. For each push the relay logs `{"event":"push_dry_run","platform":"apns","kind":"needsYou","title":"A chat needs you","bytes":161}`:
  the platform, the kind, its fixed title and the size of the body each sender would post (APNs's JSON, which Apple refuses above 4096 bytes; FCM's `{"message": ...}`). It never logs a token, a chat handle or a sealed title. Use it to see what a push would look like and how big it is before holding keys.
- `PUSH_MODE=direct`: the relay talks to Apple and Google itself with **your** keys, so it fits a phone app you built under your
  own bundle id. Set either or both providers; a token for a platform you gave no keys for is never sent anywhere.
  - APNs: HTTP/2 to `api.push.apple.com` (`api.sandbox.push.apple.com` with `APNS_SANDBOX=1`), provider token (ES256 over the team
    id, signed with the p8 key, re-signed every 30 minutes or when Apple says it expired), push type `alert`, the chat's collapse id.
    `410 Unregistered`, `400 BadDeviceToken` and `400 DeviceTokenNotForTopic` delete the token; a rejected credential (`InvalidProviderToken`,
    `BadTopic`) or payload is final and counts against the provider (below).
  - Two iOS apps (`APNS_*` is the app the relay already serves, `APNS2_*` the app added next to it): a device token only works with its own app's topic, and the phone does not say which app it is. The relay tries
    the set that last sent to the token first (remembered as `topic` on the token's row after a successful send; a different token registered forgets it),
    then the sets in order (`APNS_*`, then `APNS2_*`), so the added app's first push per token costs one rejected request on set 1 (counted `invalid_token` on `provider="apns"`); after that it goes straight to set 2.
    `400 DeviceTokenNotForTopic` and `400 BadDeviceToken` from one set mean "not this app" and move on to the next; the token is deleted only when every set refused it that way,
    and a `410 Unregistered` from any set is final at once. A set that cannot answer at all (APNs refuses its key with `401`/`403`, or its breaker is open) is skipped for that push:
    a revoked key of one app does not stop the other app, and it never deletes a token (if the other set refuses the token too, the push fails and the token stays).
    A transient failure of a set (`5xx`, a timeout) ends the send without trying the other set and without deleting or pinning the token. Live Activity pushes follow the same rule with each set's
    `<topic>.push-type.liveactivity`. Each set has its own breaker; metrics label them `apns` and `apns2`. With one set nothing changes.
  - Giving the relay a second key: put it in the relay's env file as one line, `APNS2_KEY=<the p8 PEM with each line break written as \n>` (no quotes, so `docker run --env-file` and compose read it the same), plus
    `APNS2_KEY_ID`, `APNS2_TEAM_ID` and `APNS2_TOPIC`; keep the file `0600`, owned by root, and never commit, print or paste it. An env file is read when the container is created, so the change takes a `roll`.
  - Preflight before `roll`: load the real env file through the built image with no network. It prints the set list (topic, team, key id, host), never a key, and exits 1 with the reason for a partial or unparsable set:
    ```
    docker run --rm --network none --env-file relay.env -e DATABASE_URL=postgres://unused@localhost/relay <image> node --input-type=module -e "import { loadConfig, apnsSetsOf } from './src/config.mjs'; import { createSender } from './src/pushSenders.mjs'; try { const c = loadConfig(process.env); createSender(c.push); for (const s of apnsSetsOf(c.push)) console.log('APNs set', s.topic, s.teamId, s.keyId, s.sandbox ? 'sandbox' : 'production'); } catch (e) { console.error('preflight failed:', e.message); process.exit(1); }"
    ```
    With a key file instead of an inline key, add `-v <host path>:<path in the container>:ro` and `-e APNS_KEY_FILE=<path in the container>`. A relay that is started with a bad set stops at start and prints the same reason; Docker restarts it, so a bad set is a crash loop, not a relay without push.
  - After the deploy, with one known token of the added app: send one test push to it, then read the counters from the host (`/metrics` is not routed; `<token>` is `METRICS_TOKEN`, not printed here):
    `docker compose exec -T relay wget -qO- --header "Authorization: Bearer <token>" http://127.0.0.1:8787/metrics | grep relay_push_provider_total`
    should show `relay_push_provider_total{outcome="sent",provider="apns2"}` rising by one (and, for that token's first push, `relay_push_provider_total{outcome="invalid_token",provider="apns"}` once). A breaker held open shows `relay_push_breaker_open{provider="apns2"} 1`.
  - FCM: HTTP v1 `messages:send`; the relay mints the OAuth access token from the service account (RS256 JWT exchange) and caches
    it. `404`, `UNREGISTERED`, `SENDER_ID_MISMATCH` and `INVALID_ARGUMENT` on `message.token` delete the token; a `401` refreshes the
    token and retries; a token endpoint that refuses the service account (`invalid_grant`) is a provider failure.
  - Retry (all senders): `429`, `5xx`, a dropped connection or a stalled request is tried up to three times, waiting for the
    provider's `Retry-After` or backing off from 500 ms; anything else is final and reported to the Mac as `failed`.
  - Timeouts: every request to a provider ends after `PUSH_TIMEOUT_SECONDS` (FCM: each of its two steps, the token exchange and the send; APNs: without activity, and a `200` that only ends late still counts as sent). An APNs connection that answered nothing is retired: the requests still on it finish or time out on their own, new ones open another connection.
  - Circuit breaker, per provider (APNs, FCM, the proxy): `PUSH_BREAKER_FAILURES` pushes in a row that failed through their retries with a *fault* (a network error, a timeout, a `5xx`, a credential the provider refuses: `401`, `403`) put it on hold for
    `PUSH_BREAKER_COOLDOWN_SECONDS`, on a monotonic clock. A dead device token, a `429` (it may be one device's rate) and a payload the provider rejects are answers, not faults: they cannot open it,
    so one phone or one bad message cannot stop push for everyone. While it is held requests to it fail at once without reaching it; then one request is let through as a probe, and
    its success closes the breaker, its failure doubles the hold (up to 5 minutes). `push_breaker_open` is logged when it opens and `relay_push_breaker_open{provider}` is 1 while it is held.
  - A stalled provider cannot pile requests up: `PUSH_MAX_IN_FLIGHT` are out at once, 200 more wait, the rest fail at once (`outcome="shed"` in the metrics), and one phone has at most 4 requests out or waiting.
  - A Mac's `push` request is answered when the provider has answered (`push.result`), but it no longer holds up the Mac's other messages while it waits; a request that breaks is answered `push_failed`.
    One chat's pushes go out in the order they were asked for (a retried "finished" cannot overtake the "needs you" that followed it), and a push that did not go out is not remembered as shown (it would hold back a later one and count in a merged "(n)").
- **Payload.** Always an alert with the kind's fixed title (`A chat needs you`, `A chat finished`, `MoMo needs you`, `Your Mac went
  offline`, `<title> (n)` when merged) and an **empty body**. A Host's `cleared` (its waiting card is gone: answered elsewhere, stopped or its turn ended) is titled `A chat no longer needs you`, which claims nothing about the chat, and is quiet: `interruption-level: passive`, no sound, no category (no Allow/Deny), never merged into `(n)` or held back by the card it replaces, and it shares that card's collapse id so it replaces the waiting notification (Android's app removes the waiting one and draws nothing). A relay that predates `cleared` refuses it `bad_message`; the Host does not retry or send another kind, so the waiting notification stays until the phone's app is opened. The only extra fields are `kind`, the opaque `ref` the phone
  resolves locally, and, when the Mac sent one for a single chat, a sealed title blob (`st`, with `mutable-content` on iOS) the
  phone's notification extension decrypts on device. The relay cannot read it and drops it from a merged `(n)` notification, and from MoMo and offline pushes. **Every FCM message is data-only** and high priority (`data`: `kind`, `ref`, `title`, `count`, optional `st`; never a `notification` block): the Android app posts the notification itself, so a sealed title can be opened and the phone's lock-screen option applies, with `data.title` (fixed, `(n)` when merged) as the fallback. Risk: some phone makers' battery optimization delays or drops data-only messages for apps it has put to sleep, so a push can arrive late there; the phone falls back to fetching when opened. iOS stays an alerting push.
- **Token registration.** A phone sends `push.register {platform, token}` (replaces its previous token; one per device id) and
  `push.unregister`; the token is deleted when the device is revoked or the provider calls it dead. Tokens are never sent to a Mac.
- **Live Activity (iOS).** A phone with the Live Activity switched on registers the running activity's token (`activity.register`; one per
  device, replaced with each new activity, removed by `activity.unregister`, revocation, account deletion, or Apple answering 410 for
  that very token; the alert token is a separate row). A Mac sends `activity {pair, state: {needs, running, kind: "needs"|"running"|"done", since, at, rows}}`
  (counts up to 99, unix seconds, up to three rows of `{kind, since, ref, st?}` where `ref` is the opaque chat handle and `st` a title sealed
  for the phone; both base64url). Only those fields are read; any other field is dropped, a malformed one is refused (`bad_message`).
  The relay keeps the latest snapshot per pair in memory (30 minutes), merges a phone's pairs (counts added, the newest event's kind, the earliest
  start, the three most urgent rows) and sends one ActivityKit push (`apns-push-type: liveactivity`, topic `<bundle>.push-type.liveactivity`, a
  `stale-date` 20 minutes out): one at a time per phone, the newest state wins, high priority only when "needs you" rose. Nothing running or
  waiting ends the activity (a "finished" frame lingers 4 minutes); so does removing the last pair or a Mac's snapshot expiring. Proxy mode and FCM
  send no activity updates.
- **No push** is a supported shape: `PUSH_MODE=none`. The Mac's request is answered `disabled`, the phone fetches when opened, and the
  phone app says so in Settings.

What this repository could not test: there are no real Apple or Google keys here, so APNs and FCM are exercised only against a
local HTTP/2 server and a fake `fetch` that answer with the documented status codes, headers and bodies (`tests/support/pushProviderShapes.ts`:
BadDeviceToken, DeviceTokenNotForTopic, Unregistered, ExpiredProviderToken, TooManyRequests with Retry-After, 5xx; UNREGISTERED, SENDER_ID_MISMATCH, an invalid registration token,
RESOURCE_EXHAUSTED and UNAVAILABLE with Retry-After, an invalid grant). First use with real keys should be a sandbox
device and a look at the relay log for `failed` statuses.
