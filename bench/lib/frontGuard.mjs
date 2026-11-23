// The benchmark VM's GUI driver sends keys and clicks only to the app it brought to the front (#1561): the AppleScript
// that checks the frontmost process before acting (a key in the same System Events call), and the error naming the app
// in front instead.

/** The AppleScript error number the guard raises; osascript prints it as "execution error: <front app> (9001)". */
export const FRONT_ERROR = 9001;

/** A key or click refused because another app was in front: nothing was sent to it. */
export class NotFrontmost extends Error {
  /** @param {string} want @param {string} front */
  constructor(want, front) {
    super(`${want} is not the frontmost app (${front} is), so nothing was sent.`);
    this.code = 'not_frontmost';
    this.want = want;
    this.front = front;
  }
}

/** An AppleScript string literal (its escapes for quotes and backslashes are JSON's). @param {string} s */
export const appleString = (s) => JSON.stringify(String(s));

/**
 * The osascript `-e` lines that fail with FRONT_ERROR unless `app` is the frontmost process (by its process name or
 * its displayed name), and otherwise run `action` (a System Events command; none for a check alone). The check and the
 * action run in one call, so no other app can come to the front between them.
 * @param {string} app @param {string} [action]
 */
export function guardedScript(app, action = '') {
  return [
    'tell application "System Events"',
    'set p to first application process whose frontmost is true',
    'set n to (name of p) as text',
    `if n is not ${appleString(app)} and ((displayed name of p) as text) is not ${appleString(app)} then error n number ${FRONT_ERROR}`,
    ...(action ? [action] : []),
    'end tell',
  ];
}

/**
 * What a failed guarded osascript call means: NotFrontmost when the guard refused, otherwise the failure itself.
 * @param {string} app @param {any} error
 */
export function frontFailure(app, error) {
  const text = `${error?.stderr ?? ''}\n${error?.message ?? ''}`;
  const m = new RegExp(`execution error: (.*) \\(${FRONT_ERROR}\\)`).exec(text);
  return m ? new NotFrontmost(app, m[1].trim()) : error;
}
