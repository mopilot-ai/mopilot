// Why a turn on a Host failed, as one of a few codes a client can act on without reading the harness's words (#4278): the harness's own signal where it gives one (Codex's `codexErrorInfo`, Claude Code's assistant `error`), else its message. Set once on the Host (host/src/sessions.mjs) and carried on the turn's end as `error.code`.
import { isAuthText } from '../acpAuth.mjs';
import { isLimitError } from '../acpStop.mjs';
import { LOGIN_REFUSED_SIGNAL, isLoginRefused } from '../loginRefused.mjs';

/** @typedef {'rate_limit' | 'auth' | 'context' | 'model_unavailable'} TurnErrorCode */

/** The codes, for a client that checks one it was sent. */
export const TURN_ERROR_CODES = Object.freeze(['rate_limit', 'auth', 'context', 'model_unavailable']);

/** What each harness's own word for a failure means here. Codex: `codexErrorInfo` (src/protocol/v2/CodexErrorInfo.ts); Claude Code: an assistant message's `error`. */
const SIGNALS = new Map(
  /** @type {[string, TurnErrorCode][]} */ ([
    ['usageLimitExceeded', 'rate_limit'],
    ['rateLimitExceeded', 'rate_limit'],
    ['sessionBudgetExceeded', 'rate_limit'],
    ['unauthorized', 'auth'],
    ['contextWindowExceeded', 'context'],
    ['serverOverloaded', 'model_unavailable'],
    ['flexUnavailable', 'model_unavailable'],
    ['rate_limit', 'rate_limit'],
    ['authentication_failed', 'auth'],
    // the provider refused the stored login for its organization: the login has to change, so it is a sign-in problem
    [LOGIN_REFUSED_SIGNAL, 'auth'],
  ]),
);

const AUTH =
  /invalid (api[ _-]?key|x-api-key|credentials)|(oauth|access) token (has |is )?(expired|revoked|invalid)|please run \/login|\b401\b.*unauthori[sz]ed|unauthori[sz]ed.*\b401\b/i;
const CONTEXT = /context (window|length)|prompt is too long|input is too long|maximum context|too many tokens|context_length_exceeded/i;
const MODEL =
  /model\b.{0,60}\b(not found|not available|unavailable|does not exist|not supported|is overloaded)|no such model|model_not_found|issue with the selected model|^\W*overloaded\b|\boverloaded_error\b/i;

/**
 * @param {unknown} signal the harness's own word for the failure: a string, or Codex's one-key object (`{ responseStreamConnectionFailed: … }`)
 * @param {unknown} [message] the failure's text, read only when the signal says nothing known
 * @returns {TurnErrorCode | undefined}
 */
export function turnErrorCode(signal, message) {
  const word = typeof signal === 'string' ? signal : signal && typeof signal === 'object' ? Object.keys(signal)[0] : undefined;
  const known = word === undefined ? undefined : SIGNALS.get(word);
  if (known) return known;
  // Codex's connection failures carry the upstream's HTTP status: too many requests and unauthorized are said by number
  const status = word !== undefined && typeof signal === 'object' ? /** @type {any} */ (signal)[word]?.httpStatusCode : undefined;
  if (status === 429) return 'rate_limit';
  if (status === 401) return 'auth';
  const text = typeof message === 'string' ? message : '';
  if (isLimitError(text)) return 'rate_limit';
  if (isAuthText(text) || AUTH.test(text) || isLoginRefused(text)) return 'auth';
  if (CONTEXT.test(text)) return 'context';
  return MODEL.test(text) ? 'model_unavailable' : undefined;
}

/**
 * A turn's end with its failure's code: one the adapter set is kept, else the message decides. Only a turn that failed has one (a Stop and a restart's end do not).
 * @param {any} event a `turnEnd`
 */
export function typedTurnEnd(event) {
  if (event.stopReason !== 'error' || event.error == null) return event;
  const error = typeof event.error === 'object' ? event.error : { message: String(event.error) };
  const code = TURN_ERROR_CODES.includes(error.code) ? error.code : turnErrorCode(undefined, error.message);
  const { code: _given, ...rest } = error;
  return { ...event, error: code ? { ...rest, code } : rest };
}

/** What a failure's text starts with when its own words do not read as the code the Host gave it. */
const LEAD = {
  rate_limit: 'Usage limit reached',
  auth: 'Not signed in',
  context: 'Context window is full',
  model_unavailable: 'Model unavailable',
};

/**
 * The code of a failure as text alone says it, for a reader that has only the text (the thread, a reopened chat): the lead `ledAs` put there
 * wins over anything the rest of the words would say; without one the words decide.
 * @param {unknown} text @returns {TurnErrorCode | undefined}
 */
export function codeOfText(text) {
  const t = typeof text === 'string' ? text : '';
  const led = TURN_ERROR_CODES.find((code) => t.startsWith(`${LEAD[/** @type {TurnErrorCode} */ (code)]}: `));
  return /** @type {TurnErrorCode | undefined} */ (led) ?? turnErrorCode(undefined, t);
}

/**
 * A failure's text such that `codeOfText` reads `code` from it: as it is when it already does, else led by the code's words.
 * @param {string} text @param {TurnErrorCode | undefined} code
 */
export function ledAs(text, code) {
  return code && codeOfText(text) !== code ? `${LEAD[code]}: ${text}` : text;
}
