// Whether a browser action submits a form, and where it posts, for G3's tainted turn (#3571: originAction.cjs taintCard).
const { pressesKeys, submitsKeys } = require('./siteRisk.cjs');

/**
 * What submitting a form an action does is, for the turn's taint (contract/taintLedger.cjs): `{ kind: 'submit', to }`
 * (`to`: the form's action address, '' when unknown) for a click on a submit button, Enter or space on one, or Enter in
 * a form's field; else null.
 */
function submitTaint(intent, action) {
  if (!intent || intent.unreadable) return null;
  const key = action.kind === 'key';
  const submits =
    (action.kind === 'click' && !!intent.submits) ||
    (key && !!intent.submits && pressesKeys(action.keys, intent)) ||
    (key && !!intent.editable && !!intent.form && submitsKeys(action.keys));
  return submits ? { kind: /** @type {'submit'} */ ('submit'), to: String(intent.form?.action || '') } : null;
}

module.exports = { submitTaint };
