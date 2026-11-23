// The model keys the app may lend a Host for a harness's own process (#3361 Tier 1): which harness takes which key, under which env name, and what a key must look like. Shared by the app (which keeps the key) and the Host (which holds it in memory only), so the two cannot drift.

/**
 * How each harness takes a key, and the provider whose key it is. A harness not listed takes no key from the app.
 * `env`: the CLI reads it from this env name (Claude Code). `login`: the process is told it over its own protocol and keeps it in memory
 * (Codex's app-server, started with an ephemeral credential store, `account/login/start` apiKey: it ignores OPENAI_API_KEY in its env).
 * `acp`: an ACP agent that reads the key from its env; one with `authMethod` reads it once its client picks that sign-in method with ACP `authenticate`
 * (Gemini CLI's `gemini-api-key`, Grok's `xai.api_key`), which the Host does when it starts the agent with a key lent (dsh needs none).
 */
export const KEYED = Object.freeze({
  claude: Object.freeze({ env: 'ANTHROPIC_API_KEY', provider: 'anthropic', via: 'env' }),
  codex: Object.freeze({ env: 'OPENAI_API_KEY', provider: 'openai', via: 'login' }),
  gemini: Object.freeze({ env: 'GEMINI_API_KEY', provider: 'google', via: 'env', acp: true, authMethod: 'gemini-api-key' }),
  grok: Object.freeze({ env: 'XAI_API_KEY', provider: 'xai', via: 'env', acp: true, authMethod: 'xai.api_key' }),
  // dsh reads DEEPSEEK_API_KEY from its env and lists no sign-in method: nothing to pick
  dsh: Object.freeze({ env: 'DEEPSEEK_API_KEY', provider: 'deepseek', via: 'env', acp: true }),
});

/** Whether `harness` is an ACP agent that takes its own key in its env (Gemini, Grok, dsh): only its own process gets that key. @param {string} harness */
export const acpKeyed = (harness) =>
  Object.hasOwn(KEYED, harness) && /** @type {Record<string, { acp?: boolean }>} */ (KEYED)[harness].acp === true;

/** The key sign-in method an ACP agent is told to use when a key is lent for it, or null for an agent that takes no key (or is not ACP). @param {string} harness */
export const keyAuthMethod = (harness) => {
  const k = Object.hasOwn(KEYED, harness) ? /** @type {Record<string, { authMethod?: string }>} */ (KEYED)[harness] : null;
  return k?.authMethod ?? null;
};
/** The providers whose key the app keeps, by the harness that uses it. */
export const PROVIDERS = Object.freeze(Object.fromEntries(Object.entries(KEYED).map(([harness, k]) => [k.provider, harness])));

/** Printable, no spaces, 20 to 512 characters: what an API key looks like, and nothing a shell or a header would split. */
const KEY = /^[\x21-\x7e]{20,512}$/;

/** Whether `v` can be a key. The answer never carries the key itself. @param {unknown} v */
export const isKey = (v) => typeof v === 'string' && KEY.test(v);

/** How a key is shown: its last four characters, never more. @param {string} key */
export const keyHint = (key) => `…${key.slice(-4)}`;
