// Whole-repository invariant: the provider lists that overlap agree. The model provider catalog (shared/llmProviders.mjs), the keys a Host is lent (shared/host/credentials.mjs KEYED) and the account registry's first-party endpoints (electron/identity/contract/registry.cjs PROVIDERS) name one env, one key slot, one label and one address per provider, and every slot the catalog names is one the shared key store keeps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { LLM_PROVIDERS, listLlmProviders } from '../shared/llmProviders.mjs';
import { KEYED, PROVIDERS as HOST_PROVIDERS } from '../shared/host/credentials.mjs';

const require = createRequire(import.meta.url);
const { PROVIDERS: REGISTRY } = require('../electron/identity/contract/registry.cjs');
const { isSlot } = require('../electron/routing/providerKeys.cjs');

/** The registry's wire names, as the catalog spells them. */
const REGISTRY_WIRE: Record<string, string> = { responses: 'openai-responses', anthropic: 'anthropic' };

test('a provider whose key a Host is also lent keeps it in the Host’s slot, under the Host’s env name', () => {
  const bySlot = new Map<string, string>(Object.values(KEYED).map((k) => [k.provider, k.env]));
  for (const p of listLlmProviders()) {
    if (!bySlot.has(p.keySlot)) continue;
    assert.equal(p.keyEnv, bySlot.get(p.keySlot), `${p.id}: the env name differs from KEYED's`);
  }
  // the env names a provider here and a Host both read are the same key: no two slots share one
  const envs = listLlmProviders()
    .filter((p) => p.keyEnv)
    .map((p) => p.keyEnv);
  assert.equal(new Set(envs).size, envs.length);
  // the providers both tables name (OpenAI, Anthropic, Gemini, DeepSeek) are matched, not listed apart
  assert.deepEqual(
    listLlmProviders()
      .filter((p) => Object.hasOwn(HOST_PROVIDERS, p.keySlot))
      .map((p) => p.id),
    ['openai', 'anthropic', 'gemini', 'deepseek'],
  );
});

test('the registry’s first-party endpoints are the catalog’s: one label, one address, a wire the catalog provider speaks', () => {
  for (const [id, r] of Object.entries<any>(REGISTRY)) {
    if (!r.firstParty) continue;
    const p = LLM_PROVIDERS[id];
    assert.ok(p, `${id} is first-party in the registry but not in the catalog`);
    assert.equal(r.label, p.label, id);
    assert.equal(r.baseUrl, p.baseUrl, id);
    for (const w of r.wires)
      assert.ok((p.wires as readonly string[]).includes(REGISTRY_WIRE[w]), `${id}: the registry's ${w} is not a wire the catalog lists`);
  }
});

test('every slot the catalog names, and every Host provider, is one the shared key store keeps', () => {
  for (const p of listLlmProviders()) if (!p.customBase) assert.equal(isSlot(p.keySlot), true, p.id);
  for (const slot of Object.keys(HOST_PROVIDERS)) assert.equal(isSlot(slot), true, slot);
  assert.equal(isSlot('custom:http://localhost:11434'), true);
  for (const no of ['custom', 'custom:http://localhost:11434/v1', 'custom:http://evil.example', 'mistral', 'other:https://x.example', 7])
    assert.equal(isSlot(no), false, String(no));
});
