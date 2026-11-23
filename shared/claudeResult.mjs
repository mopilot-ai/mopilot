// How a Claude Code `result` ended, shared by main's controller and the windows' translator. Pure.
//
// The CLI appends its own diagnostics to a failed result's `errors`: "[ede_diagnostic] result_type=user last_content_type=n/a
// stop_reason=null" when a prompt's loop ends on a user message, which is what a message steered into the running turn leaves
// behind. Claude Code's own viewers drop these lines and show nothing when no other error is left; a result whose only errors
// are diagnostics is not a failure the chat reports.

const DIAGNOSTIC = /^\[ede_diagnostic\]/;

/** The errors of a result a person should read: its `errors` without the CLI's diagnostic lines (anything else stays). */
export function claudeResultErrors(m) {
  return Array.isArray(m?.errors) ? m.errors.filter((e) => typeof e !== 'string' || !DIAGNOSTIC.test(e)).map(String) : [];
}

/** Whether a `result` reports a failure: not a success, unless every error it lists is one of the CLI's diagnostics. */
export function claudeResultFailed(m) {
  if (m?.subtype === 'success') return m.is_error === true;
  return !(Array.isArray(m?.errors) && m.errors.length > 0 && claudeResultErrors(m).length === 0);
}
