// shared/route.mjs over shared/harnessRoutes.mjs: whether a harness's own config sends it to its vendor or somewhere
// else, from the keys each harness reads and the ones magpie writes (the 2026-10-17 config is the Codex fixture).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HARNESS_ROUTES } from '../shared/harnessRoutes.mjs';
import { classifyRoute, endpointOf, expandPath, matchRouter, resolve, splitRef, withOverlays, ROUTERS } from '../shared/route.mjs';

const docs = (files: Record<string, unknown>, env: Record<string, string> = {}) => ({
  env,
  files: Object.fromEntries(Object.entries(files).map(([id, doc]) => [id, { path: `/home/u/${id}`, doc, error: null }])),
});
const route = (kind: string, files: Record<string, unknown>, env: Record<string, string> = {}) =>
  classifyRoute(HARNESS_ROUTES[kind], docs(files, env));

test('file paths expand an env variable with its fallback and a leading ~', () => {
  assert.equal(expandPath('{env:CODEX_HOME|~/.codex}/config.toml', {}, '/home/u'), '/home/u/.codex/config.toml');
  assert.equal(expandPath('{env:CODEX_HOME|~/.codex}/config.toml', { CODEX_HOME: '/x' }, '/home/u'), '/x/config.toml');
  assert.equal(expandPath('~', {}, '/home/u'), '/home/u');
  assert.equal(expandPath('/etc/a.json', undefined as any, '/home/u'), '/etc/a.json');
});

test('a reference splits at dots outside braces, and env names are whole', () => {
  assert.deepEqual(splitRef('config:providers.{config:models.{config:default_model}.provider}.base_url'), {
    source: 'config',
    segments: ['providers', '{config:models.{config:default_model}.provider}', 'base_url'],
  });
  assert.deepEqual(splitRef('env:OPENAI_BASE_URL'), { source: 'env', segments: ['OPENAI_BASE_URL'] });
});

test('a braced segment is one key even when its value has dots and slashes', () => {
  const d = docs({
    config: {
      default_model: 'magpie/claude-sonnet-5.5',
      models: { 'magpie/claude-sonnet-5.5': { provider: 'magpie' } },
      providers: { magpie: { base_url: 'http://127.0.0.1:3425/v1' } },
    },
  });
  assert.deepEqual(resolve('config:providers.{config:models.{config:default_model}.provider}.base_url', d), {
    value: 'http://127.0.0.1:3425/v1',
    key: 'providers.magpie.base_url',
    source: 'config',
  });
  // unset anywhere along the way, a table where text is wanted, an empty value: no value
  assert.equal(resolve('config:providers.{config:nope}.base_url', d), null);
  assert.equal(resolve('config:providers', d), null);
  assert.equal(resolve('config:default_model.more', d), null);
  assert.equal(resolve('missing:x', d), null);
  assert.equal(resolve('env:X', docs({}, { X: '' })), null);
  assert.equal(resolve('env:X', { files: {} } as any), null);
  assert.deepEqual(resolve('config:n', docs({ config: { n: 3 } })), { value: '3', key: 'n', source: 'config' });
  assert.equal(resolve('config:n', docs({ config: { n: '  ' } })), null);
});

test("Codex's active profile lays its keys over the top level; a file without one is left as it is", () => {
  const info = HARNESS_ROUTES.codex;
  const d = docs({ config: { profile: 'x', model: 'gpt-5.5', profiles: { x: { model: 'claude/claude-opus-5-5' } } } });
  assert.equal(resolve('config:model', withOverlays(info.files, d))?.value, 'claude/claude-opus-5-5');
  const none = docs({ config: { profile: 'y', model: 'gpt-5.5', profiles: { x: {} } } });
  assert.equal(resolve('config:model', withOverlays(info.files, none))?.value, 'gpt-5.5');
  const missing = { env: {}, files: {} };
  assert.deepEqual(withOverlays(info.files, missing).files, {});
});

test('an endpoint is its origin, host and port, loopback or not', () => {
  assert.deepEqual(endpointOf('http://127.0.0.1:3425/backend-api/codex'), {
    origin: 'http://127.0.0.1:3425',
    host: '127.0.0.1',
    port: 3425,
    loopback: true,
  });
  assert.equal(endpointOf('https://api.example.test/v1?key=secret')?.origin, 'https://api.example.test');
  assert.equal(endpointOf('https://api.example.test')?.port, 443);
  assert.equal(endpointOf('http://[::1]:8080')?.loopback, true);
  assert.equal(endpointOf('localhost:3425')?.port, 3425);
  assert.equal(endpointOf('gw.example.test')?.port, 80);
  assert.equal(endpointOf('http://bad host'), null);
});

