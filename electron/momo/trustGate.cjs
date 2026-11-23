// MoMo's trust gate (#2139): the one way a MoMo tool runs a call. Intents a quit left open are settled as uncertain before the first side effect; a side effect is refused before any card when the audit log can't be written. The sentinel decides; a refusal is audited and answered with its text; a change, or anything that sends data out, is audited as an intent on the disk before it runs and as an outcome after (done / not sent / uncertain), and is never retried here. An action names its receipt and failure detail by key (trustTexts.cjs); a result whose outcome couldn't be recorded says so. A read that sends nothing runs without an audit entry, and a call MoMo isn't allowed for leaves nothing on the disk.
const { RESULTS } = require('./audit.cjs');
const { destinationsOf, repeatable } = require('./sentinel.cjs');
const { refusalText, resultText, known, RECEIPTS, DETAILS } = require('./trustTexts.cjs');
const { noteIgnored } = require('../ignored.cjs');

const RESULT_SET = new Set(/** @type {string[]} */ (Object.values(RESULTS)));

/**
 * @typedef {import('./sentinel.cjs').Call} Call
 * @typedef {{ result?: string, receipt?: string, detail?: string, value?: unknown }} Outcome
 *   what an action returns: result (done unless said), a RECEIPTS key that replaces "Done.", a DETAILS key after "Nothing was sent."
 * @typedef {{ result: string, receipt?: string, detail?: string, value?: unknown }} Ended how an action ended, as the gate reads it
 * @typedef {{ ok: boolean, result?: string, reason?: string, value?: unknown, text?: string }} GateResult
 */

/**
 * How an action that returned `out` ended; a result the gate doesn't know is uncertain, never done.
 * @param {unknown} out
 * @returns {Ended}
 */
function outcomeOf(out) {
  if (!out || typeof out !== 'object' || Array.isArray(out) || !('result' in out)) return { result: RESULTS.DONE, value: out };
  const o = /** @type {Outcome} */ (out);
  // only keys of the known sets: an action's own text could carry what it read or sent
  const key = (/** @type {Record<string, string>} */ set, /** @type {unknown} */ v) =>
    known(set, v) ? /** @type {string} */ (v) : undefined;
  return {
    result: RESULT_SET.has(/** @type {string} */ (o.result)) ? /** @type {string} */ (o.result) : RESULTS.UNCERTAIN,
    receipt: key(RECEIPTS, o.receipt),
    detail: key(DETAILS, o.detail),
    value: o.value,
  };
}

/**
 * How an action that threw ended: not sent only when it says so (`notSent`), otherwise it may have gone through.
 * @param {unknown} error
 * @returns {Ended}
 */
function failureOf(error) {
  const e = /** @type {any} */ (error);
  if (e?.notSent === true) return { result: RESULTS.NOT_SENT, detail: known(DETAILS, e.detail) ? e.detail : undefined };
  return { result: RESULTS.UNCERTAIN };
}

const sendsData = (/** @type {Call} */ call) => {
  const d = destinationsOf(call.egress);
  return d.unknown || d.hosts.length > 0 || d.recipients.length > 0;
};

/**
 * @param {{ sentinel: InstanceType<typeof import('./sentinel.cjs').Sentinel>, audit: InstanceType<typeof import('./audit.cjs').AuditLog>,
 *           identity?: (chatId: string) => { harness?: string, account?: string },
 *           onError?: (what: string, error: unknown) => void }} o onError: an audit write that failed after the action ran;
 *   identity: a chat's harness and account, filled into every call that names none, so each audit entry and approval card
 *   carries them whoever calls the gate (#2373)
 */
function createTrustGate({ sentinel, audit, identity = () => ({}), onError = noteIgnored }) {
  /** @type {Promise<unknown> | null} intents a quit left open, settled once before the first side effect */
  let settled = null;
  const settle = () => {
    if (!settled) {
      settled = audit.settleUnfinished();
      settled.catch(() => {
        settled = null;
      });
    }
    return settled;
  };
  /**
   * @param {Call} given the call; harness and account are filled in from the chat when it names none
   * @param {(o: { signal: AbortSignal | null }) => Promise<unknown>} execute runs the action
   * @param {{ signal?: AbortSignal | null }} [o]
   * @returns {Promise<GateResult>}
   */
  return async function run(given, execute, { signal = null } = {}) {
    const who = given && typeof given === 'object' && typeof given.chatId === 'string' ? identity(given.chatId) : {};
    const call = /** @type {Call} */ (
      given && typeof given === 'object'
        ? { ...given, harness: given.harness || who.harness, account: given.account || who.account }
        : given
    );
    const c = /** @type {Partial<Call>} */ (call && typeof call === 'object' ? call : {});
    const sideEffect = c.kind === 'change' || sendsData(/** @type {Call} */ (c));
    // a read that sends data out is refused as nothing sent
    const about = { source: (c.source && sentinel.sources.get(c.source)?.name) || c.source, kind: sideEffect ? 'change' : c.kind };
    // no card for what can't be recorded anyway
    if (sideEffect && sentinel.allowed() && !audit.available()) return { ok: false, reason: 'audit', text: refusalText('audit', about) };
    const decision = await sentinel.decide(call, { signal });
    const fields = { action: c.tool || 'unknown', args: c.args, chatId: c.chatId || 'unknown', harness: c.harness, account: c.account };
    if (!decision.allow) {
      // an account MoMo isn't allowed for gets no MoMo folder, key or log
      if (decision.reason !== 'not-allowed')
        await audit
          .refusal({ ...fields, decision: decision.reason, ...(decision.by ? { device: decision.by } : {}) })
          .catch((e) => onError('record a refused MoMo call', e));
      return { ok: false, reason: decision.reason, text: refusalText(decision.reason, about) };
    }
    if (call.kind === 'read' && !sendsData(call)) return { ok: true, result: RESULTS.DONE, value: await execute({ signal }) };
    let intent;
    try {
      await settle();
      intent = await audit.intent({
        ...fields,
        decision: decision.scope ? `${decision.via}:${decision.scope}` : decision.via,
        ...(decision.by ? { device: decision.by } : {}),
      });
    } catch {
      // no record before it, no action; it no longer counts as running
      if (!repeatable(call)) sentinel.noteOutcome(call.chatId, decision.fingerprint, RESULTS.NOT_SENT);
      return { ok: false, reason: 'audit', text: refusalText('audit', about) };
    }
    /** @type {Ended} */
    let out;
    if (signal?.aborted) out = { result: RESULTS.NOT_SENT, value: undefined };
    else
      try {
        out = outcomeOf(await execute({ signal }));
      } catch (e) {
        out = { ...failureOf(e), value: undefined };
      }
    // a repeatable act was never counted as running (sentinel.cjs), so its end is not counted either
    if (!repeatable(call)) sentinel.noteOutcome(call.chatId, decision.fingerprint, out.result);
    let recorded = true;
    try {
      // the note is a receipt key, never the action's own text
      await audit.outcome(intent.id, { result: out.result, note: out.receipt ?? '' });
    } catch (e) {
      recorded = false;
      onError('record how a MoMo action ended', e);
    }
    return { ok: out.result === RESULTS.DONE, result: out.result, value: out.value, text: resultText(out.result, { ...out, recorded }) };
  };
}

module.exports = { createTrustGate, outcomeOf, failureOf };
