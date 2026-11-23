// What a failure says to a person, for main and the windows: errorText drops Electron's IPC wrapper, userError also turns
// system codes, network errors and exit codes into a short sentence and drops stacks and paths. docs/bug-prevention/misleading-error-text-and-silent-opens.md

/**
 * What an error says: `Name: message` for a named Error, its message for a plain one, anything else as a string.
 * Never throws (a thrown value can have a hostile toString).
 * @param {unknown} error
 * @returns {string}
 */
export function describeError(error) {
  try {
    if (error instanceof Error) return error.name && error.name !== 'Error' ? `${error.name}: ${error.message}` : error.message;
    return String(error);
  } catch {
    return 'unprintable error';
  }
}

/**
 * A field of a thrown plain object (a JSON-RPC error object), or of an Error for `code`; null for another type or a
 * hostile getter.
 * @param {unknown} error
 * @param {'message' | 'code'} key
 */
function field(error, key) {
  if (!error || typeof error !== 'object' || (key === 'message' && error instanceof Error)) return null;
  try {
    const value = /** @type {Record<string, unknown>} */ (error)[key];
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

/**
 * What an error says to a person: describeError without the wrapper Electron puts around an error main threw
 * ("Error invoking remote method 'x': Error: "), or a thrown object's message. Never throws.
 * @param {unknown} error
 * @returns {string}
 */
export function errorText(error) {
  return (field(error, 'message') ?? describeError(error)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

/** System error codes, by what a person reads. */
const CODES = /** @type {Record<string, string>} */ ({
  ENOENT: 'File or program not found.',
  EACCES: 'Permission denied.',
  EPERM: 'Permission denied.',
  ENOSPC: 'The disk is full.',
  EBUSY: 'The file is in use.',
  EEXIST: 'It already exists.',
  ECONNREFUSED: "Couldn't connect.",
  ECONNRESET: 'The connection was lost.',
  ETIMEDOUT: 'The connection timed out.',
  ENOTFOUND: "Couldn't reach the server.",
});
const NET = /** @type {Record<string, string>} */ ({
  INTERNET_DISCONNECTED: "You're offline.",
  NAME_NOT_RESOLVED: "Couldn't reach the server.",
  CONNECTION_REFUSED: "Couldn't connect.",
  TIMED_OUT: 'The connection timed out.',
});
export const UNKNOWN_ERROR = 'Something went wrong.';

/**
 * A failure as one short sentence a person can read: a known system code (ENOENT, EACCES, ECONNREFUSED …), a network
 * error (net::ERR_*) or a process's exit code as words, else the error's first line (its first sentence when long) without its stack or paths.
 * Keep the raw error for the log or diagnostics; never show it. Never throws.
 * @param {unknown} error
 * @param {{ fallback?: string, who?: string }} [o] what to say when nothing readable is left; who quit, for an exit code
 * @returns {string}
 */
export function userError(error, { fallback = UNKNOWN_ERROR, who = 'It' } = {}) {
  const text = errorText(error ?? '');
  const code = field(error, 'code') ?? /\b(E[A-Z]{3,})\b/.exec(text)?.[1];
  if (code && Object.hasOwn(CODES, code)) return CODES[code];
  const net = /\bnet::ERR_([A-Z_]+)/.exec(text)?.[1];
  if (net) return Object.hasOwn(NET, net) ? NET[net] : 'Network error.';
  if (/\bexit(?:ed)?(?: with)?(?: code| signal)? \(?(?:-?\d+|SIG[A-Z]+)\b/i.test(text)) return `${who} quit unexpectedly.`;
  const line = text
    .split('\n')[0]
    // another system error's code and the call it failed in ("EISDIR: illegal operation on a directory, open '…'")
    .replace(/^E[A-Z]{2,}: (.*?)(?:, [a-z]+\b.*)?$/, '$1')
    // a vendor's error domain and number at the end ("… (SQRLUpdaterErrorDomain error 8.)")
    .replace(/\s*\([^()]*(?:Domain|\berror -?\d+|\bcode -?\d+)[^()]*\)\.?$/, '')
    // paths, quoted or not
    .replace(
      /(?<!\w)(?:'(?:[^']|'(?=\w))*\/(?:[^']|'(?=\w))*'|"(?:\\.|[^"\\])*\/(?:\\.|[^"\\])*")|(?<![\w:/.~])(?:~|\.{1,2})?\/(?:[^\s,;:'")]|(?<=\w)'(?=\w))+(?<!\.)/g,
      '',
    )
    .replace(/\s+([,.:;])/g, '$1')
    .replace(/[:,;](?=[.!?])/g, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/[\s,:;]+$/, '')
    .trim();
  // a short line keeps its next step ("… failed. Restart Codex."); a long one only its first sentence
  const sentence = line.length <= 120 ? line : (/^.*?[.!?](?=\s|$)/.exec(line)?.[0] ?? line);
  // nothing readable left, or only another code
  if (!sentence || /^[\W\d]*$/.test(sentence) || /^E[A-Z]{2,}\.?$/.test(sentence)) return fallback;
  const capital = sentence[0].toUpperCase() + sentence.slice(1);
  return /[.!?]$/.test(capital) ? capital : `${capital}.`;
}
