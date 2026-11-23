// Per-action browser consent: shared risk checks, task-scope serialization, cancellation and post-answer ownership checks,
// and the cards a tainted turn adds (G3: contract/taintLedger.cjs), Full access included.
const { riskNote, fullAccessCovers } = require('./siteRisk.cjs');
const { prefixUnits } = require('../../../shared/textPrefix.mjs');
const { messageOf, noteIgnored } = require('../../ignored.cjs');
const { originOf, shown, riskView } = require('./originPolicy.cjs');
const { codedError, abortedBefore, unasked } = require('./originErrors.cjs');
const { commitsWhy } = require('./errandGrants.cjs');

/** @typedef {{ kind: 'submit' | 'script' | 'upload' | 'navigate', to?: string }} TaintAction what an action is to a tainted turn */

/** What a card says a tainted turn's action would do, when no sensitive kind names it. */
const TAINT_VERBS = {
  submit: 'submit a form',
  script: 'run JavaScript on the page',
  upload: 'upload files',
  navigate: 'open an address carrying data from another site',
};

/**
 * The card a tainted turn needs for this action, or null: any sensitive action, else a submit, page JavaScript or a
 * navigation as the ledger judges it. A ledger that can't be read asks (not screened is never clean).
 * @param {any} grants @param {string} chatId @param {string} url
 * @param {{ kind?: string, to?: string, form?: { action: string, submit: string } } | null} sensitive @param {TaintAction | null} taint
 * @returns {{ quote: string, why: string } | null}
 */
function taintCard(grants, chatId, url, sensitive, taint) {
  // grants with no ledger wired (no Registry) have no taint to judge by
  if ((!sensitive && !taint) || typeof grants.taint !== 'function') return null;
  try {
    const ledger = grants.taint();
    if (!ledger) return null;
    return ledger.check(chatId, sensitive ? { kind: 'sensitive' } : { kind: taint?.kind, page: url, to: taint?.to || '' });
  } catch (error) {
    return {
      quote: '',
      why: `MoPilot couldn't tell whether this turn read instructions aimed at the agent (${prefixUnits(messageOf(error), 80)})`,
    };
  }
}

/**
 * @param {any} grants @param {string} url
 * @param {{ chatId: string, segmentId: string, signal?: AbortSignal | null }} ctx
 * @param {{ tool?: string, summary?: string, sensitive?: { kind?: string, verb?: string, to?: string, form?: { action: string, submit: string } } | null, ordinary?: boolean, script?: boolean, message?: { declared?: unknown, text?: unknown } | null, taint?: TaintAction | null }} [what]
 *   `script`: page JavaScript (hostTools.cjs confirmed), which a site's saved allowance covers as it does an ordinary action;
 *   `message`: for a send, the agent's declared message_kind and the text it typed (errandGrants.cjs decides what is ordinary);
 *   `taint`: what the action is to a tainted turn (a submit, page JavaScript, an upload, a navigation)
 * @returns {Promise<boolean>}
 */