test('magpie is known by its provider id, its local port or its model prefix', () => {
  const ep = (u: string) => endpointOf(u);
  assert.equal(matchRouter({ provider: 'Magpie', endpoint: null, models: [] })?.id, 'magpie');
  assert.equal(matchRouter({ provider: null, endpoint: ep('http://localhost:3425'), models: [] })?.id, 'magpie');
  assert.equal(matchRouter({ provider: null, endpoint: ep('http://10.0.0.4:3425'), models: [] }), null);
  assert.equal(matchRouter({ provider: null, endpoint: null, models: ['magpie/gpt-5.5'] })?.id, 'magpie');
  assert.equal(matchRouter({ provider: 'openai', endpoint: null, models: ['gpt-5.5'] }, ROUTERS), null);
});

test('Codex as magpie left it on 2026-10-17: routed through magpie, model and every source named', () => {
  const r = route('codex', {
    config: {
      model: 'claude/claude-sonnet-5-5',
      model_provider: 'magpie',
      model_catalog_json: '/home/u/.magpie/codex-catalog.json',
      openai_base_url: 'http://127.0.0.1:3425/backend-api/codex',
      model_providers: { magpie: { base_url: 'http://127.0.0.1:3425/v1', wire_api: 'responses' } },
    },
  });
  assert.equal(r.kind, 'external');
  assert.deepEqual(r.router, { id: 'magpie', label: 'magpie' });
  assert.equal(r.label, 'magpie');
  assert.equal(r.endpoint, 'http://127.0.0.1:3425');
  assert.equal(r.loopback, true);
  assert.equal(r.model, 'claude/claude-sonnet-5-5');
  assert.equal(r.provider, 'magpie');
  assert.equal(r.catalog, '/home/u/.magpie/codex-catalog.json');
  assert.deepEqual(r.reasons, ['router', 'endpoint', 'model']);
  assert.deepEqual(
    r.sources.map((s) => s.key),
    ['model_provider', 'model_providers.magpie.base_url', 'model', 'model_catalog_json'],
  );
  assert.equal(r.file, '/home/u/config');
  assert.equal(r.error, null);
});

test("Codex on OpenAI, or on a provider table with no endpoint of its own (CC Switch's OpenAI mirror), is direct", () => {
  assert.equal(route('codex', { config: { model: 'gpt-5.5' } }).kind, 'direct');
  assert.equal(route('codex', {}).kind, 'direct');
  const mirror = route('codex', {
    config: {
      model: 'gpt-5.5',
      model_provider: 'ccswitch_openai',
      model_providers: { ccswitch_openai: { name: 'OpenAI', requires_openai_auth: true } },
    },
  });
  assert.equal(mirror.kind, 'direct');
  assert.equal(mirror.label, null);
  assert.deepEqual(mirror.sources, []);
  // openai_base_url on OpenAI's own host is still OpenAI
  assert.equal(route('codex', { config: { openai_base_url: 'https://chatgpt.com/backend-api/codex' } }).kind, 'direct');
});

test('another endpoint is named by its host, a local one as a local gateway, a bad one as a custom endpoint', () => {
  const remote = route('codex', { config: { openai_base_url: 'https://api.moonshot.test/v1' } });
  assert.equal(remote.kind, 'external');
  assert.equal(remote.label, 'api.moonshot.test');
  assert.equal(remote.router, null);
  const local = route('codex', { config: { openai_base_url: 'http://127.0.0.1:8080/v1' } });
  assert.equal(local.label, 'local gateway');
  const bad = route('codex', { config: { openai_base_url: 'http://bad host' } });
  assert.equal(bad.label, 'custom endpoint');
  assert.equal(bad.endpoint, null);
  assert.equal(bad.loopback, false);
});

test("a model that isn't the vendor's is a route even on the vendor's endpoint, with no label", () => {
  const r = route('codex', { config: { model: 'claude/claude-sonnet-5-5' } });
  assert.equal(r.kind, 'external');
  assert.deepEqual(r.reasons, ['model']);
  assert.equal(r.label, null);
  assert.equal(r.endpoint, null);
});

