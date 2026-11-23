// The model providers a routed chat can be sent to (plan Part B): the wires each speaks, its default base URL, the env name and auth header its key goes under, and the key-store slot that key is kept in. The key env names and slots of providers a Host also takes a key for come from shared/host/credentials.mjs, so the two tables cannot drift.
import { KEYED } from './host/credentials.mjs';

/** The request shapes a provider answers: Anthropic Messages, OpenAI Chat Completions, OpenAI Responses, Gemini generateContent. */
export const WIRES = Object.freeze(['anthropic', 'openai-chat', 'openai-responses', 'gemini']);

/** How a provider takes its key: `Authorization: Bearer`, Anthropic's `x-api-key`, Google's `x-goog-api-key`. */
export const AUTH_STYLES = Object.freeze(['bearer', 'x-api-key', 'x-goog-api-key']);

/** The Host's entry for `harness`, whose env name and key slot a provider here shares. @param {keyof typeof KEYED} harness */
const hostKey = (harness) => ({ keyEnv: KEYED[harness].env, keySlot: KEYED[harness].provider });

/**
 * @typedef {{ id: string, label: string, wires: readonly string[], baseUrl: string | null, keyEnv: string | null,
 *   auth: string, keySlot: string, customBase: boolean, keyOptional: boolean }} LlmProvider
 * `baseUrl` null and `customBase` true: the user names the endpoint (an OpenAI-compatible server such as Ollama or vLLM), and its key
 * is kept for that origin only (keySlotFor). `keyOptional`: the endpoint may take no key (a local server).
 */

/** @type {Readonly<Record<string, Readonly<LlmProvider>>>} */
export const LLM_PROVIDERS = Object.freeze(
  Object.fromEntries(
    /** @type {LlmProvider[]} */ ([
      {
        id: 'openai',
        label: 'OpenAI',
        wires: ['openai-chat', 'openai-responses'],
        baseUrl: 'https://api.openai.com/v1',
        auth: 'bearer',
        ...hostKey('codex'),
        customBase: false,
        keyOptional: false,
      },
      {
        id: 'anthropic',
        label: 'Anthropic',
        wires: ['anthropic'],
        baseUrl: 'https://api.anthropic.com',
        auth: 'x-api-key',
        ...hostKey('claude'),
        customBase: false,
        keyOptional: false,
      },
      {
        id: 'gemini',
        label: 'Google Gemini',
        wires: ['gemini'],
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        auth: 'x-goog-api-key',
        ...hostKey('gemini'),
        customBase: false,
        keyOptional: false,
      },
      {
        id: 'openrouter',
        label: 'OpenRouter',
        wires: ['openai-chat'],
        baseUrl: 'https://openrouter.ai/api/v1',
        auth: 'bearer',
        keyEnv: 'OPENROUTER_API_KEY',
        keySlot: 'openrouter',
        customBase: false,
        keyOptional: false,
      },
      {
        id: 'deepseek',
        label: 'DeepSeek',
        wires: ['openai-chat'],
        baseUrl: 'https://api.deepseek.com/v1',
        auth: 'bearer',
        ...hostKey('dsh'),
        customBase: false,
        keyOptional: false,
      },
      {
        id: 'custom',
        label: 'OpenAI-compatible server',
        wires: ['openai-chat'],
        baseUrl: null,
        auth: 'bearer',
        keyEnv: null,
        keySlot: 'custom',
        customBase: true,
        keyOptional: true,
      },
    ]).map((p) => [p.id, Object.freeze({ ...p, wires: Object.freeze([...p.wires]) })]),
  ),
);

/** The provider `id` names, or null for one the catalog does not have. @param {unknown} id */
export const llmProvider = (id) => (typeof id === 'string' && Object.hasOwn(LLM_PROVIDERS, id) ? LLM_PROVIDERS[id] : null);

/** The catalog as a list, in its order. */
export const listLlmProviders = () => Object.values(LLM_PROVIDERS);

/** A host plain HTTP may reach: this Mac or a private network (a local Ollama or vLLM). Anything else must be https, so a key is never sent in the clear over the internet. @param {string} host */
const privateHost = (host) =>
  host === 'localhost' ||
  host.endsWith('.local') ||
  host === '[::1]' ||
  /^127\.\d+\.\d+\.\d+$/.test(host) ||
  /^10\.\d+\.\d+\.\d+$/.test(host) ||
  /^192\.168\.\d+\.\d+$/.test(host) ||
  /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(host);

/**
 * A user's base URL, normalised (no trailing slash), or the reason it is refused: https, or http to this Mac or a private network;
 * no user name, password, query or fragment, which a request path would be appended after or would leak.
 * @param {unknown} value
 * @returns {{ ok: true, url: string, origin: string } | { ok: false, error: string }}
 */
export function checkBaseUrl(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > 500 || !URL.canParse(text))
    return { ok: false, error: 'Enter the server’s URL, such as http://localhost:11434/v1.' };
  const url = new URL(text);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && privateHost(url.hostname)))
    return { ok: false, error: 'Use an https URL, or http only for this Mac or your own network.' };
  if (url.username || url.password || url.search || url.hash || text.includes('?') || text.includes('#'))
    return { ok: false, error: 'The URL can’t carry a user name, password, query or fragment.' };
  return { ok: true, url: `${url.origin}${url.pathname.replace(/\/+$/, '')}`, origin: url.origin };
}

/**
 * The key-store slot of the key for `provider` (at `baseUrl` for a provider whose endpoint the user names): a named provider's own slot,
 * else `custom:<origin>`, so a key entered for one server is never sent to another. Null when the provider is unknown or the URL is refused.
 * @param {unknown} provider @param {unknown} [baseUrl]
 */
export function keySlotFor(provider, baseUrl) {
  const p = llmProvider(provider);
  if (!p) return null;
  if (!p.customBase) return p.keySlot;
  const base = checkBaseUrl(baseUrl);
  return base.ok ? `${p.keySlot}:${base.origin}` : null;
}
