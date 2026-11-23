// shared/llmProviders.mjs: the provider catalog's lookups, a user's base URL (https, or http only to this Mac or a private network) and the key slot a key is kept in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LLM_PROVIDERS, WIRES, AUTH_STYLES, llmProvider, listLlmProviders, checkBaseUrl, keySlotFor } from '../shared/llmProviders.mjs';

test('the catalog lists each provider once, in order, frozen, with wires and an auth style it knows', () => {
  assert.deepEqual(
    listLlmProviders().map((p) => p.id),
    ['openai', 'anthropic', 'gemini', 'openrouter', 'deepseek', 'custom'],
  );
  for (const p of listLlmProviders()) {
    assert.equal(Object.isFrozen(p), true);
    assert.equal(Object.isFrozen(p.wires), true);
    assert.ok(p.wires.length > 0 && p.wires.every((w) => WIRES.includes(w)), p.id);
    assert.ok(AUTH_STYLES.includes(p.auth), p.id);
    // a provider at a fixed address has one; a server the user names has none
    assert.equal(p.baseUrl === null, p.customBase, p.id);
    if (p.baseUrl) assert.equal(checkBaseUrl(p.baseUrl).ok, true, p.id);
  }
  assert.equal(llmProvider('openai'), LLM_PROVIDERS.openai);
  assert.equal(llmProvider('mistral'), null);
  assert.equal(llmProvider('toString'), null, 'not an inherited property');
  assert.equal(llmProvider(7), null);
});

test('a base URL is https, or http to this Mac or a private network; normalised without a trailing slash', () => {
  const ok = (v: string) => {
    const r = checkBaseUrl(v);
    assert.equal(r.ok, true, v);
    return r as { ok: true; url: string; origin: string };
  };
  assert.deepEqual(ok(' https://llm.example.com/v1/ '), { ok: true, url: 'https://llm.example.com/v1', origin: 'https://llm.example.com' });
  assert.equal(ok('https://llm.example.com').url, 'https://llm.example.com');
  for (const local of [
    'http://localhost:11434/v1',
    'http://box.local:8000',
    'http://127.0.0.1:8000/v1',
    'http://[::1]:8000',
    'http://10.0.0.5',
    'http://192.168.1.20:8000',
    'http://172.16.0.1',
    'http://172.31.255.255',
  ])
    ok(local);
  const refused = (v: unknown) => {
    const r = checkBaseUrl(v);
    assert.equal(r.ok, false, String(v));
    return (r as { error: string }).error;
  };
  for (const remote of [
    'http://llm.example.com',
    'http://ollama.localhost',
    'http://172.32.0.1',
    'http://8.8.8.8',
    'ftp://localhost',
    'file:///etc/passwd',
  ])
    assert.match(refused(remote), /https/);
  for (const leaky of [
    'https://u:p@x.example',
    'https://u@x.example',
    'https://x.example/?a=1',
    'https://x.example/#f',
    'https://x.example/?',
    'https://x.example/#',
  ])
    assert.match(refused(leaky), /user name, password, query or fragment/);
  for (const none of ['', '   ', 'not a url', 7, null, undefined, `https://x.example/${'a'.repeat(500)}`])
    assert.match(refused(none), /Enter the server/);
});

test('a named provider keeps its key in its own slot; a server the user names keeps one per origin', () => {
  assert.equal(keySlotFor('openai'), 'openai');
  assert.equal(keySlotFor('gemini'), 'google', 'the Host’s Gemini key');
  assert.equal(keySlotFor('anthropic', 'https://ignored.example'), 'anthropic', 'a named provider’s address is its own');
  assert.equal(keySlotFor('custom', 'http://localhost:11434/v1'), 'custom:http://localhost:11434');
  assert.equal(
    keySlotFor('custom', 'http://localhost:11434/other'),
    'custom:http://localhost:11434',
    'one key per server, whatever the path',
  );
  assert.notEqual(keySlotFor('custom', 'http://localhost:8000'), keySlotFor('custom', 'http://localhost:11434'));
  assert.equal(keySlotFor('custom'), null);
  assert.equal(keySlotFor('custom', 'http://evil.example'), null);
  assert.equal(keySlotFor('mistral'), null);
});