test('Claude Code through magpie in settings.json, and the managed file outranking it', () => {
  const r = route('claude', {
    settings: { env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:3425', ANTHROPIC_AUTH_TOKEN: 'secret' }, model: 'gpt-5.5' },
  });
  assert.equal(r.kind, 'external');
  assert.equal(r.label, 'magpie');
  assert.equal(r.model, 'gpt-5.5');
  // the token is never a source: only where requests go and which model
  assert.ok(!r.sources.some((s) => s.key.includes('TOKEN')));
  const managed = route('claude', {
    managed: { env: { ANTHROPIC_BASE_URL: 'https://gw.corp.test' } },
    settings: { env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:3425' } },
  });
  assert.equal(managed.label, 'gw.corp.test');
});

test("Claude Code's own models and aliases are direct; a tier set to another vendor's model is a route", () => {
  for (const model of ['claude-opus-5-5', 'opus', 'sonnet[1m]', 'us.anthropic.claude-sonnet-5-5', 'opusplan'])
    assert.equal(route('claude', { settings: { model } }).kind, 'direct', model);
  const tier = route('claude', { settings: { env: { ANTHROPIC_DEFAULT_HAIKU_MODEL: 'gpt-5.5-mini' } } });
  assert.equal(tier.kind, 'external');
  assert.deepEqual(tier.reasons, ['model']);
  assert.equal(tier.model, null);
  // ANTHROPIC_MODEL from the login shell reaches the CLI too
  assert.equal(route('claude', {}, { ANTHROPIC_MODEL: 'gemini-3-pro' }).kind, 'external');
  assert.equal(route('claude', {}, { ANTHROPIC_MODEL: 'gemini-3-pro' }).file, null);
});

test('a harness that names no vendor hosts treats any endpoint as another one', () => {
  const r = classifyRoute({ files: [], endpoint: ['env:BASE'] }, { env: { BASE: 'https://api.vendor.test' }, files: {} });
  assert.equal(r.kind, 'external');
  assert.deepEqual(r.sources, [{ file: null, key: 'BASE' }]);
});

test('a cloud switch in settings.json is a route to that cloud', () => {
  const r = route('claude', { settings: { env: { CLAUDE_CODE_USE_BEDROCK: '1' } } });
  assert.equal(r.kind, 'external');
  assert.equal(r.cloud, 'Amazon Bedrock');
  assert.equal(r.label, 'Amazon Bedrock');
  assert.deepEqual(r.reasons, ['cloud']);
  assert.equal(route('claude', { settings: { env: { CLAUDE_CODE_USE_BEDROCK: '0' } } }).kind, 'direct');
});

test('ACP harnesses: the keys magpie writes for Gemini, Qwen and Kimi', () => {
  const gemini = route('acp:gemini', {
    dotenv: { GOOGLE_GEMINI_BASE_URL: 'http://127.0.0.1:3425' },
    settings: { model: { name: 'gpt-5.5' } },
  });
  assert.equal(gemini.label, 'magpie');
  assert.equal(gemini.model, 'gpt-5.5');
  assert.equal(route('acp:gemini', { settings: { model: { name: 'gemini-3-pro' } } }).kind, 'direct');
  assert.equal(route('acp:gemini', {}, { GOOGLE_GEMINI_BASE_URL: 'https://generativelanguage.googleapis.com' }).kind, 'direct');
  const qwen = route('acp:qwen', { settings: { model: { name: 'magpie/claude-opus-5-5', baseUrl: 'http://127.0.0.1:3425/v1' } } });
  assert.equal(qwen.label, 'magpie');
  assert.equal(route('acp:qwen', { settings: { model: { name: 'qwen3-coder-plus' } } }).kind, 'direct');
  const kimi = route('acp:kimi', {
    config: {
      default_model: 'magpie/gpt-5.5',
      models: { 'magpie/gpt-5.5': { provider: 'magpie', model: 'gpt-5.5' } },
      providers: { magpie: { base_url: 'http://127.0.0.1:3425/v1' } },
    },
  });
  assert.equal(kimi.label, 'magpie');
  assert.equal(kimi.provider, 'magpie');
  assert.ok(kimi.sources.some((s) => s.key === 'providers.magpie.base_url'));
});

test('multi-provider harnesses: only a known router is a route, never their ordinary provider choice', () => {
  assert.equal(route('acp:goose', { config: { GOOSE_PROVIDER: 'anthropic', GOOSE_MODEL: 'claude-opus-5-5' } }).kind, 'direct');
  const goose = route('acp:goose', { config: { GOOSE_PROVIDER: 'magpie', GOOSE_MODEL: 'gpt-5.5' } });
  assert.equal(goose.kind, 'external');
  assert.deepEqual(goose.reasons, ['router']);
  assert.equal(route('acp:dsh', { settings: { 'agent-default-model': { provider: 'magpie', model: 'gpt-5.5' } } }).label, 'magpie');
  assert.equal(route('acp:opencode', { config: { model: 'magpie/claude-opus-5-5' } }).label, 'magpie');
  assert.equal(route('acp:opencode', { config: { model: 'anthropic/claude-opus-5-5' } }).kind, 'direct');
});

test('a file that cannot be parsed is unknown, never direct, unless another file already shows a route', () => {
  const info = HARNESS_ROUTES.claude;
  const broken = { env: {}, files: { settings: { path: '/home/u/.claude/settings.json', error: "Couldn't read it: Unexpected token" } } };
  const r = classifyRoute(info, broken);
  assert.equal(r.kind, 'unknown');
  assert.equal(r.error, "Couldn't read it: Unexpected token");
  assert.equal(r.file, '/home/u/.claude/settings.json');
  assert.equal(r.label, null);
  const both = {
    env: {},
    files: {
      managed: { path: '/m.json', doc: { env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:3425' } }, error: null },
      settings: { path: '/s.json', error: 'bad' },
    },
  };
  const ext = classifyRoute(info, both);
  assert.equal(ext.kind, 'external');
  assert.equal(ext.error, null);
  assert.equal(ext.file, '/m.json');
});

test('the signature changes with what the route is, not with where it was read or the vendor model picked', () => {
  const a = route('codex', { config: { openai_base_url: 'http://127.0.0.1:3425/a' } });
  const b = route('codex', { config: { openai_base_url: 'http://127.0.0.1:3425/b' } });
  const c = route('codex', { config: { openai_base_url: 'http://127.0.0.1:3426/a' } });
  assert.equal(a.signature, b.signature);
  assert.notEqual(a.signature, c.signature);
  // the CLI's own /model writing another OpenAI model is no route change, so nothing goes stale for it
  assert.equal(route('codex', { config: { model: 'gpt-5.5' } }).signature, route('codex', { config: { model: 'gpt-5.4' } }).signature);
  // the model a gateway serves is part of its route
  const m = (model: string) =>
    route('codex', { config: { model, model_provider: 'magpie', model_providers: { magpie: { base_url: 'http://127.0.0.1:3425/v1' } } } });
  assert.notEqual(m('claude/claude-opus-5-5').signature, m('claude/claude-sonnet-5-5').signature);
});

test('every harness that declares a route declares files, and Copilot and Cursor declare none', () => {
  for (const [kind, info] of Object.entries(HARNESS_ROUTES)) {
    assert.ok(info.files.length > 0, kind);
    assert.ok(info.multiProvider || info.vendorHosts?.length, `${kind} names its vendor's hosts`);
  }
  assert.equal(HARNESS_ROUTES['acp:copilot'], undefined);
  // Claude Code applies settings.json changes in a running CLI; Codex reads config.toml when its app-server starts
  assert.equal(HARNESS_ROUTES.claude.appliesLive, true);
  assert.equal(HARNESS_ROUTES.codex.appliesLive, undefined);
  assert.equal(HARNESS_ROUTES['acp:cursor'], undefined);
});

test('Claude settings layers resolve each tier and cloud variable before deciding the route', () => {
  for (const tier of ['OPUS', 'SONNET', 'HAIKU', 'FABLE']) {
    const key = `ANTHROPIC_DEFAULT_${tier}_MODEL`;
    for (const upper of ['claude-haiku-4-5', ''])
      assert.equal(route('claude', { managed: { env: { [key]: upper } }, settings: { env: { [key]: 'magpie/other' } } }).kind, 'direct');
    assert.equal(route('claude', { managed: { env: {} }, settings: { env: { [key]: 'magpie/other' } } }).kind, 'external');
    const active = route('claude', { managed: { env: { [key]: 'magpie/other' } }, settings: { env: { [key]: 'claude-haiku-4-5' } } });
    assert.equal(active.sources.filter((s) => s.key === `env.${key}`).length, 1);
    assert.equal(active.sources.find((s) => s.key === `env.${key}`)?.file, '/home/u/managed');
  }
  for (const cloud of ['BEDROCK', 'VERTEX', 'FOUNDRY']) {
    const key = `CLAUDE_CODE_USE_${cloud}`;
    for (const upper of ['0', 'false', 'no', 'off', '', false])
      assert.equal(route('claude', { managed: { env: { [key]: upper } }, settings: { env: { [key]: '1' } } }).kind, 'direct');
    for (const upper of ['1', 'true', 'yes', 'on', true])
      assert.equal(route('claude', { managed: { env: { [key]: upper } }, settings: { env: { [key]: '0' } } }).kind, 'external');
  }
  assert.equal(
    route('claude', { managed: { env: { CLAUDE_CODE_USE_BEDROCK: '0' } }, settings: { env: { CLAUDE_CODE_USE_VERTEX: '1' } } }).cloud,
    'Google Vertex AI',
  );
});

test('an empty higher-priority Claude variable masks lower copies but preserves fallback settings', () => {
  assert.equal(
    route('claude', {
      managed: { env: { ANTHROPIC_BASE_URL: '' } },
      settings: { env: { ANTHROPIC_BASE_URL: 'https://gateway.example.test' } },
    }).kind,
    'direct',
  );
  assert.equal(
    route(
      'claude',
      { managed: { env: { ANTHROPIC_MODEL: '' } }, settings: { env: { ANTHROPIC_MODEL: 'magpie/other' }, model: 'claude-haiku-4-5' } },
      { ANTHROPIC_MODEL: 'magpie/shell' },
    ).kind,
    'direct',
  );
  assert.equal(route('claude', { managed: { env: { ANTHROPIC_MODEL: '' } }, settings: { model: 'magpie/fallback' } }).kind, 'external');
});

test('every endpoint-reading harness keeps malformed URL data out of serialized routes', () => {
  const marker = ['DUMMY', 'PRIVATE', 'VALUE'].join('_');
  for (const endpoint of [`http://bad host/path/${marker}?key=${marker}#${marker}`, `http://dummy:${marker}@bad host`]) {
    const cases = {
      codex: { config: { openai_base_url: endpoint } },
      claude: { settings: { env: { ANTHROPIC_BASE_URL: endpoint } } },
      'acp:gemini': { dotenv: { GOOGLE_GEMINI_BASE_URL: endpoint } },
      'acp:qwen': { settings: { model: { baseUrl: endpoint } } },
      'acp:kimi': {
        config: {
          default_model: 'kimi-test',
          models: { 'kimi-test': { provider: 'custom' } },
          providers: { custom: { base_url: endpoint } },
        },
      },
    };
    for (const [kind, files] of Object.entries(cases)) {
      const r = route(kind, files);
      assert.equal(JSON.stringify(r).includes(marker), false, `${kind} serialized route is safe`);
      assert.equal(r.kind, 'external');
      assert.equal(r.endpoint, null);
      assert.equal(r.label, 'custom endpoint');
    }
  }
});

test('precedence groups preserve empty overrides, skip invalid fields and retain scalar forms', () => {
  const d = docs({ config: { empty: '', text: 'value', zero: 0, off: false, bad: [], missing: null } });
  assert.equal(resolve(['config:empty', 'config:text'], d), null);
  assert.equal(resolve(['absent:key', 'config:bad', 'config:text'], d)?.value, 'value');
  assert.equal(resolve(['config:zero', 'config:text'], d)?.value, '0');
  assert.equal(resolve(['config:off', 'config:text'], d)?.value, 'false');
  assert.equal(resolve(['absent:key', 'config:missing'], d), null);
  for (const endpoint of ['file:///private/config', 'data:text/plain,DUMMY', 'ftp://gateway.example.test'])
    assert.equal(endpointOf(endpoint), null);
});

test('an explicit empty environment member masks a lower file value in a precedence group', () => {
  assert.equal(resolve(['env:UPPER', 'config:lower'], docs({ config: { lower: 'shadowed' } }, { UPPER: '' })), null);
  assert.equal(resolve(['env:MISSING', 'config:lower'], docs({ config: { lower: 'fallback' } }))?.value, 'fallback');
});
