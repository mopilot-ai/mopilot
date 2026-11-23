// What a session's model is told about MoPilot's computer and browser tools, on every harness (#1319 G3): which tools reach the in-app browser, the user's Chrome and the Mac's apps, built from the tools the session is shown and named as that harness sees them.
//
// A native Codex thread gets its own routing note beside the vendor's plugins (channels/codexThreadContracts.cjs
// inAppBrowserNote); every other session (Claude Code, managed Codex threads, ACP) gets this one, so a model never
// has to guess whether a browser tool drives the pane in this app or the user's own Chrome.
const { placement } = require('./hostServers.cjs');
const { noteIgnored } = require('../../ignored.cjs');
const { withSessionsNote } = require('./sessionsNote.cjs');

/**
 * How a session sees tool names: sage-mcp and the http channel (Codex, ACP) show the Registry names; a Claude
 * session shows the host tools on their own servers under short names (hostServers.cjs).
 * @typedef {{ family: (prefix: string) => string, name: (registryName: string) => string }} Naming
 */

/** @type {Naming} */
const REGISTRY_NAMES = { family: (prefix) => `${prefix}*`, name: (n) => n };

/** The names a Claude session sees, with `sageServer` its sage_<nonce> server (mcp__<server>__<name>). */
function claudeNames(sageServer) {
  const full = (n) => {
    const p = placement(n, sageServer);
    return `mcp__${p.server}__${p.name}`;
  };
  return {
    // a family moved to a host server is all of that server's tools; one left on the sage server keeps its prefix
    family: (prefix) => {
      const p = placement(`${prefix}x`, sageServer);
      return `mcp__${p.server}__${p.name.slice(0, -1)}*`;
    },
    name: full,
  };
}

/**
 * What a model is told about payments in MoPilot's pane (#1384, E-P8, CM-J02): MoPilot's own card confirms
 * entering or submitting payment details there, in every mode, so a model that also asks in chat or hands the tab over
 * asks the user twice. Only actions MoPilot's check sees (`tools`, in the pane) are covered: page JavaScript and
 * browsers or apps outside the pane keep the model's own confirmation.
 * @param {string} tools the tools that act in the pane, as the session sees them
 * @param {string} [lead] what the paragraph is about
 */
const paneConfirmNote = (tools, lead = 'Payments in the built-in browser') =>
  `${lead}: before a click, key press or typing through ${tools} enters or submits payment details (a card number, CVC or a card form's Pay button, also in a payment provider's frame), MoPilot shows the user its own confirmation card, naming what is pressed, in every permission mode; the step runs only if they allow it. ` +
  "That card is the user's confirmation: when they asked you to buy, take the step and let the card ask; don't also ask in chat or hand the tab over. If they deny the card, stop and tell them. " +
  "Only those actions in the pane are covered: for a payment with no card form or payment provider's frame in view, page JavaScript you run to submit a form, or a browser or app outside the pane, confirm with the user first.";

/**
 * What a model is told about bot checks and CAPTCHAs (#1615, E-S4b), as Claude in Chrome and ChatGPT's browser agent
 * are: never solved by the agent, in any browser or app, but handed to the user. MoPilot's browser tools also
 * refuse an action on one they recognize (browser/botCheck.cjs), so the note says what to do instead.
 * @param {string} handoff how the user gets the page, as the session's tools allow
 */
const botCheckNote = (handoff) =>
  `Bot checks and CAPTCHAs ("I'm not a robot", "Verify you are human", reCAPTCHA, hCaptcha, Cloudflare Turnstile, picture or slider puzzles), in any browser or app: never click, type into or solve one yourself. ${handoff} MoPilot's browser tools refuse an action on one they recognize.`;

/** A live preview needs an approved launch recipe, not just a saved loopback URL. */
const previewNote = (start = 'browser_preview_start') =>
  `For a live local web preview, use ${start} with command or a launch configuration: MoPilot saves its approved launch details and restarts it when its page reopens after an app restart. A temporary shell process or attaching with url alone cannot be restored. Load the preview tool group if needed.`;

