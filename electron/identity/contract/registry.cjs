// Who serves a turn and who pays for it.
//
// A ProviderProfile is an endpoint family (OpenAI, Anthropic, MoPilot, or a third-party gateway). An
// Instance is one credential on one harness: a (harness, provider, credential) triple with a billing
// type. The account modules (accounts.cjs, harness/claude/accounts.cjs, the Claude key in harness/claude/index.cjs, the
// MoPilot device key) keep their records; each harness's AccountDriver (drivers/*.cjs) maps them to
// instances, so policy code sees one shape for both harnesses.
const { API_BASE } = require('../../platform/install.cjs');
const { LLM_PROVIDERS } = require('../../../shared/llmProviders.mjs');

/** subscription: a plan with usage windows; apiKey: pay per use; credits: MoPilot balance; harness: a basic harness signs in and bills on its own. */
const BILLING = ['subscription', 'apiKey', 'credits', 'harness'];

/** cliLogin: the CLI's own sign-in; harnessAuth: a login the harness keeps in a home Sage made; sageKey: a key Sage holds. */
const KINDS = ['cliLogin', 'harnessAuth', 'sageKey'];

// the first-party endpoints are the model provider catalog's (shared/llmProviders.mjs), so the two cannot drift
const PROVIDERS = {
  openai: {
    id: 'openai',
    label: LLM_PROVIDERS.openai.label,
    wires: ['responses'],
    baseUrl: LLM_PROVIDERS.openai.baseUrl,
    firstParty: true,
  },
  // visionFallbackModel: the model that reads screenshots for a text-only model of this provider (computer use)
  anthropic: {
    id: 'anthropic',
    label: LLM_PROVIDERS.anthropic.label,
    wires: ['anthropic'],
    baseUrl: LLM_PROVIDERS.anthropic.baseUrl,
    firstParty: true,
    visionFallbackModel: 'claude-haiku-4-5',
  },
  mopilot: { id: 'mopilot', label: 'MoPilot', wires: ['anthropic', 'responses'], baseUrl: API_BASE, firstParty: false },
  // a model config of the user's own (electron/routing): MoPilot's model router on this Mac sends it to the config's provider
  routed: { id: 'routed', label: 'Your own provider', wires: ['anthropic'], baseUrl: '', firstParty: false },
};

/**
 * The provider behind an endpoint: the first-party one when there is no custom endpoint, else a
 * profile named after the gateway's host (speaking the same wire as `fallback`).
 */
function providerFor(baseUrl, fallback) {
  const own = PROVIDERS[fallback];
  if (!baseUrl) return own;
  // not a URL: the raw value is compared as the host
  const host = URL.canParse(baseUrl) ? new URL(baseUrl).host : baseUrl;
  if (own?.baseUrl && new URL(own.baseUrl).host === host) return own;
  return { id: `custom:${host}`, label: host, wires: own ? [...own.wires] : [], baseUrl, firstParty: false };
}

/** An instance record; `account` is the id the owning module uses for it. */
function instance(o) {
  if (!BILLING.includes(o.billing)) throw new Error(`Unknown billing type ${o.billing}`);
  if (!KINDS.includes(o.kind)) throw new Error(`Unknown instance kind ${o.kind}`);
  return {
    id: `${o.harness}:${o.account}`,
    harness: o.harness,
    account: o.account,
    provider: o.provider,
    kind: o.kind,
    billing: o.billing,
    label: o.label ?? null,
    status: o.status ?? 'ok',
    // out of usage until a reset, as main last saw it
    limited: !!o.limited,
    // when that limit lifts (ms), when main knows it
    ...(o.limited && typeof o.limitedUntil === 'number' ? { limitedUntil: o.limitedUntil } : {}),
    active: !!o.active,
  };
}

class Registry {
  constructor() {
    /** harness id -> AccountDriver */
    this.drivers = new Map();
  }
  register(driver) {
    this.drivers.set(driver.harness, driver);
    return driver;
  }
  driver(harness) {
    return this.drivers.get(harness) || null;
  }
  /** Every instance, or one harness's. */
  instances(harness) {
    const list = harness ? [this.driver(harness)].filter(Boolean) : [...this.drivers.values()];
    return list.flatMap((d) => d.instances());
  }
  get(id) {
    return this.instances().find((i) => i.id === id) || null;
  }
  /** The profiles the instances use, first-party ones first. */
  providers() {
    const seen = new Map();
    for (const i of this.instances()) if (!seen.has(i.provider.id)) seen.set(i.provider.id, i.provider);
    return [...seen.values()].sort((a, b) => Number(b.firstParty) - Number(a.firstParty));
  }
}

module.exports = { Registry, BILLING, KINDS, PROVIDERS, providerFor, instance };
