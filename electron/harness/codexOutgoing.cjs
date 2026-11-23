// Prepares Codex requests with provider, trust and tool settings, keeping live checks at the native write boundary.
const { withProvider } = require('../identity/contract/codexProvider.cjs');
const { withRelay } = require('../identity/contract/threadRelay.cjs');
const { assertInputCurrent, hasSendGuard } = require('../session/contract/inputGuard.cjs');
const { withTrust } = require('./codexTrust.cjs');

const THREAD_OPENS = new Set(['thread/start', 'thread/resume', 'thread/fork']);

/** Main-only checks for requests that can wait in a credential lane or for a binary lookup. @type {WeakMap<object, { check: () => boolean, background: boolean }>} */
const dispatchChecks = new WeakMap();

/** @typedef {{ validate: (result: any) => void, active: () => boolean }} CodexForkReceipt */
/** @typedef {CodexForkReceipt & { refuse: (error: unknown) => void }} ForkAnswer */
/** A trusted fork's reply must pass validation before a lane or tool session takes ownership. @type {WeakMap<object, ForkAnswer>} */
const forkAnswers = new WeakMap();

/** @param {InstanceType<typeof import('./codex.cjs').CodexAdapter>} adapter
 * @param {{ id: string, method: string, params: any }} request
 * @param {boolean} helper @param {(error: unknown) => void} refuse @param {CodexForkReceipt} [fork] */
function outgoingRequest(adapter, request, helper, refuse, fork) {
  const { id, method, params } = request;
  const guarded = (method === 'thread/fork' || method === 'thread/delete') && hasSendGuard(params);
  if (guarded) assertInputCurrent(params);
  let msg = request;
  // Each opened thread uses the account relay and the current model provider, including resumed and forked threads.
  if (THREAD_OPENS.has(method))
    msg = { ...msg, params: withProvider(withRelay(params, adapter.server.threadConfig), adapter.provider(), adapter.keptProviders()) };
  if (method === 'thread/start') msg = { ...msg, params: withTrust(msg.params, adapter.userTrust) };
  const outgoing = adapter.tools ? adapter.tools.outgoing(msg, { helper }) : msg;
  if (fork) forkAnswers.set(outgoing, { ...fork, refuse });
  if (guarded)
    dispatchChecks.set(outgoing, {
      background: method === 'thread/delete',
      check() {
        try {
          assertInputCurrent(params);
          return true;
        } catch (error) {
          refuse(error);
          adapter.tools?.observe({ id, error });
          return false;
        }
      },
    });
  return outgoing;
}

/** @param {Map<string, ForkAnswer>} pending @param {Record<string, any>} msg */
function acceptAnswer(pending, msg) {
  const entry = !msg.method && pending.get(msg.id);
  if (!entry) return msg;
  pending.delete(msg.id);
  if (msg.error) return msg;
  try {
    entry.validate(msg.result);
    return msg;
  } catch (error) {
    entry.refuse(error);
    return { id: msg.id, error: { code: -1, message: 'Codex returned an invalid fork.' } };
  }
}

module.exports = { outgoingRequest, THREAD_OPENS, dispatchChecks, forkAnswers, acceptAnswer };
