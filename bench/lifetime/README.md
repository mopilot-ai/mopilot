# Claude Code process lifetime benchmark

Tracks #1830: MoPilot keeps its Claude Code CLIs no worse than Claude Desktop on memory and on switch latency.

## What it measures

`run.mjs` drives a MoPilot dev instance over CDP:

1. N chats each run a real multi-step task (write a module and its tests, run them, fix, report) at once.
2. The instance's process tree (`phys_footprint`, every CLI and its MCP servers) is sampled through an idle period.
3. A follow-up's first output is timed three ways: **warm** (CLI alive), **cold** (CLI ended and the chat not opened
   before the send), and **warmed on open** (CLI ended, the chat opened a moment before the send).

`cd-sample.mjs` passively samples Claude Desktop's CLIs on the same Mac: each CLI's tree footprint, age and CPU. It reads
`ps` and `footprint` only.

## Running it

Run it inside the VM (`scripts/vm-exec.sh`), never on the user's Mac, on a MoPilot dev instance with scratch user data,
its own debugging port and `SAGE_E2E_BACKGROUND=1` (AGENTS.md); `scripts/dev.mjs` refuses that instance on the host:

```bash
node scripts/test-chats.mjs folder --run lifetime
SAGE_DEV_PORT=5771 SAGE_DEBUG_PORT=9571 SAGE_USER_DATA=<scratch copy> SAGE_E2E_BACKGROUND=1 MOPILOT_TEST_RUN=lifetime npm run dev
node bench/lifetime/run.mjs --cdp 9571 --cwd <the folder printed above> --chats 6 --idle-min 3
node bench/lifetime/cd-sample.mjs
node scripts/test-chats.mjs cleanup --port 9571 --run lifetime
```

`--claude-bin` points the instance at a specific Claude Code login wrapper. Results go to `bench-lifetime.json` and
`cd-sample.json`. Record each run's summary on #1830.