/**
 * The note, or null when the session is shown none of these tools.
 * @param {string[]} names the Registry tools the session is shown
 * @param {{ yourChrome: boolean | 'preferred', ownChrome?: boolean, naming?: Naming }} o yourChrome: true when the
 *   sage_browser_* tools drive the user's Chrome (the browser channel is Your Chrome), else they drive the in-app
 *   browser pane; 'preferred' when the user chose Chrome and the chrome_* tools reach it (BrowserControl.userChrome);
 *   ownChrome: the harness controls the user's Chrome itself (Claude in Chrome), so no tool here needs to
 * @returns {string | null}
 */
function surfaceNote(names, { yourChrome: userChrome, ownChrome = false, naming = REGISTRY_NAMES }) {
  const has = (/** @type {string} */ prefix) => names.some((n) => n.startsWith(prefix));
  const yourChrome = userChrome === true;
  const { family, name } = naming;
  const pane = has('browser_') ? 'browser_' : !yourChrome && has('sage_browser_') ? 'sage_browser_' : null;
  const chrome = has('chrome_') ? 'chrome_' : yourChrome && has('sage_browser_') ? 'sage_browser_' : null;
  const lines = [];
  if (pane) {
    const start = pane === 'browser_' && names.includes('browser_navigate') ? ` (start with ${name('browser_navigate')})` : '';
    const script = names.includes('browser_script') ? `; for many steps, prefer one ${name('browser_script')} call` : '';
    lines.push(
      `- The built-in browser, MoPilot's browser pane that the user sees in this app: the ${family(pane)} tools${start}${script}. Use them when the user means the built-in browser, the browser pane, or a page MoPilot opened.`,
      `- ${paneConfirmNote(`the ${family(pane)} tools`)}`,
    );
  }
  if (names.includes('browser_preview_start') || names.includes('browser_more_tools'))
    lines.push(`- ${previewNote(name('browser_preview_start'))}`);
  if (chrome)
    lines.push(
      `- The user's own Chrome, where they are signed in: the ${family(chrome)} tools${
        chrome === 'chrome_' && names.includes('chrome_tabs_context_mcp') && names.includes('chrome_navigate')
          ? ` (start with ${name('chrome_tabs_context_mcp')}, then ${name('chrome_navigate')})`
          : ''
      }. ${
        userChrome === 'preferred'
          ? 'The user chose Chrome in Settings: use them for web tasks unless the user means the built-in browser.'
          : 'Use them only when the user means their Chrome.'
      }`,
    );
  // Only the IAB host exposes this mark; name no opener or retention tool the session cannot call.
  if (pane === 'browser_' && names.includes('browser_tabs_mark'))
    lines.push(
      `- Tabs these tools open in the built-in browser, including implicit tabs and tabs or windows pages open from temporary tabs, are temporary; unmarked tabs close when your turn ends, except the turn's result tab. Use ${name('browser_tabs_mark')} with status "deliverable" on each tab the user asks to keep for a later message before your turn ends and before promising it will stay open. Do not rely on the result-tab exception or mark unrequested scratch tabs.`,
    );
  if (chrome === 'chrome_')
    lines.push(
      "- Tabs you open in the user's Chrome stay in this chat's group when your turn ends. Explicit close removes a tab; idle, archive or clear releases the group and leaves its tabs open in Chrome.",
    );
  if (pane && chrome) lines.push('- The two browsers share no pages, cookies or sign-ins.');
  // no route to the user's Chrome (#1483): said plainly, so a model doesn't keep retrying a browser it can only look at
  const apps = has('desktop_') || has('computer_');
  if (!chrome && !ownChrome && (pane || apps)) {
    const look = apps
      ? ', and the tools for apps on this Mac can only look at a browser, never click or type in it, whatever the user grants'
      : '';
    lines.push(
      `- The user's own Chrome, where they are signed in: no tool in this chat acts in it${look}. When a task needs their Chrome, tell the user it can't be done from this chat instead of retrying or asking for more access, and that choosing Your Chrome in Settings → Browser (Preferred browser) lets a chat use it.`,
    );
  }
  if (has('desktop_')) {
    const access = names.includes('desktop_request_access') ? `load and call ${name('desktop_request_access')} for the apps first; ` : '';
    const background = has('desktop_app_') ? `the ${family('desktop_app_')} tools work in an app in the background, and ` : '';
    lines.push(
      `- Apps on this Mac: ${access}${background}the other ${family('desktop_')} tools take over the screen for a step that needs the real pointer and keyboard.`,
    );
  } else if (has('computer_')) lines.push(`- Apps on this Mac: the ${family('computer_')} tools.`);
  if (!lines.length) return null;
  if (pane || chrome)
    lines.push(
      "- Granting an app access to the user's account (an OAuth Allow or Authorize, an app installation) is the user's decision: the browser tools ask them on a card naming the app, in every permission mode. Take the step only when the user asked for that access, and let the card ask.",
    );
  const signin = pane === 'browser_' && names.includes('browser_request_signin');
  lines.push(
    `- ${botCheckNote(signin ? `Hand the tab to the user with ${name('browser_request_signin')} (reason "Complete the CAPTCHA") and end your turn; read the page again when the user is done; in another browser or app, ask the user in chat to complete it.` : 'Ask the user in chat to complete it, then continue.')}`,
  );
  return `MoPilot's computer and browser tools:\n${lines.join('\n')}\nA tool that refuses says why and what the user can do; don't work around a refusal.`;
}

