// How an ACP prompt's end reads in the chat: the turn's status, and a short note when the reply was cut off or the
// harness ran into its usage limit. Shared by the thread's translator (live and replayed) and main's notification.

/**
 * Usage-limit and quota errors as basic harnesses word them (Gemini CLI, Claude over ACP, opencode, Goose, Kimi...).
 * A basic harness signs in on its own and has no account pool, so nothing switches: the chat says so instead.
 */
const LIMIT_TEXT = [
  /usage limit/i,
  /quota (was |has been )?(exceeded|exhausted|reached)/i,
  /exhausted (your|the) .*quota/i,
  /exceeded (your|the) current quota/i,
  /exceeded_current_quota/i,
  /resource[_ ]exhausted/i,
  /rate[ -]?limit(ed| exceeded| reached)?\b/i,
  /too many requests/i,
  /hit (your|the) (usage |weekly |daily |monthly |session )?limit/i,
  /credit balance is too low/i,
  /insufficient (credits|balance|quota)/i,
  /out of credits/i,
];

/** Whether a failed prompt's error text says the harness hit its usage limit. */
export function isLimitError(text) {
  const t = typeof text === 'string' ? text : '';
  return !!t && LIMIT_TEXT.some((re) => re.test(t));
}

/** Stop reasons that end a reply before the agent finished it. */
const CUT_OFF = new Map([
  ['max_tokens', 'The reply was cut off: the harness reached its output limit for one reply. Ask it to continue.'],
  ['max_turn_requests', 'The reply was cut off: the harness reached its limit of model requests for one message. Ask it to continue.'],
]);

/** What to do about a provider that keeps failing, said after its error wherever the chat shows one (#1534). */
export const PROVIDER_NEXT_STEP =
  'Try again later, pick another model, or continue on another harness; check the provider account if it keeps failing.';

/**
 * A harness retrying its failing provider in silence (electron/harness/acp/providerErrors.cjs), as the `error`
 * notification with willRetry that Codex's own retries send: the thread's one retry banner for every harness.
 */
export function providerRetryError(threadId, turnId, label, error) {
  return { threadId, turnId, willRetry: true, error: { message: `${label}'s provider failed: ${error}. ${label} keeps retrying.` } };
}

/**
 * A turn's error as text, the one form a chat's records and the thread read: a Host sends `{ message }` on the wire (host/src/turnBridge.mjs), and records written before this kept it that way.
 * @param {unknown} error
 * @returns {string | null}
 */
export function stopErrorText(error) {
  if (error === null || error === undefined || error === '') return null;
  if (typeof error === 'string') return error;
  const message = /** @type {{ message?: unknown }} */ (error).message;
  return typeof message === 'string' && message ? message : JSON.stringify(error);
}

/**
 * An ACP prompt's end as the chat shows it.
 * @param {string | null | undefined} stopReason ACP's stop reason ('error' or none when the prompt failed)
 * @param {string | null | undefined} error the failure's text
 * @param {string | null | undefined} [providerError] the provider failure the harness was still retrying (electron/harness/acp/providerErrors.cjs)
 * @returns {{ status: 'completed' | 'interrupted' | 'failed', error: string | null, note: { kind: 'cutOff' | 'limit' | 'provider' | 'refusal', text: string } | null }}
 */
export function acpStop(stopReason, error, providerError = null) {
  // stopped while the harness retried a failing provider: the chat says why it got nowhere
  if (stopReason === 'cancelled' && providerError) {
    const text = `Stopped while the provider kept failing (${String(providerError).trim()}). ${PROVIDER_NEXT_STEP}`;
    return { status: 'interrupted', error: null, note: { kind: isLimitError(providerError) ? 'limit' : 'provider', text } };
  }
  if (stopReason === 'cancelled') return { status: 'interrupted', error: null, note: null };
  const failed = !stopReason || stopReason === 'error' || stopReason === 'refusal';
  // a usage limit is a note saying what to do, not the harness's raw error
  if (failed && isLimitError(error)) {
    const text = `The harness reached its usage limit (${String(error).trim()}). It has no other account to switch to: try again when the limit resets, or continue on another harness.`;
    return { status: 'failed', error: null, note: { kind: 'limit', text } };
  }
  // the agent's safety filter paused the chat: a note the panel's refusal card reads, not a raw error
  if (stopReason === 'refusal')
    return { status: 'failed', error: null, note: { kind: 'refusal', text: error || 'The agent refused to continue' } };
  const message = error || null;
  if (failed) return { status: 'failed', error: message, note: null };
  const cut = CUT_OFF.get(String(stopReason));
  return { status: 'completed', error: message, note: cut ? { kind: 'cutOff', text: cut } : null };
}
