// What a Your Chrome action targets, read from the page through Playwright MCP's browser_evaluate, so its writes get the in-app browser's checks (password fields, bot checks, OAuth consent, submit keys, form fills, payment entries, dialog accepts).
//
// The in-app browser asks its page agent what an action acts on (pageAgent.cjs intent) and siteRisk.cjs
// sensitiveAction() names a sensitive action from it. In the user's Chrome the page agent isn't there, so
// the same facts (the element's name, whether it is a password or payment field, the form a submit would
// send) are read by a small function run in the page. When the page can't be read, a click still falls
// back to the element description the agent wrote, as before.
const { contentBlocks } = require('../../../shared/contentBlocks.mjs');
const { needsIntent, sensitiveAction, sensitiveByName, typesText, UNREADABLE_FRAME } = require('./siteRisk.cjs');
const { submitTaint } = require('./submitTaint.cjs');
const { mayAct } = require('../contract/actionGuard.cjs');
const { botCheckIn, botCheckRefusal, HANDOFF } = require('./botCheck.cjs');
const { CONSENT_SOURCE } = require('./consent.cjs');
const { labelText } = require('../../../shared/labelText.mjs');

/** What reads an element's intent in the page; the same facts as pageAgent.cjs intent(), marked so its answer is found in the result. */
const INTENT_OF = `(hit) => {
  const botCheck = (${botCheckIn.toString()});
  const consent = (${CONSENT_SOURCE});
  const joinLabels = (${labelText.toString()});
  const clean = (s) => String(s == null ? '' : s).replace(/\\s+/g, ' ').trim();
  if (!hit || hit.nodeType !== 1) return { mopilot_intent: true, none: true };
  let el = hit.closest('button, a[href], input, select, textarea, [role="button"], [role="link"], [role="menuitem"], label') || hit;
  if (el.localName === 'label' && el.control) el = el.control;
  const attr = (e, k) => e.getAttribute(k) || '';
  const nameOf = (e) => clean(attr(e, 'aria-label') || (e.labels ? joinLabels([...e.labels].map((l) => l.innerText || l.textContent)) : '') || attr(e, 'title') || (e.localName === 'input' && /^(submit|button|reset)$/i.test(attr(e, 'type')) ? e.value : '') || attr(e, 'placeholder') || e.textContent || attr(e, 'name')).slice(0, 120);
  const passwordLike = (e) => {
    if (!e || e.localName !== 'input') return false;
    const type = (attr(e, 'type') || 'text').toLowerCase();
    if (type === 'password' || /\\b(current|new)-password\\b/i.test(attr(e, 'autocomplete'))) return true;
    return type === 'text' && /pass(word|wd)|\\bpwd\\b/i.test(attr(e, 'name') + ' ' + (e.id || ''));
  };
  const payment = (e) => {
    if (!e || !/^(input|select)$/.test(e.localName)) return false;
    if (/\\bcc-(number|csc|exp|exp-month|exp-year)\\b/i.test(attr(e, 'autocomplete'))) return true;
    return /card.?num|cc.?num|\\bcvv|\\bcvc|\\bcsc\\b|security.?code|\\biban\\b|routing|account.?num|sort.?code/i.test(attr(e, 'name') + ' ' + (e.id || '') + ' ' + attr(e, 'aria-label') + ' ' + attr(e, 'placeholder'));
  };
  const paymentFrame = (f) => /card.?(num|number|payment|input|field|form)|credit.?card|\\bcvc\\b|\\bcvv\\b|security.?code|hosted.?field|privatestripeframe|checkout-frames/i.test(attr(f, 'name') + ' ' + (f.id || '') + ' ' + attr(f, 'title'));
  const tag = el.localName;
  const type = attr(el, 'type').toLowerCase();
  const role = attr(el, 'role') || (tag === 'button' || (tag === 'input' && /^(submit|button|reset|image)$/.test(type)) ? 'button' : tag === 'a' ? 'link' : '');
  const editable = !el.disabled && !el.readOnly && (tag === 'textarea' || (tag === 'input' && !/^(button|checkbox|color|file|hidden|image|radio|range|reset|submit)$/.test(type || 'text')) || !!el.isContentEditable);
  const submitsForm = (b) => (b.localName === 'button' || b.localName === 'input') && (b.type === 'submit' || b.type === 'image');
  const submits = !!el.form && submitsForm(el);
  const button = role === 'button' || role === 'link' || role === 'menuitem';
  const paymentNear = (e) => {
    for (let box = e.parentElement, i = 0; box && i < 6 && !/^(body|html)$/.test(box.localName); i++, box = box.parentElement)
      if ([...box.querySelectorAll('iframe, frame')].slice(0, 50).some(paymentFrame)) return true;
    return false;
  };
  const formOf = (e) => {
    const form = e.form || e.closest('form');
    if (!form) return null;
    const fields = [...form.querySelectorAll('input, select, textarea')].slice(0, 200);
    const sub = submitsForm(e) ? e : [...e.getRootNode().querySelectorAll('button, input')].find((b) => b.form === form && submitsForm(b));
    // this runs in the page's own world, which can remove the getter: that must not cost the rest of the reading, nor read as
    // "posts to this page", which would raise no card in a tainted turn; a destination nobody can reach makes the card ask
    const posts = () => {
      try {
        return Object.getOwnPropertyDescriptor(e.ownerDocument.defaultView.HTMLFormElement.prototype, 'action').get.call(form);
      } catch {
        return 'https://unreadable.invalid/';
      }
    };
    return {
      secrets: fields.filter(passwordLike).length,
      newPassword: fields.some((f) => /\\bnew-password\\b/i.test(attr(f, 'autocomplete'))),
      payment: fields.some(payment) || [...form.querySelectorAll('iframe, frame')].slice(0, 50).some(paymentFrame),
      submit: sub ? nameOf(sub) : '',
      action: sub?.hasAttribute('formaction') ? sub.formAction : posts(),
    };
  };
  const name = nameOf(el);
  return {
    mopilot_intent: true,
    tag,
    type,
    role,
    name,
    botCheck: botCheck(hit, el, name),
    consent: button ? consent(hit, el, name) : null,
    button,
    submits,
    editable,
    secret: passwordLike(el),
    payment: payment(el),
    form: submits || editable || (button && !!(el.form || el.closest('form'))) ? formOf(el) : button && paymentNear(el) ? { secrets: 0, newPassword: false, payment: true, submit: '' } : null,
  };
}`;

