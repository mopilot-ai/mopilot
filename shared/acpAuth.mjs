// The words a basic (ACP) harness's failure uses when it wants a sign-in first, shared by main (admission and turns)
// and the chat's Sign in / Re-check buttons, so both read the same failure the same way.

/** A login message from the harness ("Authentication required", "Not logged in", "Login required"). */
const AUTH_TEXT = /auth(entication)? required|not (logged|signed) in|login required/i;

/** Whether a basic harness's error text asks for a sign-in. */
export function isAuthText(text) {
  return typeof text === 'string' && AUTH_TEXT.test(text);
}
