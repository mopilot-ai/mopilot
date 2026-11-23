// Chromium's network errors in words, as Chrome's own error pages put them: what the browser pane shows the user (the
// raw code stays in the notice's tooltip) and what an agent's call says, with what to do next.

/** Chromium's codes for the errors named below (net/base/net_error_list.h), for a failure reported only by number. */
const CODES = {
  '-3': 'ERR_ABORTED',
  '-7': 'ERR_TIMED_OUT',
  '-20': 'ERR_BLOCKED_BY_CLIENT',
  '-21': 'ERR_NETWORK_CHANGED',
  '-100': 'ERR_CONNECTION_CLOSED',
  '-101': 'ERR_CONNECTION_RESET',
  '-102': 'ERR_CONNECTION_REFUSED',
  '-105': 'ERR_NAME_NOT_RESOLVED',
  '-106': 'ERR_INTERNET_DISCONNECTED',
  '-107': 'ERR_SSL_PROTOCOL_ERROR',
  '-109': 'ERR_ADDRESS_UNREACHABLE',
  '-113': 'ERR_SSL_VERSION_OR_CIPHER_MISMATCH',
  '-118': 'ERR_CONNECTION_TIMED_OUT',
  '-137': 'ERR_NAME_RESOLUTION_FAILED',
  '-310': 'ERR_TOO_MANY_REDIRECTS',
  '-324': 'ERR_EMPTY_RESPONSE',
  '-400': 'ERR_CACHE_MISS',
};

/** The user's words for each error: one short line, as Chrome's error page headline. */
const USER = {
  ERR_ABORTED: 'Loading this page was stopped.',
  ERR_TIMED_OUT: 'This site took too long to respond.',
  ERR_CONNECTION_TIMED_OUT: 'This site took too long to respond.',
  ERR_BLOCKED_BY_CLIENT: 'This page was blocked from loading.',
  ERR_NETWORK_CHANGED: 'Your network changed while the page loaded.',
  ERR_CONNECTION_CLOSED: 'This site closed the connection.',
  ERR_CONNECTION_RESET: 'The connection to this site was reset.',
  ERR_CONNECTION_REFUSED: 'This site refused to connect.',
  ERR_NAME_NOT_RESOLVED: "This site can't be reached: its address wasn't found.",
  ERR_NAME_RESOLUTION_FAILED: "This site can't be reached: its address wasn't found.",
  ERR_ADDRESS_UNREACHABLE: "This site can't be reached.",
  ERR_INTERNET_DISCONNECTED: "You're offline. Check your connection.",
  ERR_SSL_PROTOCOL_ERROR: "This site can't provide a secure connection.",
  ERR_SSL_VERSION_OR_CIPHER_MISMATCH: "This site can't provide a secure connection.",
  ERR_TOO_MANY_REDIRECTS: 'This page redirected too many times.',
  ERR_EMPTY_RESPONSE: 'This site sent no data.',
  ERR_CACHE_MISS: 'This page came from a form. Resubmit to see it again.',
};

/** The cause an agent reads, and its advice when retrying the same address won't help. */
const AGENT = {
  ERR_ABORTED: ['the load was stopped'],
  ERR_TIMED_OUT: ['the site took too long to respond'],
  ERR_CONNECTION_TIMED_OUT: ['the site took too long to respond'],
  ERR_BLOCKED_BY_CLIENT: ['it was blocked from loading', "Retrying won't help; tell the user."],
  ERR_NETWORK_CHANGED: ['the network changed while it loaded'],
  ERR_CONNECTION_CLOSED: ['the site closed the connection'],
  ERR_CONNECTION_RESET: ['the connection was reset'],
  ERR_CONNECTION_REFUSED: ['the site refused to connect'],
  ERR_NAME_NOT_RESOLVED: ["the site's address wasn't found", "Check the address for a typo; retrying it as it is won't help."],
  ERR_NAME_RESOLUTION_FAILED: ["the site's address wasn't found", "Check the address for a typo; retrying it as it is won't help."],
  ERR_ADDRESS_UNREACHABLE: ['the site is unreachable'],
  ERR_INTERNET_DISCONNECTED: ['the computer is offline', 'Tell the user to check their connection.'],
  ERR_SSL_PROTOCOL_ERROR: ["the site can't provide a secure connection", "Retrying won't help; tell the user."],
  ERR_SSL_VERSION_OR_CIPHER_MISMATCH: ["the site can't provide a secure connection", "Retrying won't help; tell the user."],
  ERR_TOO_MANY_REDIRECTS: ['it redirected too many times', "Retrying won't help; tell the user (clearing its cookies may fix it)."],
  ERR_EMPTY_RESPONSE: ['the site sent no data'],
};

/** The error's name ('ERR_CACHE_MISS') from Electron's description, CDP's errorText ('net::ERR_…') or the code alone. */
export function netErrorName(code, description = '') {
  const m = /ERR_[A-Z0-9_]+/.exec(String(description ?? ''));
  return m ? m[0] : (CODES[String(code)] ?? '');
}

/** The pane's line for a failed load, without the code (the notice keeps it as its detail), or null for an unlisted error. */
export function netErrorMessage(name) {
  return USER[name] ?? null;
}

/** Whether a failure is a form result that only resubmitting the form shows again (Back or reload onto a POST). */
export const isResubmitError = (name) => name === 'ERR_CACHE_MISS';

/**
 * What an agent's call says about a page that failed with `name` (`what`: the raw failure, kept for the agent), led by
 * `lead`. A form result is never resubmitted by the agent: resubmitting may repeat what the form did (a payment).
 */
export function netErrorNote(name, what, lead = "Couldn't load this page") {
  if (isResubmitError(name))
    return `Couldn't show this page (${what}): it was the result of a form submission, and showing it again means submitting that form again. Don't resubmit it yourself: it may repeat a submission or payment. If it was only a search or query, fill in and submit the form again; otherwise ask the user, who can resubmit from the browser pane.`;
  const [cause, advice = 'Try once more; if it fails again, tell the user.'] = AGENT[name] ?? [];
  return `${lead}${cause ? `: ${cause}` : ''} (${what}). ${advice}`;
}
