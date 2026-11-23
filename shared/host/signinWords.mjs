// What a sign-in to an agent on a machine says, in plain words, for the Mac's rows and cards and the phone's sheet alike: the state as one short line, the code to type, the button labels, and which states are still going. A vendor's own error is never pasted as it is: a known one becomes its short line, any other "Couldn't sign in to <Agent>" with the vendor's words as details.

/** @typedef {'retry' | 'api-key' | 'cancel'} SigninAction what the person can do next: start again, give an API key instead, or stop the sign-in under way */
/** @typedef {{ text: string, action?: SigninAction, code?: string, details?: string }} SigninStatus */
/** @typedef {{ state: string, harness?: string, codes: string[], link: boolean, error: string | null, reason?: 'no_page' | 'host_update' | null }} SigninViewLike what the words read of a sign-in: the Mac's view of it, or the phone's */

/** The states in which a sign-in is still going (the button turns into Cancel and the code shows). */
export const RUNNING_STATES = Object.freeze(['starting', 'waiting']);

/** The labels and lines of the sign-in controls, said once for every client. */
export const SIGNIN_WORDS = Object.freeze({
  signIn: 'Sign in',
  newCode: 'Get a new code',
  openPage: 'Open page',
  cancel: 'Cancel',
  send: 'Send',
  codeField: 'Code from the page',
  ended: 'That sign-in has ended. Start it again.',
  openFailed: "Couldn't open the page.",
});

/** Vendor errors seen in the field, each as one short line and what fixes it. @type {{ test: RegExp, text: string, action: SigninAction }[]} */
const KNOWN = [
  // Gemini CLI, 2026: Google retired "Log in with Google" for Gemini Code Assist for individuals and points at Antigravity
  {
    test: /no longer supported for Gemini Code Assist|migrate to the Antigravity/i,
    text: 'Google ended this sign-in for personal accounts',
    action: 'api-key',
  },
];

/**
 * The sign-in's state in plain words for `label` (the agent's display name); null when there is nothing to say (none started, or cancelled).
 * @param {SigninViewLike | undefined} view @param {string} label
 * @returns {SigninStatus | null}
 */
export function signinStatus(view, label) {
  if (!view) return null;
  switch (view.state) {
    case 'starting':
      return { text: 'Opening the sign-in page…', action: 'cancel' };
    case 'waiting':
      if (view.codes.length > 0) return { text: 'Enter this code in the page that opened', code: view.codes[0], action: 'cancel' };
      return { text: view.link ? 'Finish signing in in your browser' : 'Opening the sign-in page…', action: 'cancel' };
    // the Host said it was done and the machine is being asked whether it is
    case 'checking':
      return { text: 'Checking the sign-in…' };
    case 'signed-in':
      return { text: 'Signed in' };
    case 'expired':
      return { text: 'That code expired', action: 'retry' };
    case 'unreachable':
      return { text: "Couldn't reach the machine", action: 'retry', ...(view.error ? { details: view.error } : {}) };
    case 'failed': {
      if (view.reason === 'no_page') return { text: `${label} didn't open a sign-in page`, action: 'retry' };
      const said = view.error ?? '';
      const known = KNOWN.find((k) => k.test.test(said));
      if (known) return { text: known.text, action: known.action, details: said };
      return { text: `Couldn't sign in to ${label}`, action: 'retry', ...(said ? { details: said } : {}) };
    }
    default:
      // none started, or cancelled
      return null;
  }
}

/** The action's button label. @type {Record<SigninAction, string>} */
export const ACTION_LABEL = Object.freeze({ retry: 'Try again', 'api-key': 'Use an API key', cancel: SIGNIN_WORDS.cancel });

/** The sign-ins that never read a code typed back: `codex login --device-auth` shows a code to enter on its page and only polls. */
const NO_CODE_BACK = new Set(['codex']);

/** Whether the sign-in waits on a code typed back: a page was opened, the machine relayed no code of its own, and the agent's sign-in reads one. @param {SigninViewLike | undefined} view */
export const wantsCode = (view) =>
  !!view && RUNNING_STATES.includes(view.state) && view.link && view.codes.length === 0 && !NO_CODE_BACK.has(view.harness ?? '');

/** The label of the button that starts a sign-in again: a new code for one that expired. @param {string | undefined} state */
export const startLabel = (state) => (state === 'expired' ? SIGNIN_WORDS.newCode : SIGNIN_WORDS.signIn);