/** The function browser_evaluate runs for the element a ref names. */
const ELEMENT_INTENT = `(el) => (${INTENT_OF})(el)`;
/**
 * The function browser_evaluate runs for the focused element (a key press): through open shadow roots and same-origin
 * frames; focus in a cross-origin frame answers `frame` (with `botCheck` for a CAPTCHA provider's frame), and the element
 * is then read in that frame (focusedInFrame).
 */
const FOCUS_INTENT = `() => { let el = document.activeElement; for (;;) { while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement; if (!el || !/^i?frame$/.test(el.localName)) break; let doc = null; try { doc = el.contentDocument; } catch {} if (!doc) return { mopilot_intent: true, frame: true, botCheck: (${botCheckIn.toString()})(el, el, '') }; el = doc.activeElement; } return (${INTENT_OF})(el); }`;

/**
 * The ref of the focused element inside a frame, from the snapshot Playwright took just before: it marks the focused
 * element of each frame's document `[active]`, the frame element too, so the innermost one that is no frame is it.
 */
function focusedInFrame(snapshotText) {
  const lines = String(snapshotText || '')
    .split('\n')
    .filter((l) => /\[active\]/.test(l) && !/^\s*- iframe\b/.test(l));
  const ref = /\[ref=([^\]\s]+)\]/.exec(lines.at(-1) ?? '')?.[1];
  return ref || null;
}

/** The text blocks of a Playwright MCP result. */
const textOf = (content) =>
  contentBlocks(content)
    .filter((c) => c.type === 'text')
    .map((c) => c.text || '')
    .join('\n');

/** The intent an evaluate result carries (JSON.stringify(…, null, 2) of INTENT_OF's answer), or null. */
function parsedIntent(text) {
  const at = text.indexOf('{\n  "mopilot_intent": true');
  if (at < 0) return null;
  const end = text.indexOf('\n}', at);
  if (end < 0) return null;
  try {
    const out = JSON.parse(text.slice(at, end + 2));
    return out.none ? null : out;
  } catch {
    return null;
  }
}

/**
 * What the action would act on: the element `target` names, or the focused one (inside a cross-origin frame, the one
 * the snapshot marks active there; UNREADABLE_FRAME when none is); null when it can't be read.
 * @param {{ call: (name: string, args: any) => Promise<{ content?: any, isError?: boolean }> }} inst
 * @param {string | undefined} target
 * @param {string} [snapshotText] the page snapshot taken just before
 */
