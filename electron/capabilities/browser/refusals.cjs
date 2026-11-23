// Structured refusals for the browser_* tools: a stable reason, whether retrying can help and what to do next, on every security refusal.
//
// A refusal keeps its ToolError code (callers and the operation log match on it); the model also gets
// a <refusal> block it can act on. A refusal that retrying cannot change also forbids working around it.
// A refusal about the user's own Chrome, or from the Codex Browser plugin's backend, names its browser
// (browser="chrome" / "iab"), so the chat's ways-forward strip acts on the right browser's site table.
const { ownTable } = require('../../../shared/ownTable.mjs');
const { ToolError } = require('../contract/registry.cjs');

const NO_WORKAROUND = 'Do not try to achieve the same outcome through other tools, raw CDP, scripts, another browser or any workaround.';

/**
 * code -> [message test, reason, retryable, next], the first match wins; a code without a match is
 * not a refusal (a bad argument, a timeout) and stays as it is.
 * @type {Record<string, Array<[RegExp, string, boolean, string]>>}
 */
const RULES = ownTable({
  blocked: [
    // Codex Browser Use blocks, in every chat (codexBrowserUse.cjs browseBlock, #1319 G13): the message says where each is set
    [
      /blocked this site in Codex Browser Use/,
      'codex_site_blocked',
      false,
      'Tell the user they blocked this site in Codex Browser Use, which applies in every chat; only they can remove the block (Settings → Browser → Sites). Continue without the site.',
    ],
    [
      /Codex (?:Browser Use )?policy/,
      'codex_policy_blocked',
      false,
      'Tell the user a Codex Browser Use policy blocks this site in every chat, and where it is set (the message says), then continue without it.',
    ],
    [/./, 'site_blocked', false, 'Tell the user this site is blocked for browser control and continue without it.'],
  ],
  // Your Chrome without its extension (vendorErrors.mjs chromeExtensionMissing, #1319 G21)
  not_installed: [
    [
      /./,
      'chrome_not_set_up',
      false,
      "Tell the user Your Chrome needs the Playwright Extension (Settings → Browser, Get the extension), or do the task in the built-in browser with its own tools if it doesn't need the user's Chrome.",
    ],
  ],
  denied: [
    [
      /did not allow this action \(/,
      'sensitive_action_declined',
      false,
      'Tell the user the action was not done and ask in chat how they want to continue.',
    ],
    [/did not allow this action/, 'action_declined', false, 'Ask the user in chat how they want to continue.'],
    [/didn't sign in/, 'signin_cancelled', false, 'Ask the user in chat how they want to continue.'],
    [/did not allow this\./, 'user_declined', false, 'Ask the user in chat whether and how to continue.'],
    [/did not allow/, 'site_permission_denied', false, 'Ask the user in chat to allow this site, or continue with sites they allowed.'],
  ],
  read_only: [
    [/read-only mode/, 'chat_read_only', false, 'Only read pages; ask the user in chat to change the chat to a mode that allows actions.'],
    [
      /./,
      'site_read_only',
      false,
      'Ask the user in chat to allow read and write for this site (also in Settings → Browser), then try again.',
    ],
  ],
  password_field: [
    [/in their Chrome/, 'password_field', false, 'Ask the user in chat to sign in themselves in their Chrome, then continue.'],
    [
      /./,
      'password_field',
      false,
      'Call browser_request_credentials so MoPilot fills the login without you seeing it, or browser_request_signin so the user signs in themselves.',
    ],
  ],
  // a bot check or CAPTCHA (botCheck.cjs, #1615): only the user completes it
  bot_check: [
    [/in their Chrome/, 'bot_check', false, 'Ask the user in chat to complete the check in their Chrome, then continue.'],
    [/browser pane/, 'bot_check', false, 'Ask the user to complete the check in the browser pane, then continue.'],
    [/./, 'bot_check', false, 'Call browser_request_signin so the user completes the check themselves, then read the page again.'],
  ],
  wrong_browser: [
    [/in their Chrome/, 'credentials_unavailable', false, 'Ask the user in chat to sign in themselves in their Chrome, then continue.'],
    [/./, 'credentials_unavailable', false, 'Call browser_request_signin so the user signs in themselves.'],
  ],
  disabled: [
    [/confirmation/, 'confirmation_unavailable', false, 'Tell the user this needs their confirmation in a chat that can ask for it.'],
    [/(?:JavaScript|File upload) is turned off/, 'tool_disabled', false, 'Tell the user what you would need this tool for.'],
    [
      /./,
      'browser_control_disabled',
      false,
      'Tell the user browser control is off or paused in MoPilot right now; offer their other browser (Settings → Browser) or doing the step themselves.',
    ],
  ],
  bad_url: [[/Only http and https/, 'scheme_blocked', false, 'Open an http or https address instead.']],
  bad_args: [
    [
      /Only files inside .* can be uploaded/,
      'upload_outside_folder',
      // retryable, like tab_limit: once the file is in the folder the upload works, so it is no "workaround" (#1570, #1381)
      true,
      "Save or copy the file into this chat's upload folder (see browser_tabs_context), then upload it from there. Copy only a file you made for this task or one the user asked you to upload; ask the user about any other file.",
    ],
  ],
  limit: [[/tabs\. Close one/, 'tab_limit', true, 'Close a tab you no longer need with browser_tabs_close, then try again.']],
  unavailable: [
    [
      /^Couldn't ask the user/,
      'consent_unavailable',
      true,
      'Try the same call once more; if it fails again, tell the user the approval card could not be shown. Do not do it another way.',
    ],
  ],
  taken_over: [[/./, 'user_took_over', false, 'Tell the user what is left to do, or use another tab.']],
  signin_pending: [[/./, 'signin_pending', true, "Use another tab, or end your turn: the user's reply continues the chat."]],
});

/** @typedef {InstanceType<typeof ToolError> & { reason?: string, retryable?: boolean, next?: string, refusal?: boolean, browser?: 'iab' | 'chrome' }} Refusal */

/**
 * The refusal an error is, or null: { reason, retryable, next }.
 * @param {any} e
 */
function refusalOf(e) {
  if (!(e instanceof ToolError)) return null;
  /** @type {Refusal} */
  const err = e;
  if (err.reason) return { reason: err.reason, retryable: !!err.retryable, next: err.next || '' };
  const rule = (RULES[err.code] || []).find(([re]) => re.test(err.message));
  return rule ? { reason: rule[1], retryable: rule[2], next: rule[3] } : null;
}

/**
 * Gives a refusal its reason, retryable flag and next step, as fields and in its message (once).
 * Returns the same error; anything that is not a refusal comes back unchanged. `browser`: the browser the
 * refusal is about, when it is not the in-app browser's browser_* tools ('chrome', or 'iab' for the plugin's backend).
 * @param {any} e
 * @param {'iab' | 'chrome' | null} [browser]
 */
function explainRefusal(e, browser = null) {
  const r = refusalOf(e);
  if (!r || e.refusal) return e;
  e.reason = r.reason;
  e.retryable = r.retryable;
  e.next = r.next;
  e.refusal = true;
  if (browser) e.browser = browser;
  e.message = `${e.message}\n<refusal reason="${r.reason}" retryable="${r.retryable}"${browser ? ` browser="${browser}"` : ''}>\nnext: ${r.next}${r.retryable ? '' : `\n${NO_WORKAROUND}`}\n</refusal>`;
  return e;
}

/** `p`, with a refusal it rejects with explained (about `browser`, when it says one). */
const explained = (p, /** @type {'iab' | 'chrome' | null} */ browser = null) =>
  Promise.resolve(p).catch((e) => {
    throw explainRefusal(e, browser);
  });

module.exports = { explainRefusal, explained, refusalOf, NO_WORKAROUND };
