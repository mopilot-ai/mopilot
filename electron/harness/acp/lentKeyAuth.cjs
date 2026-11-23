// An ACP agent a Host started with the user's own key lent for it (shared/host/credentials.mjs: Gemini's GEMINI_API_KEY, Grok's XAI_API_KEY) is told to sign in with that key: ACP `authenticate` with the key method, before any session, so it never falls back to a sign-in it last used on that machine.

/** How long the key sign-in may take: it only reads its env, so a slow answer is an agent that is not going to. */
const KEY_AUTH_MS = 15_000;

/**
 * Pick the key sign-in method on a freshly started agent when the host lent it a key (`host.lentAuthFn`, set by a Host's runtime, host/src/acp.mjs; the app's own host has none), and the agent offers that method.
 * A refusal is reported, not thrown: the chat's first session then says what the agent wants, as it does without a key.
 * @param {{ lentAuthFn?: (harness: string) => string | null }} host
 * @param {string} harness
 * @param {{ caps: { authMethods: any[] } | null, request: (method: string, params: any, o?: any) => Promise<unknown> }} agent
 * @param {(what: string, error: unknown) => void} report
 */
async function signInWithLentKey(host, harness, agent, report) {
  const methodId = host.lentAuthFn?.(harness) ?? null;
  if (!methodId || !agent.caps?.authMethods.some((m) => String(m?.id) === methodId)) return false;
  try {
    await agent.request('authenticate', { methodId }, { timeoutMs: KEY_AUTH_MS });
    return true;
  } catch (e) {
    report('sign an agent in with the lent key', e);
    return false;
  }
}

module.exports = { signInWithLentKey, KEY_AUTH_MS };
