// What a failed Google API call is allowed to say: a status and Google's reason word, nothing else. The raw error of the HTTP client carries the request (URL, `Authorization` header, body), so it never leaves the client module.

/** A Google call failed. `message` and every field hold no token, URL, code or secret. */
export class GoogleApiError extends Error {
  status;
  reason;
  constructor(status, reason) {
    super(status ? `Google answered ${status}${reason ? ` (${reason})` : ''}` : 'Google could not be reached');
    this.name = 'GoogleApiError';
    this.status = status;
    this.reason = reason;
  }
}

/** Reasons Google gives a 403 when the caller is only too fast: retry later, the grant is fine. */
const RATE_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded']);
/** Reasons that mean the grant lacks what the call needs. */
const SCOPE_REASONS = new Set(['insufficientPermissions', 'ACCESS_TOKEN_SCOPE_INSUFFICIENT', 'insufficientScopes']);

/**
 * The status and reason word of a raw client error (the `reason` of the first entry in the error body), read once and then dropped.
 * @param {unknown} e @returns {{ status: number, reason: string }}
 */
export function readError(e) {
  const x = /** @type {any} */ (e);
  const reason = x?.response?.data?.error?.errors?.[0]?.reason;
  return { status: Number(x?.status) || 0, reason: typeof reason === 'string' ? reason.slice(0, 64) : '' };
}

/** A failure worth waiting for: 429, the rate-limit 403s, and the server errors that come and go. @param {{ status: number, reason: string }} f */
export const isRetryable = ({ status, reason }) =>
  status === 429 || status === 500 || status === 502 || status === 503 || status === 504 || (status === 403 && RATE_REASONS.has(reason));

/** A 403 that says the grant lacks a scope. @param {{ status: number, reason: string }} f */
export const isScopeProblem = ({ status, reason }) => status === 403 && SCOPE_REASONS.has(reason);

/** Waits `ms`. @param {number} ms */
export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
