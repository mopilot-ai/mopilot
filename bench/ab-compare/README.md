# ab-compare: MoPilot vs Vercel agent-browser

A repeatable head-to-head of MoPilot's page representation (`electron/capabilities/browser/pageAgent.cjs`, the
`tree` op, stitched across cross-origin frames as `hostPage.readPage` does) against [`agent-browser`](https://github.com/vercel-labs/agent-browser)
(Apache-2.0), both in the same headless system Chrome. It never launches MoPilot and never touches your screen,
so it is safe to run on a Mac (AGENTS.md).

    node bench/ab-compare/run.mjs [--pages default|key,key|url,url] [--out dir] [--latest]

The first run installs `bench/ab-compare/node_modules` (agent-browser, playwright-core, js-tiktoken; versions pinned in
`package.json`). `--latest` installs the newest published agent-browser into a temp folder and runs that instead. Set
`AB_CHROME` to use another Chrome. A full run takes about 10 minutes (10 live pages, 11 fixture cases, two tools).

Output: the report as JSON on stdout and in `<out>/ab-compare-<date>.json`, plus the markdown table in
`<out>/ab-compare-<date>.md` (default `bench/ab-compare/out/`, git-ignored).

## Reading it

- **Tokens per page** (o200k, js-tiktoken): our `interactive` and `all` looks against agent-browser's `snapshot -i`,
  `-i -u` (with URLs) and `-c` (compact). `refs ours/ab` counts addressable elements. `truncated` is our 50k-character
  cap firing; agent-browser has no cap, which is why one page can dwarf the rest. Pages are live, so numbers drift;
  compare the ratio and the totals, not one page. A page that failed shows `err` and is left out of the totals.
- **Fixture** (`fixture/`, served on 127.0.0.1:8801 with the child on localhost:8802, so the iframe is cross-site):
  one pass/fail per case and tool, each by a real click on the ref the tool printed. `Covered` and `Re-render, different
  element` must be *refused* (a pass means nothing was clicked); `Hidden` must not be listed; the others must land on
  the right element. After "re-render, same role and name" the click must reach the *new* element.
- **Fixed context cost**: o200k tokens of our `browser_*` tool schemas (`hostToolSpecs` SPECS) against `agent-browser skills get core`.
  This is what a model carries before it does anything; it excludes the desktop (CU) schemas.

Our side reads the top frame and every cross-site iframe over CDP through `readThroughClosedRoots`, as `tab.agent` does; a same-process frame is evaluated in the page.

Timing: `ours ms` is the tree call only; agent-browser's per-call time includes its CLI start, so the JSON's `ms` fields are not comparable across tools.

- **Observability** (`fixture/observe.html`, `observe.mjs`): Web Vitals, accessibility audit, HAR, performance trace and
  video, through the same modules our `browser_vitals`, `browser_accessibility_audit`, `browser_har`, `browser_perf_trace`
  and `browser_record` run (`electron/capabilities/browser/devtools/`), against agent-browser's `vitals`, `a11y`,
  `network har`, `trace` and `record`. The page plants an image without alt, an unlabeled input, a cookie and a layout
  shift: an audit passes when it names `image-alt` and `label`, a HAR when it keeps the request and not the cookie.
  React inspection (`browser_react` against `react tree`, opened with `--enable react-devtools`) runs on the live
  https://react.dev/ and passes with at least five components listed. agent-browser's `record` needs ffmpeg on the PATH. `--observe-only` runs just this section (about a minute).

## Weekly run

Run `node bench/ab-compare/run.mjs --latest` once a week (and after any change to `pageAgent.cjs`) and post the markdown
table on the tracking issue (#3571). It is a manual run on purpose: it needs a real Chrome and the live web, and no
workflow here uses paid runners.

The pure parsing, scoring and report code is `bench/lib/abCompare.mjs`, covered by `tests/benchAbCompare.test.ts`.
