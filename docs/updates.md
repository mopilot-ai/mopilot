# App update delivery

Verified dogfood and beta packages can be promoted between channels without
rebuilding. Their embedded versions stay unchanged; the static feed's additive `promotions` list and
the one-time legacy desktop bridge are described in that runbook.

Stable desktop installs read the public manifest at
`https://raw.githubusercontent.com/mopilot-ai/mopilot-code-release/main/updates/stable.json`.
They do not call the GitHub REST API or mopilot.ai to discover stable updates. The manifest contains
published stable builds, their platform and architecture, download URL, notes, date and rollout percentage.
The app selects the newest eligible build using the same deterministic install bucket as the authenticated
feed. Older published builds remain eligible when a newer staged rollout excludes the install; withdrawn
builds disappear. No install ID or account token is sent to GitHub.

Linux builds use the additive `linuxReleases` list. The existing `releases` and `promotions` lists retain
only macOS and Windows builds so older desktop readers can continue discovering their bridge updates.

Every enabled update channel checks 10–15 seconds after startup and then about once a minute (plus up to
five seconds of jitter and the time the previous check took). Checks do not overlap. Failed checks back off, up to about
15 minutes; a successful check resets the interval. GitHub's HTTP/CDN caches can delay a newly published
manifest even when the app checks every minute. Update download, signature verification and restart
approval keep their existing behavior. macOS scheduled checks still require an app in Applications.

Checks continue while a downloaded update waits for its restart. When a release publishes several versions
in a row, a strictly newer version replaces the waiting one before the restart (macOS downloads it and
offers the restart again once it is ready; Windows offers the newer installer), so the app installs only the
newest version instead of upgrading once per version. A same or older version (a stale CDN copy), a failed
check and a restart already approved keep the waiting update; a newer download that fails offers it again,
with why. A Restart when idle waits for the newer update and restarts into it.

An explicit installed-rollback rule is the exception to newer-only selection. It names the exact
withdrawn running or staged version, selected channel, older checked target and operation UUID. The
source stays excluded from normal updates for that cohort while the rule is active or paused. On macOS
the target's SHA-256 and size are checked before handing it to the signed native updater; a withdrawn
stage loses restart authority before replacement starts and stays blocked if replacement fails. Its
native cached copy may still apply on restart, so the client retains the warning and replacement retry.
Windows and Linux retain the explicit package installer flow. See release lifecycle for pause,
restore, compatibility and old-client limits.

Beta and dogfood retain the authenticated MoPilot feed and use the same polling schedule as stable. Dogfood is for
staff; beta is for staff and accounts invited to the `beta` feature in Admin → Alpha. Anyone else is served stable. App
updates are owned by the main process, independently of the selected harness or whether a chat window is open.

With usage data on, the first run of a new version reports `update_installed`, and an update that fails to download,
prepare or install reports `update_failed` with its stage and target version, once per run. The
release train reads these per exact version.

## Publishing and deployment order

1. Give the web server's `GITHUB_RELEASE_TOKEN` Contents read and write, in addition to its existing Actions
   permissions, on the public `mopilot-ai/mopilot-code-release` repository. The desktop's manifest URL is
   fixed to that repository; the server's `GITHUB_RELEASE_REPO` must match it.
2. Apply additive database migrations and deploy the web changes before releasing a desktop build that uses this feed. Bootstrap the manifest
   with `POST /api/admin/releases/feed`, authenticated with the existing release publish bearer token.
   This endpoint also repairs a failed manifest sync without changing release state.
3. Verify that the public manifest exists, then release the desktop build through the existing release
   workflow. This code change alone does not publish or install a desktop build.

The admin portal and release API refresh the GitHub manifest after release registration, publish,
rollout, withdrawal and artifact-host changes. Compare-and-swap publication retries reload the current
catalog, so an older writer cannot overwrite a newer withdrawal. Each publication has a unique revision,
including when the catalog is unchanged, to prevent an older in-flight write from winning after a no-op.
Only public stable update fields are exported; private channels and account data are omitted.

## Discord announcement

Each push of `updates/stable.json` to the release repository runs `.github/release-repo/announce-stable.yml`
(`scripts/announceRelease.mjs`), which compares the feed with every earlier version of the file. When the newest macOS version at
100% rollout (what `/download` serves) is higher than any that was ever at 100%, it posts "MoPilot <version> is out", up to six highlights from that build's notes and
`https://mopilot.ai/download` to the Discord #announcements channel through the "MoPilot Releases" webhook (secret
`DISCORD_RELEASE_WEBHOOK_URL` on the release repository; a fork without it posts nothing). A rollout change below
100%, a pause and resume, a withdrawal or a rollback posts nothing, nor does a build of the old tagged scheme, and a failed post is not retried, so it is lost rather than doubled. The post
never ties into a release: the job continues on error. It does not run for a feed that was never pushed, so a manifest
repaired by hand posts when that edit adds a higher version.

A sync failure is reported as a failure, even though the database mutation may already have been saved.
Repair the feed with the authenticated endpoint above; until then GitHub can retain its previous catalog.
An invalid GitHub response is an update-check error, not an empty catalog. There is no automatic per-client
fallback to mopilot.ai if GitHub is unavailable.

The existing `scripts/github-release.mjs` uploads verified packages and records their GitHub download URLs.
A legacy build without a recorded GitHub mirror retains its original download URL in the static manifest;
mirror those builds with that script to move their downloads off the website too. Existing desktop builds
continue using the MoPilot feed until they install a build with the new updater.

## Homebrew cask

macOS users can install the app with `brew install --cask mopilot-ai/tap/mopilot` from the public tap
`mopilot-ai/homebrew-tap`, which that command taps and trusts. Each push of `updates/stable.json` to the release
repository also runs `.github/release-repo/homebrew-tap.yml`, which writes `Casks/mopilot.rb` with
`scripts/homebrewCask.mjs` from the feed's `main`. The cask names the newest plain version whose macOS arm64 and x64 zips
are both at 100% rollout on the GitHub release, with each zip's registered SHA-256. That is what `/download` serves, except
that `/download` picks each architecture on its own, so while one architecture lags the cask keeps the previous version
for both. A rollout below 100% changes nothing, and a pause, withdrawal or rollback that removes the version from the feed
moves the cask back to the newest one left. The cask's `livecheck` applies the same version rule to the published feed, without checking each zip's host and SHA-256.

A changed cask is installed from a local tap on an Apple silicon and an Intel runner (`brew style`, `brew audit --online`
without the livecheck version comparisons, which read a cached copy of the feed; install; version and architecture; `codesign`;
Gatekeeper must report a notarized Developer ID; then `brew uninstall --zap`). Only when both pass is it pushed to the tap
with the deploy key in secret `HOMEBREW_TAP_DEPLOY_KEY` (deploy keys must be allowed in the organization's settings). A
fork without `SOURCE_REPO` renders nothing, and without the key pushes nothing. Started by hand, the workflow checks the
cask that would be in the tap and pushes it only with `publish`; such a check never replaces a pending publishing run. A
failed run never affects a release: the tap keeps its previous cask until the next feed push. The tap's own workflow runs
the same checks on pull requests and, after each push to its `main`, installs the published cask exactly as users do.

The cask sets `auto_updates`: the app keeps updating itself in /Applications, and `brew upgrade` replaces it only when
the installed app is older than the cask. `brew uninstall --zap` removes its settings and caches but leaves `~/.mopilot`,
which holds agent worktrees, plugins and connectors.
