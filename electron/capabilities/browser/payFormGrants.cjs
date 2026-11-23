// One confirmation per payment form (#4093): the user's yes to entering payment details into a form covers the form's other payment
// fields and one submit of it, in that turn and segment on that site. The submit uses the allowance up, so a later payment asks
// again, and so does a form whose destination or submit button differs from the one the user saw, another site, turn or segment,
// a tainted turn, a high-risk site and a form nobody could read (originAction.cjs decides when to look here). In memory only.
const { currentToken, tokenLiveness, mayAct } = require('../contract/actionGuard.cjs');

/** The running call's turn, or null outside one (nothing is remembered or used then). */
const turnKey = () => {
  const token = currentToken();
  return token ? JSON.stringify([token.thread, token.turn]) : null;
};

/** The form an allowance names: where it posts and what its button says; null when the destination is unknown (always asks). */
function formKeyOf(/** @type {{ form?: { action: string, submit: string } } | null | undefined} */ sensitive, origin) {
  const form = sensitive?.form;
  return form?.action ? JSON.stringify([origin, form.action, form.submit]) : null;
}

class PayFormGrants {
  constructor() {
    /** @type {Map<string, { segmentId: string, key: string, live: (() => boolean) | null, forms: Set<string> }>} */
    this.byChat = new Map();
  }

  #scope(/** @type {string} */ chatId, /** @type {string} */ segmentId) {
    const s = this.byChat.get(chatId);
    return s && s.segmentId === segmentId && s.key === turnKey() && (!s.live || s.live()) ? s : null;
  }

  /** Whether the user already allowed this form (an entry or the submit); a submit uses the allowance up. */
  covers(chatId, segmentId, origin, sensitive) {
    // only payment fields and the form's own submit button: a delete, a send or another button in the form still asks
    const entry = sensitive?.kind === 'payment_entry';
    if (!entry && !(sensitive?.kind === 'payment' && sensitive.detail === sensitive.form?.submit)) return false;
    const key = formKeyOf(sensitive, origin);
    if (!key || !mayAct() || !this.#scope(chatId, segmentId)?.forms.has(key)) return false;
    if (!entry) this.#scope(chatId, segmentId)?.forms.delete(key);
    return true;
  }

  /** The user allowed entering payment details into this form (a late answer from a retired turn adds nothing). */
  add(chatId, segmentId, origin, sensitive) {
    const key = formKeyOf(sensitive, origin);
    if (!key || sensitive?.kind !== 'payment_entry' || !mayAct() || !currentToken()) return;
    let s = this.#scope(chatId, segmentId);
    if (!s) this.byChat.set(chatId, (s = { segmentId, key: /** @type {string} */ (turnKey()), live: tokenLiveness(), forms: new Set() }));
    s.forms.add(key);
  }

  clear(/** @type {string} */ chatId) {
    this.byChat.delete(chatId);
  }
}

/**
 * Where an action on an element goes, for its card: `to` (the form it submits, else the link it follows) and, for a form, its
 * `form` identity (the allowance above is keyed by it). Empty for an unread target.
 * @param {any} intent the page agent's report on the element
 */
function targetOf(intent) {
  if (!intent || intent.unreadable) return {};
  const to = intent.form?.action || (typeof intent.href === 'string' ? intent.href : '');
  if (!to) return {};
  return intent.form?.action
    ? { to: String(to), form: { action: String(intent.form.action), submit: String(intent.form.submit ?? '') } }
    : { to: String(to) };
}

module.exports = { PayFormGrants, formKeyOf, targetOf };
