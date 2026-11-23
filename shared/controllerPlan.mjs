// The ControllerPlan (docs/control-plane/design.md): who controls each surface of a chat on a segment, the in-app browser (iab), computer use (cu) and the user's Chrome (bu), and how a switch changes it.
// Pure, so main's record (electron/session/controllerPlan.cjs), the switch sheet and the tests agree.

/** @typedef {'mopilot-browser' | 'mopilot-computer' | 'codex-computer-use' | 'your-chrome' | 'mopilot-chrome' | 'claude-in-chrome' | 'codex-browser-plugin'} Controller */
/** @typedef {{ iab: Controller | null, cu: Controller | null, bu: Controller | null }} Controllers */
/** @typedef {'iab' | 'cu' | 'bu'} Surface */

/** @type {Surface[]} */
export const SURFACES = ['iab', 'cu', 'bu'];

/** How the switch sheet names each surface. */
const SURFACE_NAME = { iab: 'the built-in browser', cu: 'the computer', bu: 'your Chrome' };

/** How the switch sheet names each controller. */
export const CONTROLLER_LABEL = {
  'mopilot-browser': "MoPilot's browser tools",
  'mopilot-computer': "MoPilot's computer use",
  'codex-computer-use': 'Codex Computer Use',
  'your-chrome': "MoPilot's Your Chrome tools",
  'mopilot-chrome': "MoPilot's Chrome connection",
  'claude-in-chrome': 'Claude in Chrome',
  'codex-browser-plugin': 'the Codex Browser plugin',
};

/**
 * The one controller of each surface for a session, or null where nothing controls it. `tools` are the registry
 * tools every session is shown now (their switches and the capability health record applied), `channel` whether
 * the session gets MoPilot's tools at all, `yourChrome` whether the browser channel is Your Chrome, and
 * `ownChrome` whether MoPilot serves the user's Chrome to the session's own plugin (its Chrome backend on a native
 * Codex thread, #1319 G2), `vendor` the harness's own controller of the user's Chrome and of the computer, as its family names it (Claude
 * in Chrome, the Codex plugin's Chrome and Codex Computer Use). A vendor controller replaces MoPilot's for
 * its surface, as the session's own hide rule does (CM-X01). `vendor.iab`: the harness's plugin drives the in-app
 * browser pane itself (the Codex Browser plugin's "iab" backend); MoPilot's browser tools, when the session has
 * them, still name the pane's controller, since they drive the same tabs.
 * @param {{ channel: boolean, tools: string[], yourChrome: boolean, ownChrome?: boolean,
 *           vendor: { chrome: Controller | null, computer: Controller | null, iab?: Controller | null } }} i
 * @returns {Controllers}
 */
export function decidePlan(i) {
  const has = (/** @type {string} */ prefix) => i.channel && i.tools.some((t) => t.startsWith(prefix));
  // MoPilot's own Chrome: its backend for a native Codex thread's plugin, or the chrome_* tools on any session
  let bu = i.ownChrome ? 'mopilot-chrome' : i.vendor.chrome;
  if (!bu && has('chrome_')) bu = 'mopilot-chrome';
  if (!bu && i.yourChrome && has('sage_browser_')) bu = 'your-chrome';
  let cu = i.vendor.computer;
  if (!cu && (has('desktop_') || has('computer_'))) cu = 'mopilot-computer';
  // browser_* drive the pane; with them off, sage_browser_* do while the channel is the built-in browser
  const iab = has('browser_') || (!i.yourChrome && has('sage_browser_')) ? 'mopilot-browser' : (i.vendor.iab ?? null);
  return { iab, cu, bu };
}

/**
 * The surfaces whose controller differs between two plans.
 * @param {Controllers} from
 * @param {Controllers} to
 */
export function planChanges(from, to) {
  return SURFACES.filter((s) => from[s] !== to[s]).map((surface) => ({ surface, from: from[surface], to: to[surface] }));
}

/**
 * The switch sheet's line for each change: "After the switch, your Chrome is controlled by …".
 * @param {{ surface: Surface, from: Controller | null, to: Controller | null }[]} changes
 */
export function changeLines(changes) {
  return changes.map(({ surface, from, to }) => {
    const name = SURFACE_NAME[surface];
    if (!to) return `After the switch, nothing controls ${name} (${CONTROLLER_LABEL[/** @type {Controller} */ (from)]} does now).`;
    if (!from) return `After the switch, ${name} is controlled by ${CONTROLLER_LABEL[to]}.`;
    // a vendor's Chrome controller keeps its own tab group and site permissions (MoPilot's routes share theirs):
    // the sheet says they stay behind
    const vendor = (/** @type {Controller} */ c) => c === 'claude-in-chrome' || c === 'codex-browser-plugin';
    const behind =
      surface === 'bu' && (vendor(from) || vendor(to)) ? " Its tabs and site permissions there don't carry over, so it asks again." : '';
    return `After the switch, ${name} is controlled by ${CONTROLLER_LABEL[to]} instead of ${CONTROLLER_LABEL[from]}.${behind}`;
  });
}

/**
 * The harness's own controller of the user's Chrome for a plan, when it isn't MoPilot, or null.
 * @returns {'claude-in-chrome' | 'codex-browser-plugin' | null}
 */
export function vendorChromeIdOf(/** @type {Controllers | null} */ plan) {
  if (plan?.bu === 'claude-in-chrome' || plan?.bu === 'codex-browser-plugin') return plan.bu;
  return null;
}

/** Who drives the user's Chrome for a plan when it isn't MoPilot (the credential route, "Continue in Chrome"), or null. */
export function vendorChromeOf(/** @type {Controllers | null} */ plan) {
  const id = vendorChromeIdOf(plan);
  return id ? CONTROLLER_LABEL[id] : null;
}