async function readIntent(inst, target, snapshotText = '') {
  try {
    const evaluate = async (/** @type {string | undefined} */ ref) => {
      const r = await inst.call(
        'browser_evaluate',
        ref ? { function: ELEMENT_INTENT, target: ref, element: 'the element the action targets' } : { function: FOCUS_INTENT },
      );
      return r.isError ? null : parsedIntent(textOf(r.content));
    };
    const intent = await evaluate(target);
    if (!intent?.frame) return intent;
    // the focus is in a cross-origin frame (CM-J08): read the element there, by the ref Playwright gave it; a bot check's
    // frame stays one whatever is read inside it (botCheck.cjs)
    const inFrame = focusedInFrame(snapshotText);
    const inside = (inFrame && (await evaluate(inFrame))) || UNREADABLE_FRAME;
    return intent.botCheck ? { ...inside, botCheck: true } : inside;
  } catch (error) {
    // a stopped call stops here (PlaywrightInstance.call refuses it); otherwise the page can't be read now and the
    // caller falls back to what the agent said about the element
    if (!mayAct()) throw error;
    return null;
  }
}

/**
 * The message of the dialog Playwright's modal state names (`["confirm" dialog with message "…"]`), or ''. Playwright
 * doesn't escape the message, so it runs to the closing `"]`.
 */
function dialogMessage(snapshotText) {
  return /dialog with message "([\s\S]*?)"\]/.exec(String(snapshotText || ''))?.[1] ?? '';
}

/** The page address a Playwright snapshot names ("- Page URL: …"), or ''. */
const pageUrl = (/** @type {string} */ snapshotText) => /Page URL: (\S+)/.exec(String(snapshotText || ''))?.[1] ?? '';

/**
 * The actions a Playwright write tool performs, in siteRisk.sensitiveAction()'s terms.
 * @param {string} name the Playwright tool
 * @param {any} args its arguments
 * @param {string} snapshotText the page snapshot taken just before (it names an open dialog)
 * @returns {Array<{ kind: string, target?: string, keys?: string, accept?: boolean, message?: string }>}
 */
function actionsOf(name, args, snapshotText) {
  const a = args && typeof args === 'object' ? args : {};
  const target = typeof a.target === 'string' ? a.target : typeof a.ref === 'string' ? a.ref : undefined;
  switch (name) {
    case 'browser_click':
      return [{ kind: 'click', target }];
    case 'browser_type':
      return a.submit
        ? [
            { kind: 'type', target },
            { kind: 'key', keys: 'Enter', target },
          ]
        : [{ kind: 'type', target }];
    case 'browser_press_key':
      return [{ kind: 'key', keys: String(a.key ?? '') }];
    case 'browser_fill_form':
      return (Array.isArray(a.fields) ? a.fields : []).map((f) => ({
        kind: 'fill',
        target: typeof f?.target === 'string' ? f.target : typeof f?.ref === 'string' ? f.ref : undefined,
      }));
    case 'browser_handle_dialog':
      return [{ kind: 'dialog', accept: !!a.accept, message: dialogMessage(snapshotText) }];
    default:
      return [];
  }
}

/**
 * The in-app browser's checks for a write in the user's Chrome: whether it types into a password field, the refusal
 * when it acts on a bot check (botCheck.cjs), and the sensitive action it is (the first one, for a tool that does
 * several), or null.
 * @param {{ call: (name: string, args: any) => Promise<{ content?: any, isError?: boolean }> }} inst
 * @param {string} name the Playwright tool
 * @param {any} args its arguments
 * @param {string} snapshotText the page snapshot taken just before
 * @returns {Promise<{ password: boolean, botCheck?: Error | null, sensitive: { kind: string, verb: string, detail: string } | null, taint?: import('./originAction.cjs').TaintAction | null }>}
 */
async function chromeActionCheck(inst, name, args, snapshotText) {
  const element = typeof args?.element === 'string' ? args.element : '';
  /** @type {{ kind: string, verb: string, detail: string } | null} */
  let sensitive = null;
  /** @type {import('./originAction.cjs').TaintAction | null} a submit, which a tainted turn asks for (G3) */
  let taint = null;
  for (const action of actionsOf(name, args, snapshotText)) {
    const intent = needsIntent(action) ? await readIntent(inst, action.target, snapshotText) : null;
    if (intent?.secret && typesText(action)) return { password: true, sensitive: null };
    const botCheck = botCheckRefusal(intent, action, HANDOFF.chrome);
    if (botCheck) return { password: false, botCheck, sensitive: null };
    // a click is also judged by the name the agent gave the element, as before (the page may not be readable); a grant
    // name on a consent page address only when the page could not say whether it is one
    const url = intent && 'consent' in intent ? '' : pageUrl(snapshotText);
    sensitive ??= sensitiveAction(intent, action) || (action.kind === 'click' ? sensitiveByName(element, url) : null);
    taint ??= submitTaint(intent, action);
  }
  return { password: false, sensitive, taint };
}

module.exports = {
  chromeActionCheck,
  actionsOf,
  dialogMessage,
  focusedInFrame,
  parsedIntent,
  readIntent,
  ELEMENT_INTENT,
  FOCUS_INTENT,
  textOf,
};
