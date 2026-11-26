// Every feature flag, defined once: default, owner, removal date and remote mode, read by main, the web and the tests.
import { ACP_CATALOG, ACP_IDS } from './harnessCatalog.mjs';

/**
 * A remote mode says what the server may do with a flag: `kill` only turns a shipped feature off (today's switches);
 * `toggle` may also turn it on, for a feature still in development (the server side comes later). `remove` is the
 * last day the flag may exist (YYYY-MM-DD, UTC), or `permanent` for a lasting kill switch.
 */
const kill = (key, description, more = {}) => ({
  key,
  default: true,
  owner: 'platform',
  remove: 'permanent',
  mode: 'kill',
  description,
  ...more,
});

/**
 * Off in a Windows build: computer use is a macOS Swift helper. Basic harnesses run there too: their tools reach them
 * through the Rust sage-mcp (core/crates/sage-mcp), which the Windows build ships in place of the Swift one.
 */
const NOT_ON_WINDOWS = { win32: false };

export const FLAG_DEFS = Object.freeze(
  [
    kill('harness.codex.enabled', 'Codex chats'),
    kill('harness.claude.enabled', 'Claude Code chats'),
    kill('tier.basic.enabled', 'the basic (ACP) harness tier'),
    ...ACP_IDS.map((id) =>
      kill(`harness.acp.${id}.enabled`, `the ${ACP_CATALOG[id].label} basic harness`, { default: ACP_CATALOG[id].enabled }),
    ),
    kill(
      'app.update.stealth',
      'with an update downloaded and nothing running, the app restarts into it after ten unfocused minutes (app/stealthUpdate.cjs)',
    ),
    kill('shared.computerUse.enabled', 'computer use', NOT_ON_WINDOWS),
    kill('shared.computerUse.unattended', 'computer use while the person is away', NOT_ON_WINDOWS),
    kill('shared.computerUse.parityTools', 'the desktop_* computer-use tools in place of computer_*', NOT_ON_WINDOWS),
    kill(
      'shared.computerUse.hideBeforeAction',
      "while a chat holds the desktop, MoPilot's windows and the apps it may not use are hidden",
      NOT_ON_WINDOWS,
    ),
    kill(
      'shared.computerAccess.enabled',
      "computer access (#1364): a kill switch only; the person's own switch (Settings → Computer access) is off by default",
    ),
    kill('shared.browser.extension', "the user's Chrome as a browser channel through the browser extension"),
    kill('shared.browser.panelCdp', 'the browser pane driven over CDP'),
    kill('shared.browser.parityTools', 'the native-shaped browser tools'),
    kill('shared.browser.devPreview', 'dev-server previews in the browser pane'),
    kill('shared.browser.agentCursor', "the agent's cursor drawn in the browser pane"),
    kill(
      'shared.browser.webmcp',
      "the tools a page publishes for agents (WebMCP, #3571 G6): the page API in the built-in browser's pages, and browser_page_tools / browser_page_tool (chrome_* in the user's Chrome) on every harness",
    ),
    {
      key: 'superagent',
      default: false,
      owner: 'superagent',
      remove: '2027-03-31',
      mode: 'toggle',
      description:
        'Superagent (S0 and S1): takes work from GitHub, stores each event once, and records what it would accept. While off, nothing of it runs, polls, opens a database or shows UI',
    },
    {
      key: 'shared.browser.turnTrace',
      default: false,
      owner: 'browser',
      remove: '2027-02-28',
      mode: 'toggle',
      description:
        "the opt-in turn trace (#3571 G5): the built-in browser's frames, actions, HAR and console per turn in the chat's folder, and Replay on the turn",
    },
    kill('shared.browser.viewTabs', "the pane's tabs are main-owned WebContentsViews; off, the pane hosts <webview> guests as before"),
    kill(
      'shared.browser.import',
      "importing bookmarks, history and cookies from the user's other browsers into the pane (Settings → Browser)",
    ),
    kill(
      'shared.browser.loginAssist',
      'the built-in browser offers saved logins under sign-in fields and asks to save a password the user signs in with',
    ),
    kill(
      'shared.browser.systemPasskeys',
      "the built-in browser's passkey requests go to macOS's own sheet when the package holds the entitlement (docs/iab-passkeys.md)",
    ),
    kill(
      'shared.browser.siteRiskRemote',
      "the built-in browser's site risk classes may also ask a remote host-hash check (MOPILOT_SITE_RISK_URL): off by default",
      { default: false },
    ),
    kill(
      'shared.browser.chromeRelay',
      "B2 step 1 (design D5): MoPilot's own CDP relay to the Playwright Extension serves the user's Chrome to the native-shaped tools (app/chromeRelay.cjs, read at startup); off by default, turned on in an unpackaged build with MOPILOT_FLAGS for the comparison runs",
      { default: false },
    ),
    kill(
      'shared.browser.chromeExtension',
      "B2 step 2 (design D5): MoPilot's own Chrome extension (electron/chrome-extension) is the channel instead of the relay, for every harness (app/chromeRelay.cjs, read at startup); off by default until it ships in the Web Store",
      { default: false },
    ),
    kill(
      'shared.browser.chromeExtensionByDefault',
      "with both switches off, sessions whose harness has no Chrome controller of its own (ACP, managed Codex threads, Claude without Claude in Chrome) get the chrome_* tools over MoPilot's extension wherever the build ships it (#1483)",
    ),
    kill(
      'shared.browser.chromeExtensionAutoAdd',
      'a packaged build offers its Chrome extension to Google Chrome through the External Extensions preference (#1632); off removes the file',
    ),
    kill(
      'shared.browser.chromePageTree',
      "chrome_navigate and a chrome_computer click also return the page's interactive elements (#1699 round trips), for every harness (BU A/B: Claude -19% calls, -42% chars; Codex 15/20 -> 19/20, median 25.5 -> 21.3 s, +25% chars)",
    ),
    kill(
      'shared.browser.chromePageText',
      "chrome_navigate and a chrome_computer click also return the start of the page's visible text (about 1.5k characters), so reading a mail or an article takes no get_page_text step (#3810 BU: 10 read steps after navigate or click in one task); off by default until the A/B on calls and tokens per task",
      { default: false },
    ),
    kill('shared.visionFallback', 'a vision model reads the screen for a model that takes text only'),
    kill('shared.dictation.enabled', "dictation on every surface and engine; shared.dictation.local turns off only this Mac's recognizer"),
    kill('shared.dictation.local', "this Mac's own speech recognizer for dictation"),
    kill(
      'shared.dictation.chatgptStream',
      "the ChatGPT login's streaming dictation (live words); off leaves it transcribing whole recordings",
    ),
    kill(
      'shared.design.enabled',
      'design systems kept as files in the project, and the design_* tools every harness gets for them (electron/design)',
    ),
    kill('channel.claude.sdkMcp', "MoPilot's tools reach Claude Code over the SDK's in-process MCP"),
    kill('channel.codex.threadConfigMcp', "MoPilot's tools reach Codex through the thread's MCP config"),
    kill('channel.acp.sessionMcp', "MoPilot's tools reach a basic harness through the ACP session's MCP servers"),
    kill('plugins.claude', "MoPilot's plugin store delivered to Claude Code (electron/plugins/delivery.cjs)"),
    kill('plugins.codex', "MoPilot's plugin store delivered to Codex (electron/plugins/delivery.cjs)"),
    kill('plugins.acp', "MoPilot's plugin store delivered to basic harnesses (electron/plugins/delivery.cjs)"),
    kill('codex.disableUserNodeRepl', "Codex threads start without the user's own node_repl tool"),
    kill('native.codex.enabled', "Codex threads load the vendor's own browser and computer-use plugin (unified-computer-use)"),
    kill(
      'native.codex.inAppBrowser',
      'on a native Codex thread, the Browser plugin\'s in-app browser ("iab") is MoPilot\'s pane (iabBackend.cjs)',
    ),
    kill('native.claude.chrome', 'Claude Code sessions on a claude.ai subscription use the vendor-native Claude in Chrome'),
    kill(
      'native.claude.artifacts',
      'Claude Code sessions get its Artifact tool (publishing to claude.ai) unless the user turned it off (electron/harness/claude/artifacts.cjs)',
    ),
    kill(
      'codex.browser.chromeExtension',
      "native Codex threads drive the user's Chrome through MoPilot's own extension wherever the build ships it (browser/chromeControl.cjs codexChromeOn); off, they use the vendor's own Chrome (the ChatGPT extension)",
    ),
    kill('data.legacyMirror', 'app state is also mirrored to the legacy files (electron/app/appState.cjs)'),
    kill(
      'shared.perf.probe',
      'the streaming performance probes (electron/perf/probe.cjs, src/session/perf.ts; docs/performance/measurement.md): off unless turned on, in an unpackaged build with MOPILOT_FLAGS=shared.perf.probe=1 (the benchmark, development)',
      { default: false },
    ),
    kill(
      'shared.prewarm',
      "a new chat's harness process (and its session where that writes nothing visible) starts while its composer is open",
    ),
    kill('momo.enabled', 'MoMo (#2139): a kill switch only; MoMo exists just for accounts the server invited (electron/momo/access.cjs)'),
    {
      key: 'momo.outputs',
      default: false,
      owner: 'momo',
      remove: '2027-02-28',
      mode: 'toggle',
      description:
        "MoMo Outputs (#2139, designs/momo-outputs): MoMo's momo_save_file / momo_save_sheet tools and the panel's Outputs list; off, none of it exists for the model or the panel (Reset MoMo still deletes saved files)",
    },
    {
      key: 'momo.home',
      default: false,
      owner: 'momo',
      remove: '2027-03-31',
      mode: 'toggle',
      description:
        "MoMo's home on a Host (M1, designs/momo-m1-home): MoMo's chats, memory, routines and cards live on a machine's Host and keep running with the app closed; off, MoMo runs in the Mac app as before and no client asks a Host for MoMo",
    },
    {
      key: 'momo.hostLink',
      default: false,
      owner: 'momo',
      remove: '2027-03-31',
      mode: 'toggle',
      description:
        "MoMo's home starts and follows its tasks on the user's other machines by itself (#5474, option B): the owner allows MoMo per machine, and the home reaches it over the end-to-end relay session with a key of its own; off, tasks run only on the home's own machine",
    },
    {
      key: 'host.unattended',
      default: true,
      owner: 'host',
      remove: '2027-03-31',
      mode: 'toggle',
      description:
        'Remote Run, a machine chat asks a person when the Host says so (X1): the attention word on the chat row and strip, a card\'s clock and who answered, "Sent from" under a message, the run-on menu in groups. On since the Host matrix passed on Claude Code, Codex and the fake ACP agent with no failure (2026-11-15)',
    },
    {
      key: 'host.machinePage',
      default: true,
      owner: 'host',
      remove: '2027-03-31',
      mode: 'toggle',
      description:
        'Remote Run, the machine page (X2): Settings › Machines opens one page per machine for its status, devices, rules, spending, activity and managed policy; on since its controls were pressed against a real Host over real ssh and the owner agreed after seeing it in both themes (2026-11-16); off, a machine row opens no page',
    },
    {
      key: 'host.local',
      default: true,
      owner: 'host',
      remove: '2027-03-31',
      mode: 'toggle',
      description:
        'A background Host on this Mac (Remote Run H1): "This Mac · keeps running" is offered as a second place to run, and the quit sheet counts its chats (H2). On since scenario S11 passed with a real app process on a runner; nothing is installed until a chat is started there. While off, nothing of it is installed or shown',
    },
    {
      key: 'hosts.nativeSessions',
      default: false,
      owner: 'host',
      remove: '2027-03-31',
      mode: 'toggle',
      description:
        "Remote Run, native sessions (#5576, Phase 4): a machine's list also shows the Claude Code and Codex sessions a person started on it outside MoPilot, read-only, to the person's own Macs only; the Host finds them only when it runs with MOPILOT_HOST_NATIVE_SESSIONS=1. This app flag is not read by anything yet (the app does not set that variable on a Host, nor ask for native rows), so it is inert; it stays off until the slices are reviewed and run against real harnesses in a VM",
    },
    {
      key: 'host.managedPolicy',
      default: false,
      owner: 'host',
      remove: '2027-03-31',
      mode: 'toggle',
      description:
        'Remote Run, a managed policy on a machine (W2): the machine row and its chats show "Managed by <organization>" and the controls the policy locks; off, the app does not show it (the Host enforces the file either way)',
    },
    {
      key: 'host.autoUpdate',
      default: true,
      owner: 'host',
      remove: '2027-03-31',
      mode: 'toggle',
      description:
        "An older Host reached over SSH receives this app's build when automatic updates are enabled (Remote Run, #2709). The app tries at most three times per build and the Host restarts when idle. The machine's manual Update remains available when the switch is off.",
    },
    {
      key: 'host.phoneDirect',
      default: true,
      owner: 'host',
      remove: '2027-03-31',
      mode: 'toggle',
      description:
        "A phone's own enrollment with a Host, introduced by this Mac (Remote Run P2, #2709): machines.enroll, machines.forget and the Mac's switch; on since the real-iPhone S3 run passed (2026-11-16); off, a phone reaches a machine only through this Mac",
    },
    {
      key: 'host.phoneChat',
      default: true,
      owner: 'host',
      remove: '2027-03-31',
      mode: 'toggle',
      description:
        'A phone follows, sends to, stops and starts a chat on a Host directly, with the Mac asleep (Remote Run X4, #2709); on since the real-iPhone checks with the Mac asleep passed (2026-11-16); off, a machine chat is read through the Mac only',
    },
    {
      key: 'host.codePair',
      default: false,
      owner: 'host',
      remove: '2027-03-31',
      mode: 'toggle',
      description:
        'Pairing a Mac by an 8-character code (R2b, #5576): the controlling Mac claims the offer, runs the PAKE over the relay and adds the machine (machines.addByCode); off, the app does not offer it and the IPC refuses.',
    },
    kill(
      'host.enabled',
      'Host (#2709): a kill switch only; Host exists for every signed-in account while it is on (electron/host/access.cjs)',
    ),
    {
      key: 'host.cloud',
      default: false,
      owner: 'host',
      remove: '2027-03-31',
      mode: 'toggle',
      description:
        'Cloud machines (Remote Run track C): New cloud machine, the Cloud group and the machine page section; off, none of it is shown and no provider is called',
    },
    kill(
      'remote.enabled',
      'Mobile Remote (electron/remote): a kill switch only; it exists for every signed-in account while it is on (electron/remote/phoneAccess.cjs)',
    ),
  ].map((d) => Object.freeze(d)),
);

