# Downgrade test (0.2.0)

Checks that data migrated by this build still opens in the 0.2.0 release (commit `7a5bf12`), the version a
user can reinstall: it starts, chats, archive and pins are there, and chats with acp segments do not show.

Opt-in, because it builds 0.2.0 from git (`npm ci` and `vite build`, network needed the first time). Like the rest of
the e2e it is release-only and needs `MOPILOT_RELEASE=1`.
The source edition includes the end-to-end specs but not their Playwright configuration, which uses internal runner
routing, so this test cannot run from it.

This build opens in the background like the rest of the e2e, but 0.2.0 predates `SAGE_E2E_BACKGROUND`, so its
window comes to the front once.

- `tests/downgrade/build-020.sh [dir]` builds the commit into `$TMPDIR/sage-0.2.0-7a5bf12` (cached; pass
  `SAGE_DOWNGRADE_DIR=<dir>` to the test to reuse a build).
- `tests/e2e/downgrade.spec.ts` seeds a 0.2.0 profile (pinned and archived Codex and Claude chats, a chat
  switched from Codex to Claude), starts this build so the migration runs, adds a Codex chat that moved to Kimi
  (acp) and a chat that began on Kimi, then launches the 0.2.0 build on the same profile with the same fakes.

It asserts in 0.2.0: both pins are under Pinned, the archived Claude chat is not in the sidebar and both
archived chats are in Settings, the switched chat opens with both segments' history, the acp chats and their
pins do not appear, and no page errors. Afterwards the v2 files are byte-for-byte unchanged and still hold the
acp data.

## What it found

0.2.0's `readSegments` reads every `threads/*.json` that has a `segments` array. The v2 files were
`threads/<id>.v2.json`, so 0.2.0 took their bare native ids as its own segments and every chat opened as a
switched chat ("thread not found"). v2 files are now `threads/<id>.v2` (no `.json`), which 0.2.0 ignores.

## Known differences in 0.2.0

- 0.2.0 also lists the Claude session of a switched chat's later segment as a chat of its own.
- A chat with an acp segment is never mirrored to the old files, so 0.2.0 shows a Codex-first one as a plain
  Codex chat without its pin, and a chat that began on an acp harness not at all.
- Changes made after the migration (new pins, new chats) are not visible in 0.2.0 unless this build mirrored them.

## Host `pairing.json` (client records)

From the `clients` feature, `<config>/pairing.json` holds each client as `{ key, name, kind, addedAt, addedBy }` instead of a bare
public key. A Host from before it, started on that file, still authenticates a known key (it only tests that the
fingerprint is present); it cannot read the key for update checks, so it takes no update until the file is written
by this build again. `tests/hostClients.test.ts` ("an older Host") pins the first half; this build reads both forms.