/**
 * The tools a session may use now: `visible()`, every session's, less what the session's own rule `hide` hides; none
 * when the list can't be read.
 * @param {(chatId?: string | null) => unknown[] | null} visible `chatId`: the chat the session serves, whose owner Host may lack some surfaces (./hostScope.cjs)
 * @param {((name: string) => boolean) | null | undefined} hide
 * @param {string | null} [chatId]
 * @returns {string[]}
 */
function shownTools(visible, hide, chatId = null) {
  let names = [];
  try {
    names = visible(chatId) || [];
  } catch (error) {
    // no tool list: describe none
    noteIgnored('list the tools a session is shown, for its instructions', error);
  }
  return /** @type {string[]} */ (names.filter((n) => typeof n === 'string' && !(typeof hide === 'function' && hide(n) === true)));
}

/**
 * The note for a session shown every tool the Registry lists now (an ACP session), with the browser channel `control`
 * says, and the note on starting other sessions when start_session is among them (sessionsNote.cjs): null without a
 * Registry.
 * @param {{ list: () => { name: string }[] } | null | undefined} registry
 * @param {{ drivesUserChrome: () => boolean, userChrome?: () => boolean | 'preferred' } | null | undefined} control
 */
function registryNote(registry, control) {
  if (!registry) return null;
  const names = registry.list().map((t) => t.name);
  return withSessionsNote(surfaceNote(names, { yourChrome: userChromeOf(control) }), names);
}

/**
 * The user's Chrome as the note says it, from the browser channel's control (BrowserControl.userChrome); a control
 * without that reader says only whether sage_browser_* drive Chrome, and none says false.
 * @param {{ drivesUserChrome: () => boolean, userChrome?: () => boolean | 'preferred' } | null | undefined} control
 * @returns {boolean | 'preferred'}
 */
function userChromeOf(control) {
  return control?.userChrome?.() ?? !!control?.drivesUserChrome();
}

module.exports = {
  surfaceNote,
  registryNote,
  userChromeOf,
  shownTools,
  claudeNames,
  paneConfirmNote,
  botCheckNote,
  previewNote,
  REGISTRY_NAMES,
};
