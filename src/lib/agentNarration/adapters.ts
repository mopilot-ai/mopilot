// Default vendor adapters for browser and desktop control narration.
import { ownTable } from '../../../shared/ownTable.mjs';
import { hostProblem, skyProblem, vendorProblem } from '../../../shared/skyComputerUse.mjs';
import { VENDOR_SOURCES } from '../../../shared/vendorErrors.mjs';
import { q, step, recordApp, type ControlAdapter } from './common';
import { browserStep, desktopStep, appStep, appOf } from './tools';
import { READS, builtinHandoff, chromeHandoff, chromeTabs, cuaHandoff, cuaTabs, ownChromeHandoff } from './handoffs';
import { cuaStep, narrateScript } from './program';
// Claude in Chrome: the shared browser vocabulary, with its _mcp suffixes and javascript_tool name
// mapped onto it. The Claude desktop app's built-in browser shares the tool set, but it is neither the
// user's Chrome nor MoPilot's own browser, so it narrates only.
export const claudeBrowserNarration: ControlAdapter = {
  narrate: (c) => {
    const name = c.tool.replace(/_mcp$/, '');
    return step('browser', browserStep(name === 'javascript_tool' ? 'javascript_exec' : name, c.args, c.result));
  },
  source: (c) => (c.tool === 'javascript_tool' && typeof c.args.text === 'string' ? { code: c.args.text, lang: 'javascript' } : null),
};
export const claudeChromeAdapter: ControlAdapter = {
  ...claudeBrowserNarration,
  // a refusal the extension words (a blocked site, a site you didn't allow) rides on the step with its next step
  narrate: (c, ctx) => {
    const s = claudeBrowserNarration.narrate(c, ctx);
    const problem = s && vendorProblem(c.result, { sources: VENDOR_SOURCES.claudeInChrome, failed: c.failed, read: READS.test(c.tool) });
    return problem ? { ...s, problem } : s;
  },
  handoff: chromeHandoff,
  tabs: chromeTabs,
};

// MoPilot's own Chrome tools share the vendor's verbs, not its result format or handoff inference.
// No tabs_mark is offered here: tabs stay across turns without a mark, and page text is not a handoff;
// a bot check the tools refused or a sign-in page they landed on is (#1639).
export const mopilotChromeAdapter: ControlAdapter = {
  ...claudeBrowserNarration,
  narrate: (c, ctx) => claudeBrowserNarration.narrate(c.tool === 'browser_batch' ? { ...c, tool: 'batch' } : c, ctx),
  handoff: ownChromeHandoff,
};

// The Claude desktop computer-use server: the shared desktop vocabulary, with its per-app tools
// (app_click, app_type, …) naming the app they act in.
const COMPUTER_USE_ALIASES: Record<string, string> = ownTable({ click: 'left_click', drag: 'left_click_drag', computer_batch: 'batch' });
export const computerUseAdapter: ControlAdapter = {
  narrate: (c) => {
    const name = c.tool.replace(/^app_/, '');
    const app = typeof c.args.app === 'string' && c.args.app ? q(c.args.app, 40) : null;
    const s = step('desktop', desktopStep(COMPUTER_USE_ALIASES[name] ?? name, c.args, c.result, app));
    const shown = app ?? recordApp(c.result);
    return shown ? { ...s, app: shown } : s;
  },
};

// MoPilot's own desktop tools as Claude Code sees them (mopilot_computer, prefix stripped): the background
// app_* tools, and the display-scope ones under their short names (computer_batch is desktop_batch).
export const mopilotComputerAdapter: ControlAdapter = {
  narrate: (c) => {
    const s = step(
      'desktop',
      c.tool.startsWith('app_')
        ? appStep(c.tool.slice(4), c.args, c.result)
        : desktopStep(c.tool === 'computer_batch' ? 'batch' : c.tool, c.args, c.result),
    );
    const app = c.tool.startsWith('app_') ? appOf(c.args, c.result) : recordApp(c.result);
    return app ? { ...s, app } : s;
  },
};

export const cuaAdapter: ControlAdapter = {
  // what Sky reported (permission missing, app refused, version mismatch, an unknown code) rides on the step
  narrate: (c, ctx) => {
    const s = cuaStep(c, ctx);
    // a step MoPilot declined for a failed release reads as that, never as the user's "Not approved"
    const problem = s && (c.hostDeclined ? hostProblem(c.hostDeclined, c.result) : skyProblem(c.result, { failed: c.failed }));
    return problem ? { ...s, problem } : s;
  },
  source: (c) => (c.tool === 'js' && typeof c.args.code === 'string' ? { code: c.args.code, lang: 'javascript' } : null),
  handoff: cuaHandoff,
  tabs: cuaTabs,
};
/**
 * MoPilot's browser_script: one Playwright-style program per call on the in-app browser, read like a
 * cua_repl program ("Opened example.com and 2 more steps", "Filled 3 fields"). Its namespace is the
 * session's own server (sage_<nonce> for Codex, mopilot_browser for Claude Code, an ACP session server),
 * so controlStep and controlSource find this adapter by the tool's name.
 */
export const browserScriptAdapter: ControlAdapter = {
  narrate: (c, ctx) => narrateScript(typeof c.args.code === 'string' ? c.args.code : '', null, ctx, 'browser'),
  source: (c) => (typeof c.args.code === 'string' ? { code: c.args.code, lang: 'javascript' } : null),
};

// MoPilot's in-app browser tools as Claude Code sees them (mopilot_browser, prefix stripped): the shared
// browser vocabulary under their short names (browser_batch and browser_script keep theirs and are read by name).
export const mopilotBrowserAdapter: ControlAdapter = {
  narrate: (c) => step('browser', browserStep(c.tool, c.args, c.result)),
  handoff: (c) => builtinHandoff(c.tool, c.args, c.result),
};
