# IAB / CU / BU benchmark harness

This harness measures MoPilot's in-app browser (IAB), computer use (CU) and browser use (BU) against the same
tasks run in other agent apps. It runs three public benchmarks:

| Key | Benchmark | What it exercises | Graded by |
|---|---|---|---|
| `wg` | [WebGames](https://github.com/convergence-ai/webgames) | Browser interaction puzzles (holds, drags, key combos, iframes) | The password in the answer **and** the page's own completion record |
| `real` | [REAL / agisdk](https://github.com/agi-inc/agisdk) v2 | Multi-step tasks on clones of real websites (mail, calendar, shopping) | The upstream Python grader, run on the site's `/finish` state |
| `mac` | [MacArena](https://github.com/MacPaw/MacArena) | macOS apps through computer use (Notes, Reminders, Calendar, Finder) | The task's own shell graders, weighted, run in the GUI session |

Every arm gets the same prompt per task. The only difference is the browser it is told to use.

## Release-only: VM only

A run launches and drives real apps: MoPilot windows, Claude Desktop, ChatGPT and the macOS apps. It types into them
and pastes through the clipboard. So, under [AGENTS.md](../AGENTS.md), it runs only inside the isolated benchmark VM
and never on a real Mac.

- `bench/run.mjs`, `bench/edge-run.mjs`, `bench/contract-run.mjs`, `bench/mgb-run.mjs`, `bench/mgb-limit-proxy.mjs`,
  `bench/motion-record.mjs`, `bench/mac-validate.mjs` and `bench/setup-external.mjs` (which runs the benchmarks' own install and build scripts) refuse to start unless `kern.hv_vmm_present` is 1. They use the same
  check as the other release-only suites (`insideVirtualMachine` in `scripts/release-suites.cjs`, on the one decision in
  `electron/platform/virtualMachine.cjs`), and `MOPILOT_RELEASE=1` does not bypass it.
- **Computer use counts as attended only with `MOPILOT_BENCH_ATTENDED=1`, and only inside the VM.** Computer use refuses
  requests as `unattended` after 10 minutes without a person's input, and the helper never counts a driver's posted
  input (cliclick, osascript, Screen Sharing) as a person's, so a benchmark VM goes unattended. Start each MoPilot
  instance of a computer-use run with `MOPILOT_BENCH_ATTENDED=1`: it treats the idle time as 0 (#1600). The same VM check
  (`benchAttended` in `electron/platform/virtualMachine.cjs`) makes it do nothing on a real Mac, when unset, or when set to
  anything but `1`. Every other gate stays: the other unattended reasons (a scheduled task, a sub-agent, a call outside a
  prompt, a turn MoPilot started), the no-go lists, the desktop lock, the overlay, Esc and the read-only checks.
- **Claude in Chrome stays off in the VM unless a run pairs one inside it.** Its pairing is account-wide: a Claude
  session in the VM reached a Chrome on another device and opened the run's pages there (#1561). Every MoPilot instance a
  bench or contract run starts gets `MOPILOT_FLAGS` through `benchFlags` (`lib/claudeChrome.mjs`), which adds
  `native.claude.chrome=0` (Claude Code starts with `--no-chrome`), so a Claude chat reaches Chrome only through MoPilot's own channel on the run's profile. A vendor arm's turn that reaches Claude in Chrome is stopped even where the
  task allows the vendor's Chrome (`vendorChromeAllowed`). A run that has paired Claude in Chrome with a Chrome inside
  the VM, and made sure no other browser is paired with the account, says so with `MOPILOT_BENCH_CLAUDE_CHROME=vm-local`.
  Without it, the vendor Claude in Chrome channel is scored as not measured in the VM.
- `bench/vm-grant.sh` refuses to run outside a VM.
- The Claude Code hook in `.claude/settings.json` blocks agents from starting any of them on the host. Start them in
  the VM with `scripts/vm-exec.sh`.
- `bench/report.mjs`, `bench/motion-metrics.mjs` and `bench/motion-report.mjs` only read result files, so they run anywhere.

## Layout

| Path | What it is |
|---|---|
| `run.mjs` | Entry point: one arm, one benchmark, one tier (VM only) |
| `mac-validate.mjs` | Checks that MacArena graders score 0 after a reset and 100 after a known solution (VM only) |
| `webgames-serve.mjs` | Serves the built WebGames offline and logs page-reported completions |
| `edge-run.mjs` | The edge-case scenario suite: every scenario on each cell (VM only) |
| `edge-serve.mjs` | Serves the edge-case fixture pages and logs the events they report |
| `scratch-chrome.mjs` | The Chrome a bench instance starts: refuses the default profile; with `MOPILOT_SCRATCH_CHROME_EXTENSION`, loads MoPilot's extension and checks it runs (and with `MOPILOT_SCRATCH_CHROME_PAIR=1`, presses Pair) |
| `bench-chrome.mjs` | Starts the bench's Chrome on a profile with the extension loaded and paired, and waits until the profile shows it on (VM only) |
| `contract-run.mjs` | The harness version contract: one harness version installed in its own prefix, every suite against it (VM only) |
| `report.mjs` | Summary table of a run, or a before/after comparison of two runs |
| `motion-record.mjs` | Records one motion moment in one app's window (VM only) |
| `motion-metrics.mjs` | Frame metrics of motion recordings, and a self-check on a synthetic recording |
| `motion-report.mjs` | Vendor / MoPilot / delta table and the move-by-move alignment of two arms' cursor recordings, plus the overlay page (reads files only) |
| `motion/` | Swift tools for the motion bench: `decode.swift` (recording → timed luma frames), `synth.swift` (a synthetic recording, with a moving-cursor mode), `sckrecord.swift` (ScreenCaptureKit recorder at a high frame rate) |
| `setup-external.mjs` | Fetches the three benchmarks at their pinned commits and builds WebGames (VM only) |
| `vm-grant.sh` | Writes the macOS privacy (TCC) grants in the VM (VM only, run by a person) |
| `vm.sh` | Host-side helper for screenshots of and clicks on the VM's screen, without VNC |
| `lib/` | Pure logic with unit tests (`tests/bench.test.ts`): arguments, tiers, prompts, grading, transcripts, reports |
| `drivers/` | VM-only glue: raw CDP, the MoPilot turn, the desktop-app turn, the GUI session, MacArena scripts, the cursor moments' fixture server and recorder (`motionKit.mjs`) |
| `external/` | Benchmark checkouts (git-ignored, never committed) |
| `results/<run>/<arm>/` | One `<task>.json` per task, plus REAL `<task>.finish.json` and a `<task>.png` screenshot (git-ignored) |

The `lib/` modules are held to 100% unit coverage (`.c8rc.json`). `drivers/` and the entry scripts need the VM and
real apps, so they stay thin and are checked by running the harness in the VM.

## Third-party benchmarks (not in this repository)

This repository contains no benchmark code, task data, results or screenshots. `node bench/setup-external.mjs`, run
in the VM, clones
each benchmark into `bench/external/` at the commit the baseline was measured on, then builds WebGames
(`pnpm install --frozen-lockfile && pnpm run build`, through `npx pnpm@9`):

| Benchmark | Repository | Pinned commit |
|---|---|---|
| WebGames | https://github.com/convergence-ai/webgames | `309866f64642b864414ca2c7ff956e59e01d3317` |
| agisdk (REAL v2) | https://github.com/agi-inc/agisdk | `97a245dcbccd3e1cf4d5ee00d5b1707942258518` |
| MacArena | https://github.com/MacPaw/MacArena | `dcdc7d366da12641578ab90f085d69db91651c58` |

The pins are in `lib/external.mjs`. If you change a pin, rerun the baseline: results from different pins do not
compare. The REAL sites are Vercel deployments named in each task file. If one disappears, its tasks fail for every arm.

## VM setup

Do this once per base image. The steps marked **person** need a human at the VM's screen. macOS rejects injected
clicks on these dialogs, and agents must not approve permissions or sign in.

1. **Create the VM with [tart](https://tart.run)** (Apple Silicon host): `brew install cirruslabs/cli/tart`, then
   clone a macOS 26 image, for example
   `tart clone ghcr.io/cirruslabs/macos-tahoe-base:latest mopilot-bench-base`. Record the image digest with the
   results. Give it a 1440x900 display: the desktop-arm coordinates in `lib/config.mjs` assume it
   (`tart set mopilot-bench-base --display 1440x900`).
2. **Turn off SIP** (`vm-grant.sh` writes the system TCC database): `tart run --recovery mopilot-bench-base`, then
   run `csrutil disable` in Recovery's Terminal and restart. Only ever do this in the VM.
3. **Tools in the VM:** Homebrew, `node@24`, `python3`, `cliclick`, Command Line Tools, and `tart-guest-agent`, which
   the Cirrus images include and which `tart exec` and `scripts/vm-exec.sh` need.
4. **MoPilot** at `~/mopilot`: run `npm ci`, `npm run build` and `node scripts/build-helper.mjs` (the computer-use
   helper). Then `node bench/setup-external.mjs` in that checkout.
5. **Agent apps:** the Claude Code CLI, the Codex CLI, Claude Desktop (`/Applications/Claude.app`) and ChatGPT
   desktop (`/Applications/ChatGPT.app`).
6. **Sign-ins (person):** sign in to the Claude Code CLI, the Codex CLI, Claude Desktop and ChatGPT with the accounts
   used for benchmarking. Do not add an internet account to Notes, Reminders, Calendar or Contacts. A Google account
   as Notes' default broke a MacArena checklist task (Google notes have no checklists).
7. **Permissions (person):**
   - Run `zsh ~/mopilot/bench/vm-grant.sh` in the VM's Terminal, then restart the VM. It grants Accessibility,
     Screen Recording, input events, Full Disk Access, the personal-data folders and Apple Events to the driver tools
     (tart-guest-agent, cliclick, osascript, the shells, screencapture, node, python3), to MoPilot's computer-use
     helper, to Claude Desktop, to ChatGPT, and to Codex Computer Use.
   - Then turn on **ChatGPT Computer Use** in System Settings. Its service (`com.openai.sky.CUAService`) ignores the
     rows written directly and keeps showing "Enable ChatGPT Computer Use" until a person turns it on there.
   - In Claude Desktop, turn on computer use.
   - In each MoPilot instance, choose Full access and check that Settings → Computer use shows Accessibility, Screen
     Recording and Input Monitoring as Allowed.
8. **Snapshot:** shut the VM down and save the prepared image as `mopilot-bench-cu`
   (`tart clone mopilot-bench-base mopilot-bench-cu`). Never run benchmarks on it directly. For each run, start from a
   fresh clone named `mopilot-bench` (the default `MOPILOT_VM`):
   `tart delete mopilot-bench; tart clone mopilot-bench-cu mopilot-bench; tart run --no-graphics mopilot-bench &`.

Before every arm, clear any system prompt left on screen (`bench/vm.sh shot` shows the screen) or restore the
snapshot. In the baseline, a ChatGPT screen-sharing prompt left over from one arm covered Reminders and failed
another arm's task.

Several sessions share the VM. The shared lock is `~/.mopilot-vm.lock` **on the host** (the Mac that runs Tart, not
inside the VM): take it with `mkdir`, with an `owner` file naming the run, before each run, and remove it right after.
Never start instances or drive the VM's screen while another session holds it. Then `zsh bench/vm-preflight.sh mgb` The base VM image must be marked once with `zsh bench/vm-mark-test.sh`, so the installed app reports `origin: "test"` and analytics leave it out (`install-origin` in the app data folder; the preflight checks it).
(or `edge`) in the VM lists every login, app, Chrome profile and native host, and port the run needs, read-only, so a
person is asked once for everything that is missing.

The desktop arms open a new chat with Cmd+N, which focuses the composer in both apps, so no screen coordinates are
needed. Claude Desktop keeps the model per session, so the driver picks it each time (⇧⌘I, then the model's number,
`modelKeys` in `lib/config.mjs`). ChatGPT carries the model chosen in its composer over to new chats: set it once
(GPT-6 Luna for the 12-Grid Bench's Codex column).

## Starting the apps for a run

Run each MoPilot arm in its own instance, with its own user data and CDP port (`lib/config.mjs` holds the default ports):

    cd ~/mopilot && MOPILOT_BENCH_ATTENDED=1 MOPILOT_FLAGS=native.claude.chrome=0 MOPILOT_USER_DATA=~/bench-data/mp-claude npx electron . --remote-debugging-port=9361
    cd ~/mopilot && MOPILOT_BENCH_ATTENDED=1 MOPILOT_FLAGS=native.claude.chrome=0 MOPILOT_USER_DATA=~/bench-data/mp-codex  npx electron . --remote-debugging-port=9362

`MOPILOT_BENCH_ATTENDED=1` keeps computer use from refusing the run as unattended, and `native.claude.chrome=0` keeps
Claude in Chrome off (see the VM-only section above).

An arm with no model (`mp-codex` by default) skips the picker and uses the instance's current harness and model.
Before the first run, start a chat on Codex in that instance once.

For REAL on the ChatGPT arm, start ChatGPT with CDP so `/finish` can be read from its agent tab:
`open -a ChatGPT --args --remote-debugging-port=9398`. Claude Desktop quits when it is started with that flag.

For WebGames, start the offline server:

    node ~/mopilot/bench/webgames-serve.mjs ~/mopilot/bench/external/webgames/webgames/dist 8800

## Running

From the host, hand each command to the VM:

    scripts/vm-exec.sh zsh -lc "cd ~/mopilot && node bench/run.mjs --bench wg --arm mp-claude --tier smoke --run pr-123"

| Option | Default | Meaning |
|---|---|---|
| `--bench` | (required) | `wg`, `real` or `mac` |
| `--arm` | (required) | `mp-claude`, `mp-codex`, `desk-claude` or `desk-chatgpt` |
| `--tier` | `smoke` | `smoke` or `full` |
| `--tasks` | tier list | Comma-separated task ids (MacArena: the first 8 characters) |
| `--run` | `local` | Run name, the folder under `results/` |
| `--port`, `--harness`, `--model` | per arm | Override a MoPilot arm's CDP port, harness and model label (as shown in the picker); `--model ""` keeps the instance's current choice |
| `--timeout` | `300` | Seconds per task; on timeout the driver stops the turn |
| `--base` | `http://127.0.0.1:8800` | WebGames server |
| `--extra` | none | Text appended to every prompt (record it with the results) |

Before running MacArena, check the graders: `node bench/mac-validate.mjs` (SMOKE tasks by default). Each task must
print `ok: true`.

To copy results to the host:
`tart exec mopilot-bench tar -C mopilot/bench/results -c pr-123 | tar -x -C bench/results`.

## Tiers

**SMOKE** (`SMOKE` in `lib/tasks.mjs`) runs every arm in about two hours.

- WebGames (12): key-combo, menu-navigator, button-hold, stock-market, text-mirror, chart-read-easy,
  wolf-goat-cabbage, recipe-calculator, iframe-nest-easy, calendar-comprehension, click-pixel, datehard.
- REAL (10): gomail-16, gomail-24, gocalendar-12, gocalendar-23, udriver-14, networkin-27, topwork-14, omnizon-17,
  dashdish-7, opendining-12.
- MacArena (5): a13331ed (copy Recipe.txt), 4f0d1950 (Notes checklist), 7bcb0652 (move a reminder), e7480f08 (new
  contact), 24f5dc8b (calendar event with an alert).

**FULL** runs the whole catalog at the pinned commits: all 149 WebGames tasks (base, easy and hard variants), all 121
REAL v2 tasks (every one is an action task), and all 49 MacArena tasks. Only MacArena 7b655b3b copies a file in first;
the driver does that from the checkout. FULL takes many hours per arm. Run it for releases or for changes that touch
how the agent sees or acts, not for every pull request.

## Arms

| Arm | Product | Browser for web tasks | Driven by |
|---|---|---|---|
| `mp-claude` | MoPilot × Claude Code (Sonnet 5.5 in the baseline) | MoPilot in-app browser | CDP to the app window: new chat, picker, prompt, wait |
| `mp-codex` | MoPilot × Codex (the instance's default model and effort) | MoPilot in-app browser, through Codex's Browser plugin | Same |
| `desk-claude` | Claude Desktop, Code tab, Local | Claude's built-in browser pane | GUI: Cmd+N, paste, Return; Claude Code transcript on disk |
| `desk-chatgpt` | ChatGPT desktop (Codex), This computer | ChatGPT's built-in browser | GUI: New chat click, paste, Return; Codex rollout on disk |

Record each arm's app version, model, effort and permission mode with the results. In the baseline the Claude arms
both used Sonnet 5.5 High, the Codex arms kept their defaults, Claude Desktop stayed in Auto permission mode, and the
other three used Full access. desk-claude is recorded as unsupported on REAL: its browser storage cannot be read
for grading.

## Fairness rules

- **GUI only.** Every prompt forbids shell commands, scripts, AppleScript/osascript, reading the page source and
  editing files directly. Results record `shellUsed` (Bash, shell or exec tools; MoPilot's "Ran a command" summaries) and
  `scriptUsed` (page JavaScript through a browser tool, such as `browser_script`). Codex's `js` tool is its
  computer-use API, not page script. A pass that broke a rule should be called out, not counted silently.
- **Same prompt, same timeout, same tier and pins** for every arm, and one attempt per task unless a retry is recorded
  as one (keep first attempts in a separate folder, such as `mp-codex-wg-attempt1/`).
- **No browser outside the app.** A desktop turn that calls Claude in Chrome is stopped at once and recorded as a
  failure. That extension reaches the account's real Chrome outside the VM.
- **Operator approvals.** MoPilot asks for confirmation on irreversible actions even in Full access. The driver
  approves those cards with a trusted CDP click, as the operator would, and counts them in `approvals`. The desktop
  apps did not ask in the baseline.
- **Wall time** runs from send to the end of the turn as the driver sees it. The MoPilot driver adds about 2–3 s
  (three idle polls). The desktop driver adds about 3–5 s (3 s transcript polls). On REAL, the desktop arms also
  open the two setup pages themselves.
- **Steps do not compare across arms.** MoPilot counts its own step totals; the desktop arms count tool calls.
- **Keys as a person presses them.** A driver sends a key (Enter to send, Esc mid-turn) with CDP
  `Input.dispatchKeyEvent` to whatever has the focus, and never calls `focus()` on the target first: a script focus
  hid a composer that dropped the focus on every send, so Esc reached nothing (#1658). The edge driver records where
  each key went (`keys`, from `KEY_TARGET` in `lib/edge.mjs`), and an Esc that reached `<body>` fails the 12-Grid
  Bench's Esc check even when the turn then ended by itself.

## Grading

- **WebGames:** a pass needs the password in the final answer and a completion that the page posted to
  `/api/record-completion` after the task started (`webgames-serve.mjs` logs it to
  `results/webgames-completions.jsonl`). Guessing the password, or reading it from the bundle, does not pass.
- **REAL:** after the turn, the driver loads `<site>/finish` in the agent's own tab: for MoPilot, the tab the agent
  opened, else the setup tab; for ChatGPT, a page or webview on the site over its CDP port. It saves the JSON as
  `<task>.finish.json` and runs the upstream grader (`python3 -I eval_<site>_<n>.py <finish.json>`) from a temporary
  folder. `SUCCESS` passes. A missing or invalid `/finish` is **ungradable**, not a fail. The notes say which tab
  was read. A tab that was already open before the turn may hold an earlier task's state, so check those by hand.
- **Driver errors:** a task the driver could not set up, or whose prompt never reached the agent (no app window,
  the harness or model missing from the picker, the turn never started), is recorded as ungradable with the error.
  The run then continues with the next task. A turn that ends because the app failed after the prompt was sent, such
  as a crash, is graded normally. A timeout means only that the agent was still working when time ran out.
- **MacArena:** the driver applies the task's reset (plus our extra resets in `lib/macarena.mjs`) and waits the task's
  delays. After the turn it runs each grader in the GUI session; the score is the sum of the weights whose last
  output line says true. A pass is 100.
- `report.mjs` counts the pass rate over gradable, supported tasks, and lists unsupported, ungradable, timeouts,
  shell use and page-script use separately.

## Known benchmark data problems

- **WebGames wolf-goat-cabbage:** the page shows the password when solved but never posts its completion, so every
  arm fails it. Read it as a lenient pass when the password is in the answer.
- **WebGames datehard:** the catalog says "yesterday's date", but the page asks for the date 32 days ago in UTC.
  Agents that follow the prompt instead of the page fail.
- **REAL topwork-14:** every arm saves both freelancers (`saved/saveFreelancer` is in the action history), but
  `finalstate.saved` is empty after the `/finish` reload, so the grader fails. It is ungradable in practice.
- **MacArena 4f0d1950:** the grader finds any note named "Meeting Notes", and its reset deletes only one, so an
  older note scores a false pass. The extra reset renames old copies to "Meeting Notes (stale)".
- **MacArena graders depend on the VM's state:** Notes' default account, leftover system prompts and earlier arms'
  data can change results. Run `mac-validate.mjs` and restore the snapshot between arms.

## Comparing before and after a pull request

1. Use one VM snapshot, one tier and the same arms, models and effort for both sides. Run the base (main at the PR's
   merge base) and the PR head, one after the other, in the same session. Rebuild MoPilot in the VM for each side
   (`git checkout <sha> && npm ci && npm run build`).
2. Name the runs after the commits, such as `--run main-<sha>` and `--run pr-123-<sha>`, and run each affected arm on
   each affected benchmark. The SMOKE tier is the default for pull requests.
3. Compare: `node bench/report.mjs bench/results/pr-123-<sha> --before bench/results/main-<sha>`. This prints the
   pass counts, the pass-rate change and the median wall-time change per arm and benchmark, then every task whose
   outcome changed.
4. SMOKE samples are small, so a single flipped task is noise until it repeats. Re-run flipped tasks with `--tasks`
   on both sides before you claim a change. Put the comparison table and the run settings (snapshot, pins, app
   versions, models) in the PR description, not in `docs/`.

## Edge-case scenarios

`edge-run.mjs` walks the real-app edge cases in docs/control-plane/edge-cases.md.
These include a passkey that never resolves, an OAuth popup, dialogs, uploads and downloads, cross-origin frames,
basic auth, a self-signed certificate, deep links, a PDF, permission prompts, a checkout iframe, 2FA, an expired
session, a hung or crashed renderer, and more. Each runs on the cells `claude`, `codex`, `switch` (Claude Code for the
first message, then a switch to Codex) and the ACP column, `opencode`, `gemini` and `dsh` (basic-tier harnesses on
MoPilot's own tools; each needs its CLI installed and signed in in the VM, else pass `--cells` without it). The
fixtures are local pages, so no real account or site is involved.

- `opencode` runs on OpenCode Zen's free Big Pickle (the composer shows it as `Big Pickle`) (`npm i -g opencode-ai`; no `opencode auth login`).
- `gemini` needs `GEMINI_API_KEY` (in `~/.gemini/.env`): Google refuses Gemini CLI's "Log in with Google" for
  individuals, and Settings shows its message.
- `dsh` needs `DEEPSEEK_API_KEY` in `~/.dsh/.env`.

1. Make a self-signed certificate in the VM (for the TLS scenario):
   `openssl req -x509 -newkey rsa:2048 -nodes -keyout ~/edge-tls/key.pem -out ~/edge-tls/cert.pem -subj /CN=localhost -days 3`.
2. Start the fixtures. They serve on `localhost` and `127.0.0.1` (two origins), and over HTTPS on the next port:
   `node bench/edge-serve.mjs 8790 bench/results/<run>/events.jsonl ~/edge-tls/key.pem ~/edge-tls/cert.pem`.
3. Start the MoPilot instances in the background with their own user data. The `claude` and `switch` cells use port
   9371, the `codex` cell 9372, and the ACP cells 9373 (`CELLS` in `lib/edge.mjs`):
   `SAGE_E2E_BACKGROUND=1 MOPILOT_BENCH_ATTENDED=1 MOPILOT_FLAGS=native.claude.chrome=0 MOPILOT_USER_DATA=/tmp/mpE1 MOPILOT_CHROME_RELAY_USER_DATA_DIR=/tmp/mpE1-chrome MOPILOT_CHROME_RELAY_EXECUTABLE=$PWD/bench/scratch-chrome.mjs MOPILOT_SCRATCH_CHROME_EXTENSION=$PWD/electron/chrome-extension npx electron . --remote-debugging-port=9371`.
   The two Chrome variables give a Chrome the instance starts its own profile, through a wrapper that refuses any start
   without one: the VM's default Chrome profile is a real, signed-in one. Choose Full access in each.
   `MOPILOT_SCRATCH_CHROME_EXTENSION` has the wrapper load MoPilot's extension from that folder into every Chrome it
   starts, over Chrome's DevTools pipe (`Extensions.loadUnpacked`, `bench/lib/chromePipe.mjs`), and check that the
   extension's service worker runs. It uninstalls the profile's earlier load first: a load over it keeps the old service worker scripts, so an extension change would not be tested (the pairing goes with it, and `MOPILOT_SCRATCH_CHROME_PAIR=1` pairs again). Chrome 155 ignores `--load-extension` and drops an unpacked extension when it next
   starts, so a profile loaded once by hand loses it: without the extension, browser use fails. When it does not run,
   the wrapper quits that Chrome and exits 3, saying why. A start on a profile whose Chrome already runs (its
   `SingletonLock` names a live process) is handed over to that Chrome as it is. Pages the start was asked to open
   (MoPilot's pairing page among them) open only once the extension runs. Every outcome is also appended to
   `<profile>/scratch-chrome.log`, since MoPilot starts the wrapper with no output.
   `MOPILOT_SCRATCH_CHROME_PAIR=1` has the wrapper press **Pair** on MoPilot's pairing page
   (`options.html#pair=…`), as the run's operator: pairing waits for a person by design, and a bench run has none.
   MoPilot starts no Chrome for a profile that does not show the extension, so before a browser-use run start the
   bench's Chrome on its profile with `node bench/bench-chrome.mjs <profile>` (VM only): it starts Chrome through the
   wrapper with both switches and waits until the profile shows the extension on (Chrome writes that about 10 s after
   the load). MGB uses the same helper in the GUI session for every windowless start and fixture mark/sign-in URL,
   always on `MGB_CHROME_PROFILE` (default `~/mgb-scratch-chrome`). With no URL the helper starts windowless;
   `node bench/bench-chrome.mjs <profile> 40 <fixture URL>` opens the URL only after the extension runs. A failed
   Chrome pre-launch or mark is a task setup error: MGB records UNGRADABLE without a model turn, then retries setup
   on the next task. The tidy keeps the bench Chrome running and closes its windows; any later cold start still
   goes through the helper. `--skip-chrome` skips Chrome setup and browser-use tasks as before.
4. Run from the host: `scripts/vm-exec.sh node <checkout>/bench/edge-run.mjs --cells claude,switch --run edge1`.
   Options: `--cells`, `--scenarios a,b`, `--run`, `--base`, `--tls-base`, `--timeout` (default 180 s), `--results`,
   and `--click-chrome`. Without it, offered Chrome and system-browser actions ("Open in Chrome", "Open in your
   browser", "Continue in Chrome") are recorded and never clicked. An instance started with
   `MOPILOT_CHROME_RELAY_USER_DATA_DIR` opens every one of them, the sign-in hand-off to a vendor's Chrome route
   included, in Chrome on that folder through the wrapper (`capabilities/browser/userChrome.cjs`, #1535); without the
   folder they would open the VM's default profile, so pass `--click-chrome` only for instances started as in step 3. The harness version contract also quits any Chrome that started during its
   edge suite.

Results go to `results/<run>/<cell>/<scenario>.json`. Each record holds the verdict and why, the page's events, the
turn (time, confirmations, hand-overs, strips), and every offered action with what clicking it did. A screenshot of
the app window is kept for each run that did not pass. The run also writes `results/<run>/summary-<cells>.md`.

- **Verdicts.** PASS, FAIL, DEAD-END (the run otherwise passed, but an offered action errored or changed nothing) and
  UNGRADABLE (a driver error before the prompt reached the agent). A run error after that, such as a switch that did
  not go through, is graded with the error as a reason.
- **What counts.** Only page events up to the end of the turn count, so the driver's own clicks afterwards do not
  (closing the tab fires `pagehide`). The answer is what the chat shows after the last prompt. Each confirmation card
  counts once.
- **Clicking offered actions.** The driver clicks every offered action. A pane notice that stays up for 3 s during
  the turn is clicked then, as a stuck user would, with the Chrome hand-off first. Everything else is clicked after
  the turn. An action that starts a new turn is given 90 s and then stopped. The driver never clicks an account
  sign-in ("Sign in in terminal"). A harness account's "sign-in has expired" banner belongs to the VM's login, not
  to the scenario, so its actions (Re-check, Use another account) are neither clicked nor graded, and its text is
  left out of what a click changed.
- **Sign-in hand-offs.** The driver never types a password or a code. It clicks "Done, continue" 10 s after a
  hand-off appears (the hand-off ends the agent's turn; the button starts the next one). On a sign-in sheet it picks "I'll sign in myself" after 10 s.
- **Chrome.** A run records when an offered "Continue in Chrome" started Chrome, but never quits Chrome: it can't
  tell whose Chrome it is. Close it between runs if you need a clean state.


## Motion moments (#1511)

The motion bench measures how the in-between states look and move: a recording of the same scripted moment in each
app, and frame metrics taken from it. It runs inside the VM, like every arm here.

**Recording.** `bench/motion-record.mjs` brings the arm's app forward and records its front window with
`screencapture -v`. That is the macOS recorder the VM already grants Screen Recording to, so no new permission is
asked. It captures the frames the screen draws, with exact presentation times. The recorder plays the moment's steps
(`bench/lib/motion/moments.mjs`: new chat, model, paste, keys, clicks, waits, marks) through the same GUI calls as the
desktop arms, so every app gets the same input. It writes `<moment>.mov` and `<moment>.json` (window, regions in
screen points, clock sync, marks, app version) under `results/motion/<run>/<arm>/`.

The catalog's moments:
- `turn-start`: send, first visible output, streaming reveal, turn end;
- `approval`: an approval card enters, Allow is pressed, the card leaves;
- `steps`: a finished turn's work unfolds and one tool row opens and closes (the vendor rows are opened by hand);
- `queue`: a message sent while the reply streams waits in the queue;
- `stop`: Esc while the reply streams;
- `browser`: the agent opens a page in the app's own browser (pane, tab, load progress);
- `cu`: computer use on Calculator. It records the whole screen (`screen: true`), since the cursor and overlay move
  over another app's window;
- `tool-error`: a shell step fails, and the reply says why.

Agent turns in recordings use Sonnet 5.5 at Low effort. Codex uses its cheaper model at low effort. Claude Desktop's
model is picked per session by the recorder; set ChatGPT's and each MoPilot instance's model and effort before
recording. For a MoPilot arm, run one instance (the recorder brings the `Electron` process forward).

    ~/bench/runner/vmlock.sh acquire "<your tag>" "motion recording"
    scripts/vm-exec.sh zsh -lc "cd ~/mopilot && node bench/motion-record.mjs --arm desk-claude --moment turn-start --run m1"
    ~/bench/runner/vmlock.sh release "<your tag>"

Keep a recording window short: other sessions share the VM.

**Clock sync.** Before its steps, the recorder moves the cursor into the window's corner and notes the wall clock. The
first change the recording shows there is that moment in video time, so every mark the recorder took (such as `send`)
can be placed on the recording. Feedback timings use what the screen shows, such as the composer clearing on send. The
marks only bound where a metric looks.

**Metrics.** `bench/motion-metrics.mjs <recording.json>... [--palette <inventory.json>,...] [--scale <n>]` decodes
each recording (`motion/decode.swift`, compiled once into `results/.bin/`). It writes `<moment>.metrics.json`. Each
metric reads a named region:

| Metric | What it reports |
| --- | --- |
| `feedback` | ms from a trigger (a region's first change after a mark, or a time) to the first change in the response region |
| `transition` | one animation's start, duration, time to 95%, overshoot, dropped frames, fitted cubic-bezier, and the closest named curves |
| `cadence` | visible updates of a reveal: count, median / p90 / max interval, updates per second |
| `deadAir` | stretches with no visible change longer than a limit (1 s by default) |
| `dropped` | display refreshes skipped while something moved (a captured-frame gap over 1.5 refreshes) |
| `layoutShift` | vertical jumps of a region's content, in px |

A frame counts as changed when its change mass reaches 64 px² moving by 64 luma levels. That is the luma change summed
over the area that moved by more than 16 levels. A word appearing counts about the same in any region size, while
video keyframe artifacts and a blinking caret do not count. A transition is widened through the sub-threshold steps
of its eased start and tail, and progress is a projection between its first and last frames (`blend`) or the shift
that lines a frame up with the last (`x`, `y`).

`--palette` adds the easing tokens of a JSON file (`{ vendor, motion: { "var:<name>": { value } } }`, one
cubic-bezier per token), so a fitted curve is named against those tokens and the CSS keywords.

**Checking the measuring.** `node bench/motion-metrics.mjs --self-check` writes a synthetic recording with known
motion (`motion/synth.swift`), decodes it and measures it. It runs anywhere, records no screen, and prints `ok` for
each check:
- feedback in 117 ms;
- a 200 ms ease-out fade and a 300 ms `cubic-bezier(.32,.72,0,1)` slide, each named correctly;
- the 2 frames the slide drops;
- a 10-update reveal 100 ms apart;
- 1.6 s of dead air;
- a 20 px layout shift.

The unit tests (`tests/benchMotion*.test.ts`) draw the same timeline straight into frames.

**MoPilot's side, on the Mac, over CDP.** `node scripts/motion-cdp/run.mjs [--families claude,codex,acp]
[--reduced-motion] [--out <dir>]` captures the same turn on MoPilot without the VM. Run it only when #1511's work asks
for it. Each family gets a scratch instance on its fake harness (`scripts/perf-bench/driver.mjs`), in background mode
with Chromium's background throttling off, paced by the perf bench's replay settings (50 tokens/s by default).
Everything goes through CDP; the mouse, keyboard and screen are never used:
- the Animation domain records every animation the page ran, with its element, duration, delay and easing, in
  `animations.json` and `summary.md`;
- `Page.startScreencast` frames go into `frames/`.

Its `recording.json` is measured like a VM recording (`node bench/motion-metrics.mjs <dir>/<family>/recording.json`).
The screencast's frames carry the wall clock, so marks need no cursor sync. A screencast is not a screen recording:
it can skip frames when the page is busy, so its dropped-frame count is an upper bound, and auto-scroll counts as
layout shift. Compare MoPilot's timing values from `animations.json`, and keep the frame metrics for feedback,
cadence and dead air.

**The 12-Grid Bench motion score (#1381).** When a 12-Grid Bench run records the screen, each task run leaves its
recording parts (`<task>.rec-<n>.mov`) and a manifest (`<task>.rec.json`: each part's file and start, and the turn's
start and end). `node bench/motion-metrics.mjs --mgb <run dir> [--scale <n>]` decodes the parts one at a time and
writes `<task>.motion.json` beside each manifest:
- `longestStillMs`: the longest stretch with no visible change on the whole screen, during the turn only;
- `stillsOver3s`: the stretches over 3 s;
- `droppedPerMin`: refreshes skipped per minute of motion.

Each part is measured on its own, so the gap between two parts is never a still stretch. A run with nothing of its turn
recorded has no score (`null`), not a perfect one. The scorecard reads each `<task>.motion.json` with its record and
adds a Motion column: MoPilot's median longest still stretch and drops per minute, then the native arm's. A cell green
on success turns amber, marked ⚠, when MoPilot's median still stretch is over 1.25 × native + 1 s, or its drops per
minute are over 1.5 × native + 2.

## Agent-cursor motion (#3810)

One harness records and scores the agent cursor on three surfaces, on both vendors and on MoPilot, on the same
tasks and display. It extends the motion bench above; nothing here runs outside the VM except the analysis and the report.

| Surface | Vendor arms (`--arm`) | MoPilot arms | How the fixture page is reached |
| --- | --- | --- | --- |
| `cu` computer use | `desk-chatgpt` (Codex Computer Use, Sky), `desk-claude` | `mp-claude`, `mp-codex` | The native `Motion fixture` app (`motion/fixtureapp.swift`: a 1280x800 window with a WKWebView on the fixture page, at the screen's top left below the menu bar); not a browser, so MoPilot's computer use may click it, as the vendors' do; the agent only sees pixels |
| `iab` the app's own browser | `desk-chatgpt` (Codex in-app browser), `desk-claude` (browser pane) | `mp-claude`, `mp-codex` | The prompt gives the address; the agent opens it in its own pane |
| `bu` browser extension | `desk-chatgpt` (ChatGPT for Chrome), `desk-claude` (Claude in Chrome) | `mp-claude`, `mp-codex` (MoPilot's extension) | `bench-chrome.mjs` on the profile in `MOPILOT_BENCH_CHROME_PROFILE`, the page open in its tab |

For the click plans (`cursor-move-*`, `cursor-repeat`) the `cu` arms get the same app with the dots drawn by an AppKit view
(`openNativeFixture`; `MOTION_CU_WEBVIEW=1` keeps the web page): a WKWebView in the guest can stay unpainted, and an agent that sees
a blank window clicks nothing. MoPilot's real-helper cursor is recorded with `node bench/cursor-spec-record.mjs --run <name>`,
which runs `tests/e2e/cuj-cursor-motion-real-helper.spec.ts` (a scripted model, the real helper) for one plan under
`sckrecord` and writes a recording `motion-metrics.mjs` scores with the same detector as a vendor arm. A MoPilot arm over CDP brings the instance's window forward after parking it: the fixture is opened last and would stay in front, and the helper clicks a frontmost app by another route (a real pointer) that did not reach the fixture in the guest, which made the agent's clicks fail for the wrong reason. `MOTION_APPEAR_AFTER=<ms>` widens the analysis window after a click (default 300) for a cursor that lingers, as Sky's does (it stays on the last point until the next action). A screen recording is
about 7 MB/s: delete each `.mov` once its metrics exist when the guest's disk is tight.

The `cu` fixture is a native app, not a Chrome window, because MoPilot's computer use treats browsers as view-only
(its agent reported every click refused) while Sky and Claude Desktop click them: only a non-browser app puts every arm on
the same ground. `buildFixtureApp()` in `drivers/motionKit.mjs` compiles it once per source version into
`results/.bin/motionfixture-<hash>/MotionFixture.app` (ad-hoc signed, bundle id `ai.mopilot.motionfixture`, no Dock
hiding); `openFixture('cu', ...)` starts it in the GUI session with `open -na <app> --args <url> <pid-file>`, and the page's
JS, event log and positions are the served page's, unchanged. `closeFixture()` quits it through AppleScript and, if it is
still running, kills only the pid the app wrote to `/tmp/motion-fixture.pid` (never by name). Closing the window or SIGTERM
also quits it. `bu` still opens the page in the bench's Chrome with the extension.

**How an arm is driven.** Every arm gets the same prompt shape: which tool to use (and not to use anything else), then a
task on one fixture page. The page, not the model, decides every position (`lib/motion/fixture.mjs`; the page loads it as a classic script from `/fixture.js`, because the fixture app's WKWebView runs no ES modules), so a run is
reproducible whatever the model does between actions. Test turns use Sonnet 5.5 at Low on Claude and GPT-6 Luna at low on
ChatGPT / Codex. The page logs what it saw (dots shown, clicks with client and screen coordinates, keys, scrolls, done)
with wall-clock times to a local server, and the recorder saves that as `<moment>.events.json`: the ground truth the
analysis joins with the recording.

The moments (`lib/motion/moments.mjs`, `CURSOR_MOMENTS`):
- `cursor-move-d30`, `-d100`, `-d200`, `-d400`, `-d800`: dots 30, 100, 200, 400 and 800 px apart. Four out-and-back pairs
  at 0, 45, 90 and 135 degrees cover all eight directions (0 is right, angles grow clockwise on screen, 90 is down: the
  way back is 180, 225, 270, 315). Each pair is centred in the viewport; one that does not fit (800 px up and down on a
  short viewport) is skipped and listed in the metrics under `plan.skipped`. Moving between pairs is a repositioning and is not scored;
- `cursor-repeat`: six clicks on one spot; `cursor-click-type`: a click into a field, then typing `motion bench 0123` and
  Enter; `cursor-scroll`: the mouse wheel down to an END banner and back up;
- `cursor-idle-fade`: one click, then 20 s of nothing, to see when and how the cursor fades;
- `cursor-calibration`: no agent. The page moves a target at 240, 600 and 1200 px/s (known position at every instant).

**Recording at a high frame rate.** `bench/motion/sckrecord.swift` records the display with ScreenCaptureKit at the
requested rate (`--fps`, default 120) into an H.264 `.mov` whose frame times are the capture's own presentation times, and
prints the wall-clock time of the first frame, so page events and the recording share a clock without the cursor-move
sync. `--recorder screencapture` falls back to the `screencapture -v` path of the other moments. Risks to state with any result:
- **The VM's GPU frame-rate limit.** The Tart guest has a paravirtualized display; it can refresh at 60 Hz at best, often
  less under load, and ScreenCaptureKit delivers a frame only when the screen changed. A request for 120 fps is a ceiling,
  not a promise. Cursor motion faster than the display is invisible to every metric here. Run `cursor-calibration`
  first on every VM image: it reports the recorder's measured fps, the share of dropped frames, the fastest speed it tracks
  and the clock offset between page and recording. If the recorder's rate is under 55 fps, treat `cursor.captureLimited` as the answer to every
  cursor-rate question;
- the compiled `sckrecord` needs its own Screen Recording grant (`vm-grant.sh` has none for it yet, and a person grants it);
- the real pointer is part of the recording (`showsCursor`), so an arm that moves the real pointer is seen too.
- `sckrecord` captures at 1x (the display's point size) unless `--retina` is passed. Cursor recordings are 1x: the recorder JSON
  names `pxPerPoint: 1` and, for computer use, `crop: "<W>x<H>"` (the fixture window's right and bottom edge from the page's `ready`
  event, else 1280x800), which `motion-metrics.mjs` hands to the decoder;
- for computer use the agent app's window is moved to the screen's bottom right corner (440x420) once it has the turn, so it
  cannot cover the fixture's viewport. The viewport's place on screen comes from the page's `ready` event
  (`screenX/Y`, `outerWidth/Height`, `viewport`); the cursor-at-click fit is only the fallback;
- the detector finds Sky's grey disc (14-40 px, round, darker than the page) as a blob before the arrow path runs.

**What the analysis reads** (`lib/motion/cursor.mjs`, `cursorBench.mjs`, `skyFit.mjs`):
- *Detection.* With the page's place known (`screenX - clientX` of trusted clicks, else fitted from the cursor at each
  click), the cursor is whatever differs by more than 24 luma levels from the fixture's flat background inside its viewport,
  minus the counter, the fixture dots (by their colour) and, for typing, the field. The position is the weighted centre, pulled
  in twice to within 48 px of itself. A recording of an unknown page falls back to the median of its frames, which makes a cursor
  that rests for half the time part of the background: say so when it is used.
- *Moves.* Cut from the track by speed over 50 ms (start 80 px/s, stop 25 px/s), trimmed to where the cursor was within 1.5 px
  of its start and its end, and matched in order to the plan's moves. A move that never shows is `matched: false`.
- *Rate and jitter.* `cursor.fps`, `cursor.updates.p50/p95/jitter`: the intervals between frames where the cursor changed
  place, against `cursor.capture` (the recorder's own intervals). Decode cursor moments at `--scale 2` (the default for
  them) and watch memory: a minute at 120 fps is thousands of frames.
- *Path and easing.* Per move: path length over distance, the largest sideways deviation, overshoot, when the speed peaks,
  and a fit of an arc (one cubic whose thirds are pushed sideways) driven by a spring (response, damping, start offset): fitted
  response, damping, rms and p95 error in px, and the gain of the arc over a straight path. The reference is
  `shared/cursorMotionPlan.mjs` (`planMove` and `sampleAt`) when it exists, else a stub built from the recovered Sky constants;
  `fit.planner.source` says which. The measured move is compared with the plan for the same start and end after the best shift of up to 150 ms.
  Both sides time a move from the first frame the cursor visibly moves to where it settles (under 25 px/s), while the shared plan counts to full rest, so
  compare durations between arms, not against the plan.
- *Latency.* `latency.firstActionMs` (send to the first move or click), `thinkMs` (last click to the cursor moving),
  `dwellMs` (arrival to click), `feedbackMs` (click to the page's counter changing on screen: the display and capture baseline), `cycleMs`
  (click to click). `actions.<kind>.p50/p95` are per-action wall times (click, type, scroll, screenshot) from the chat's transcript,
  when `files.transcript` names one next to the recording and `files.transcriptKind` is `claude` or `codex`.
- *Activity.* `gaps` (stretches over 1 s with no visible change anywhere on screen) and `overlay.updatesPerSecond` (cadence of
  changes in the `thumb` corner region, where an overlay or thumbnail updates; its fractions are a guess to calibrate per app in the VM).
- *Typing, scroll, idle.* Key intervals and echo, scroll event cadence and steps, and `idle`: the delay before the cursor
  starts to fade and how long the fade takes, from the cursor's pixel mass.
- *Renderer jank.* With `--cdp <port>` the recorder installs a `PerformanceObserver` (long tasks, long animation frames) in the
  app's page and writes `<moment>.jank.json`; `jank` is the count, per minute and blocking time over the turn. It covers MoPilot's
  renderer and ChatGPT's (its CDP port); Claude Desktop quits with a debugging port, so its jank is not measured.
- *Cost and pass rate.* `node bench/motion-metrics.mjs <recording.json> --records <mgb run dir>` adds steps, tokens, wall
  time and pass rate of `f4-week-plan` and `f2-onboarding` from the 12-Grid Bench run records; the runs themselves are
  `bench/mgb-run.mjs` runs, not part of a motion recording.

**Recording and measuring.**

    ~/bench/runner/vmlock.sh acquire "<your tag>" "cursor motion"
    scripts/vm-exec.sh zsh -lc "cd ~/mopilot && node bench/motion-record.mjs --arm desk-chatgpt --moment cursor-calibration --run c1"
    scripts/vm-exec.sh zsh -lc "cd ~/mopilot && node bench/motion-record.mjs --arm desk-chatgpt --moment cursor-move-d200 --surface cu --run c1"
    ~/bench/runner/vmlock.sh release "<your tag>"
    node bench/motion-metrics.mjs results/motion/c1/desk-chatgpt/cursor-move-d200.json
    node bench/motion-metrics.mjs --self-check

`--self-check` now also draws a moving cursor on a spring (`synth.swift cursor`), decodes it and checks that the detection finds two
moves of the right length and start, and that the fit recovers the spring's response. Delete the vendor chats a run leaves.

**The report.** `node bench/motion-report.mjs --vendor ChatGPT=results/motion/c1/desk-chatgpt --ours MoPilot=results/motion/c1/mp-codex
[--moments cursor-move-d200,...] [--out <dir>]` prints, per moment, a ChatGPT / MoPilot / delta table (aligned, better,
worse or differs for each metric) and, for each planned move, how our recording lies over the vendor's. With `--out` it writes
`overlay.html` (the two paths in the chord frame and distance over time, vendor blue, ours orange) and `report.json`.
Two moves are *aligned* when all of these hold (proposed defaults, overridable with `--path-rms`, `--duration`, `--frame-error`, `--offset`):
- path RMS <= 4 px (the symmetric distance between the two drawn paths, in the move's chord frame);
- duration within 8%;
- per-frame position error p95 <= 6 px, after removing the timing offset;
- timing offset <= 1 frame at 60 Hz (16.7 ms).

A vendor move on a different viewport size is scaled to ours before the comparison, and says so. The scalar rows have their own tolerances (`METRIC_SPECS` in
`lib/motion/align.mjs`): one 60 Hz frame for timings, 10% for rates and durations, 1 px for fit error.

Unit tests (`tests/benchMotionCursor*.test.ts`) draw synthetic recordings of the fixture with known motion straight into
frames, as the other motion tests do. Not covered by them, because they need the VM: `sckrecord`, the fixture server and
window setup (`drivers/motionKit.mjs`), the recorder's flow, and any real vendor app.