/** Every key, in definition order. */
export const FLAG_KEYS = Object.freeze(FLAG_DEFS.map((d) => d.key));

/** Today in UTC as YYYY-MM-DD, the form removal dates are written in. */
export const flagDay = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);

/** Past its removal date: the flag should be gone. A flag may still exist on its removal date itself. */
export const flagExpired = (def, today) => def.remove !== 'permanent' && def.remove < today;

const isDay = (s) => {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().startsWith(s);
};

/** What is wrong with each definition, one line per problem naming the key and its owner; empty when all are sound. */
export function flagDefProblems(defs, today) {
  const out = [];
  const seen = new Set();
  for (const d of defs) {
    const who = `${d.key} (owner ${d.owner || 'missing'})`;
    if (seen.has(d.key)) out.push(`${who}: defined twice`);
    seen.add(d.key);
    if (typeof d.owner !== 'string' || !d.owner.trim()) out.push(`${who}: no owner`);
    if (typeof d.description !== 'string' || !d.description.trim()) out.push(`${who}: no description`);
    if (typeof d.default !== 'boolean') out.push(`${who}: default is not a boolean`);
    if (d.mode !== 'kill' && d.mode !== 'toggle') out.push(`${who}: remote mode must be kill or toggle`);
    if (d.remove === 'permanent') {
      if (d.mode === 'toggle') out.push(`${who}: a toggle flag needs a removal date`);
    } else if (!isDay(d.remove)) out.push(`${who}: removal date must be YYYY-MM-DD or permanent`);
    else if (flagExpired(d, today)) out.push(`${who}: past its removal date ${d.remove}; remove the flag`);
  }
  return out;
}