async function confirmBrowserAction(
  grants,
  url,
  { chatId, segmentId, signal = null },
  { tool = 'act', summary = '', sensitive = null, ordinary = false, script = false, message = null, taint = null } = {},
) {
  const risk = grants.risk.classify(url);
  if (risk.level === 'blocked') throw codedError('blocked', `${riskNote(risk)} ${shown(url)}`);
  const outside = grants.externalBlock(url);
  if (outside) throw codedError('blocked', `${outside} ${shown(url)}`);
  const anchor = grants.anchor({ chatId, segmentId });
  if (anchor === 'readOnly') throw codedError('read_only', 'This chat is in a read-only mode: browser control can only look.');
  const high = risk.level === 'high';
  const origin = originOf(url) || shown(url);
  const tainted = taintCard(grants, chatId, url, sensitive, taint);
  // payment details already allowed for this form this turn: its other fields and one submit go without a card (#4093)
  if (!high && !tainted && sensitive?.form && grants.payForms.covers(chatId, segmentId, origin, sensitive)) return false;
  if (!high && !tainted && (!sensitive || (anchor === 'full' && fullAccessCovers(sensitive)))) return false;
  if (tainted) {
    // the card quotes what the turn read: the user decides with the injection in view
    sensitive ??= { kind: 'tainted', verb: TAINT_VERBS[/** @type {TaintAction} */ (taint).kind] };
    summary = `${prefixUnits(String(summary), 120)} · ${tainted.why}${tainted.quote ? `: ${tainted.quote}` : ''}`;
  }
  // a message on an ordinary site: one the user allowed for this errand goes without a card, unless main finds it commits
  // them; never in a tainted turn, whose card neither skips nor offers the errand (an injection could be what asks for it)
  const send = !high && !tainted && sensitive?.kind === 'send_message';
  const commits = send ? commitsWhy(message ?? {}) : null;
  if (send && !commits && grants.errands.has(chatId, origin)) return false;
  // a high-risk site whose ordinary actions the user allowed for good (#5464): no card; a sensitive action and a tainted turn
  // still ask, and only that card can offer it (an injection could be what asks)
  // only an action a caller read as ordinary (taskCovers) or page JavaScript: a committing control (Confirm, Continue) asks
  const always =
    high &&
    (ordinary === true || script === true) &&
    !risk.credentials &&
    !sensitive &&
    !tainted &&
    originOf(url) === origin &&
    grants.usesSaved(chatId);
  // it holds only while the turn reads clean: an action no caller described for the ledger counts as sensitive, and a call
  // that waited its turn looks again (the turn may have read an injection meanwhile)
  const saved = () =>
    always && grants.actionsAllowed(chatId, origin) && !taintCard(grants, chatId, url, taint ? null : { kind: 'undescribed' }, taint);
  if (saved()) return false;
  const task = high && !!risk.financial && !sensitive && ordinary === true && grants.tasks.scope(chatId, segmentId); // a caller-read ordinary action (taskCovers)
  // an ordinary action on a financial site the user allowed for this task: no card until the turn ends
  if (signal?.aborted) throw abortedBefore(origin);
  if (task && grants.tasks.has(chatId, segmentId, origin)) return true;
  const confirm = async () => {
    if (signal?.aborted || (task && !grants.tasks.current(chatId, task))) throw abortedBefore(origin);
    if (grants.anchor({ chatId, segmentId }) === 'readOnly')
      throw codedError('read_only', 'This chat is in a read-only mode: browser control can only look.');
    if (task && grants.tasks.has(chatId, segmentId, origin)) return true;
    if (saved()) return true; // allowed for good while this call waited its turn
    const what = sensitive ? `This action (${sensitive.verb})` : `Actions on ${origin}`;
    const confirmAction = grants.confirmAction;
    if (!confirmAction)
      throw codedError('disabled', `${what} need${sensitive ? 's' : ''} the user's confirmation, which this chat can't ask for.`);
    grants.nobodyHere({ chatId, segmentId }, `the confirmation of ${what.toLowerCase()}`);
    const ok = await Promise.resolve()
      .then(() =>
        confirmAction({
          chatId,
          segmentId,
          browser: grants.browser,
          origin,
          tool,
          summary: prefixUnits(String(summary), 300),
          sensitive,
          ...(taint?.to
            ? { actionTarget: { url: taint.to, page: url, label: shown(taint.to) } }
            : sensitive?.to
              ? { actionTarget: { url: sensitive.to, page: url, label: shown(sensitive.to) } } // where the form posts or the link goes
              : {}),
          ...(high ? { risk: riskView(risk) } : {}),
          task: !!task, // an ordinary action may be allowed for the rest of the task; anything else once
          ...(always ? { always: true } : {}), // a high-risk site's ordinary actions may be allowed for good
          ...(send ? (commits ? { commits } : { errand: true }) : {}), // an ordinary message may be allowed for the errand
          signal,
        }),
      )
      .catch(unasked(origin));
    // the call was aborted while the card was up: the card went with it, and that is not the user's no
    if (signal?.aborted || (task && !grants.tasks.current(chatId, task))) throw abortedBefore(origin);
    if (ok !== true && ok !== 'task' && ok !== 'errand' && ok !== 'always')
      throw codedError(
        'denied',
        `The user did not allow this action${sensitive ? ` (${sensitive.verb})` : ''} on ${origin}.${high ? ` ${riskNote(risk)}` : ''}`,
      );
    if (grants.anchor({ chatId, segmentId }) === 'readOnly')
      throw codedError('read_only', 'This chat is in a read-only mode: browser control can only look.');
    if (ok === 'task' && task) grants.tasks.add(chatId, segmentId, origin, task);
    // a yes that couldn't be saved still allows this action; the next one asks again
    if (ok === 'always' && always) {
      try {
        grants.allowActions(origin);
      } catch (error) {
        noteIgnored('save a site whose actions the user always allows', error);
      }
    }
    if (ok === true || ok === 'task') grants.payForms.add(chatId, segmentId, origin, sensitive);
    if (ok === 'errand' && send && !commits) grants.errands.add(chatId, origin);
    return true;
  };
  return task ? grants.tasks.ask(task, origin, confirm) : confirm();
}
module.exports = { confirmBrowserAction, taintCard, TAINT_VERBS };
