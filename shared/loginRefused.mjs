// How a provider's refusal of a stored login reads, whoever started the agent: Anthropic answers an inference request on a login whose organization may not use Claude Code with HTTP 403 `oauth_not_allowed_for_organization` (the CLI's own word for it: `oauth_org_not_allowed`), which the CLI words "Your organization has disabled Claude subscription access for Claude Code". The login authenticates (its profile reads), so no 401 wording ever shows; the agent cannot run on it.

/** The assistant message `error` Claude Code gives that refusal. */
export const LOGIN_REFUSED_SIGNAL = 'oauth_org_not_allowed';

const REFUSED = /oauth_(org_)?not_allowed(_for_organization)?|disabled Claude subscription access/i;

/** Whether a failure's words (or the code the API sent) are the provider refusing the login. @param {unknown} text */
export const isLoginRefused = (text) => typeof text === 'string' && REFUSED.test(text);

/**
 * Whether an assistant message of Claude Code is its login failing: the CLI's own `authentication_failed`, a lapsed login's words, or the provider refusing the login for its organization (its `oauth_org_not_allowed`, or its sentence). A key or credits that failed is not this: the caller decides which credential ran.
 * @param {{ error?: unknown, message?: { content?: unknown } }} m
 */
export const claudeAuthFailed = (m) => {
  if (m.error === 'authentication_failed' || m.error === LOGIN_REFUSED_SIGNAL) return true;
  if (!m.error) return false;
  const said = JSON.stringify(m.message?.content ?? '');
  return (
    /Failed to authenticate|Invalid API key|OAuth (access )?token has expired|Re-authenticate to continue/i.test(said) ||
    isLoginRefused(said)
  );
};
