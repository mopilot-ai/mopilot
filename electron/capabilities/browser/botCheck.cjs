// Bot checks and CAPTCHAs, for every browser route (#1615, E-S4b): the in-page test the page agent and the Chrome intent reader share, and the refusal an agent's click, key, typing or drag on one gets.
//
// Claude in Chrome and Claude Desktop's built-in browser never solve a CAPTCHA, and ChatGPT's browser agent hands such a
// page to the user. MoPilot does the same in code, not only in the model's instructions: what an action acts on
// (pageAgent.cjs intent, chromeIntent.cjs INTENT_OF) carries `botCheck` when it is part of a recognized bot check, and
// botCheckRefusal() turns that into a refusal naming the route's hand-off. Recognized are reCAPTCHA, hCaptcha, Cloudflare
// Turnstile, Arkose, DataDome and GeeTest frames and widgets, and a checkbox or button named like "I'm not a robot" or
// "Verify you are human". A form's own submit button that only carries an invisible reCAPTCHA is not one.
const { HANDOFF_CONTINUES } = require('../../../shared/doneContinue.mjs');
const { ToolError } = require('../contract/registry.cjs');

/**
 * Whether the element an action hits is part of a bot check. Runs in the page: it is serialized with
 * Function.prototype.toString into the page agent and the Chrome intent reader, so it must not close over anything.
 * `hit`: the element at the target, or a frame element whose document can't be read; `el`: the control it belongs to
 * (the element itself when it is no control); `name`: that control's accessible name as the caller read it.
 * @param {Element} hit
 * @param {Element} el
 * @param {string} name
 * @returns {boolean}
 */
function botCheckIn(hit, el, name) {
  const PROVIDER =
    /^https?:\/\/(?:[\w-]+\.)*(?:hcaptcha\.com|recaptcha\.net|arkoselabs\.com|funcaptcha\.com|captcha-delivery\.com|geetest\.com)(?:[:/?#]|$)|^https?:\/\/challenges\.cloudflare\.com(?:[:/?#]|$)|^https?:\/\/(?:www\.)?google\.com\/recaptcha\//i;
  const FRAME_TITLE = /\b(?:re)?captcha\b|\bhcaptcha\b|\bturnstile\b|cloudflare security challenge/i;
  const NAME =
    /\bI(?:'|’)?m not a (?:ro)?bot\b|\bI am not a (?:ro)?bot\b|\b(?:verify|confirm|prove) (?:that )?(?:you(?:'|’)?re|you are|I(?:'|’)?m|I am) (?:a )?human\b|^\s*I(?:'|’)?m (?:a )?human\s*[.!]?\s*$|^\s*I am (?:a )?human\s*[.!]?\s*$|\bhuman verification\b/i;
  const WIDGET =
    '.g-recaptcha, .h-captcha, .cf-turnstile, .recaptcha-checkbox, #recaptcha-anchor, .geetest_holder, [data-hcaptcha-widget-id]';
  const CONTROL = 'button, a[href], input, select, textarea, [role="button"], [role="link"]';
  const attr = (/** @type {Element} */ e, /** @type {string} */ k) => e.getAttribute(k) || '';
  // a frame whose document can't be read: its address and title say whose it is
  if (/^i?frame$/.test(el.localName)) return PROVIDER.test(attr(el, 'src')) || FRAME_TITLE.test(attr(el, 'title'));
  // anything inside a provider's own frame (the checkbox, the picture grid, the audio answer field)
  const doc = el.ownerDocument;
  if (PROVIDER.test(String(doc.URL))) return true;
  // a provider's widget in the page; a control that only carries one (an invisible reCAPTCHA on a form's submit) is not
  const widget = hit.closest(WIDGET);
  if (widget && !widget.matches(CONTROL)) return true;
  // a checkbox, switch or button named like a human check, by the caller's name or its own label
  const box = hit.closest('[role="checkbox"], [role="switch"]') || el;
  const type = attr(box, 'type').toLowerCase();
  const role = attr(box, 'role');
  const input = box.localName === 'input';
  const control =
    (input && /^(checkbox|submit|button)$/.test(type)) || box.localName === 'button' || /^(checkbox|switch|button)$/.test(role);
  if (!control) return false;
  const labelled = attr(box, 'aria-labelledby')
    .split(/\s+/)
    .map((id) => (id && doc.getElementById(id)?.textContent) || '');
  const label = /** @type {any} */ (box).labels?.[0]?.textContent;
  return [name, attr(box, 'aria-label'), ...labelled, label, box.textContent].some((s) => NAME.test(String(s || '').slice(0, 300)));
}

/** The hand-off each route names in its refusal. */
const HANDOFF = Object.freeze({
  /** the browser_* tools in the pane */
  pane: `Call browser_request_signin with the reason "Complete the CAPTCHA" so the user completes it themselves. ${HANDOFF_CONTINUES}`,
  /** a browser that drives the user's Chrome, where the pane's hand-off can't reach */
  chrome: 'Ask the user in chat to complete the check themselves in their Chrome, then continue.',
  /** the Codex Browser plugin's iab backend: the thread may have no browser_* tools */
  plugin:
    'Hand the tab to the user with browser_request_signin if you have it, or ask them in chat to complete the check themselves in the browser pane, then continue.',
  /** the older sage_browser_* tools, which have no hand-off tool */
  legacy: 'Ask the user in chat to complete the check themselves in the browser, then continue.',
});

/** What a password field's refusal tells the agent on each route: the user's Chrome has no sign-in tool (refusals.cjs reads "in their Chrome"). */
const SIGN_IN = Object.freeze({
  pane: 'Call browser_request_signin so the user signs in themselves.',
  chrome: 'Ask the user in chat to sign in themselves in their Chrome, then continue.',
});

/** The actions a bot check refuses: anything that clicks, types or presses into it, or drags from it (a slider puzzle). */
const ACTS = new Set(['click', 'type', 'fill', 'key', 'check', 'drag']);

/**
 * The refusal an action on a bot check gets, or null. `intent` is what the page agent reports about the target (null
 * when unknown); `action` is { kind }; `handoff` is the route's next step (HANDOFF). The ToolError's code is
 * `bot_check`, which refusals.cjs explains.
 * @param {{ botCheck?: boolean, name?: string } | null | undefined} intent
 * @param {{ kind: string } | null | undefined} action
 * @param {string} [handoff]
 */
function botCheckRefusal(intent, action, handoff = HANDOFF.pane) {
  if (!intent?.botCheck || !action || !ACTS.has(action.kind)) return null;
  const name = String(intent.name || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return new ToolError(
    `${name ? `"${name}"` : 'This control'} is part of a bot check (a CAPTCHA or "I'm not a robot" check): agents never solve these. ${handoff}`,
    'bot_check',
  );
}

/** Throws botCheckRefusal()'s refusal, if any, for a caller that only stops on it. */
function refuseBotCheck(
  /** @type {Parameters<typeof botCheckRefusal>[0]} */ intent,
  /** @type {Parameters<typeof botCheckRefusal>[1]} */ action,
  /** @type {string} */ handoff,
) {
  const e = botCheckRefusal(intent, action, handoff);
  if (e) throw e;
}

module.exports = { botCheckIn, botCheckRefusal, refuseBotCheck, HANDOFF, SIGN_IN };
