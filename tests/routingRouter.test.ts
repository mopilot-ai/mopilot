// The model router (electron/routing/router.cjs, forward.cjs) against a fake upstream on loopback and a fake translator: only a request
// with the secret path and the token gets through; the config's model replaces the request's (a Claude family to its tier model); the
// provider's key goes only to the provider; fallbacks run in order within one deadline; nothing returns the key. Streams are
// routingRouterStream.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
import { KEY, upstream, fakeTranslate, configOf, router, post, auth, ask } from './support/routingRouterKit.ts';

const require = createRequire(import.meta.url);
const { createRouter, estimateTokens } = require('../electron/routing/router.cjs');
const { pickModel, attemptsOf, errorBody } = require('../electron/routing/forward.cjs');

test('only the secret path with the token gets through: another path is not found, another key is refused saying why', async (t) => {
  const up = await upstream(t, { '/chat/completions': (_q, _b, res) => res.end('{"ok":1}') });
  const r = await router(t, { bases: { openai: up.base } });
  const base = r.baseFor('c1');
  const origin = base.split('/').slice(0, 3).join('/');
  const msg = { model: 'claude-sonnet-4-5', messages: [] };
  assert.equal((await post(`${origin}/nope/c/c1/v1/messages`, msg, auth(r))).status, 404);
  assert.equal((await post(`${origin}/${base.split('/')[3]}x/c/c1/v1/messages`, msg, auth(r))).status, 404, 'a longer secret');
  const none = await post(`${base}/v1/messages`, msg);
  assert.equal(none.status, 403, 'no key: the path was this app’s, so it says why (401 is the provider refusing its key)');
  assert.equal(JSON.parse(none.body).error.type, 'permission_error');
  assert.match(JSON.parse(none.body).error.message, /settings\.json may set its own \(env\.ANTHROPIC_AUTH_TOKEN or apiKeyHelper\)/);
  assert.equal((await post(`${base}/v1/messages`, msg, { authorization: 'Bearer wrong' })).status, 403, 'another key');
  assert.equal((await post(`${origin}/${base.split('/')[3]}/x/c1/v1/messages`, msg, auth(r))).status, 404, 'not under /c/');
  const other = await ask(r, msg, 'c1', 'v1/complete');
  assert.equal(other.status, 404);
  assert.deepEqual(JSON.parse(other.body), errorBody(404, "MoPilot's model router answers only Claude Code's /v1/messages."));
  const removed = await ask(r, msg, 'gone');
  assert.equal(removed.status, 404);
  assert.match(JSON.parse(removed.body).error.message, /This model config was removed/);
  assert.equal((await ask(r, 'not json')).status, 400);
  assert.equal((await ask(r, '[1]')).status, 400, 'a body that is not an object');
  // the key also works as x-api-key, the way an SDK given a key sends it
  assert.equal((await post(`${base}/v1/messages`, msg, { 'x-api-key': r.token })).status, 200);
  assert.equal(up.seen.length, 1, 'only the admitted request reached the provider');
  assert.equal(up.seen[0].headers.authorization, `Bearer ${KEY}`, "the provider gets its key, never the router's token");
  const get = await new Promise<number>((resolve) =>
    http.get(`${base}/v1/messages`, { headers: auth(r) }, (res) => (res.resume(), resolve(res.statusCode!))),
  );
  assert.equal(get, 404, 'only POST');
});

test('count_tokens is answered here with an estimate; the provider is not asked', async (t) => {
  const up = await upstream(t, {});
  const r = await router(t, { bases: { openai: up.base } });
  const body = { model: 'x', system: 'be brief', messages: [{ role: 'user', content: 'hello there' }] };
  const reply = await ask(r, body, 'c1', 'v1/messages/count_tokens');
  assert.equal(reply.status, 200);
  assert.deepEqual(JSON.parse(reply.body), { input_tokens: estimateTokens(body) });
  assert.ok(estimateTokens(body) > 0);
  assert.equal(estimateTokens({}), Math.ceil(JSON.stringify(['', [], []]).length / 4));
  assert.equal(up.seen.length, 0);
});

test('the model: one the config names as asked, a Claude family to its tier model, anything else to the config’s model', () => {
  const c = configOf({ model: 'm-main', tierModels: { haiku: 'm-small', opus: 'm-big' } });
  assert.equal(pickModel(c, 'm-small'), 'm-small');
  assert.equal(pickModel(c, 'claude-haiku-4-5-20251001'), 'm-small');
  assert.equal(pickModel(c, 'claude-opus-4-1'), 'm-big');
  assert.equal(pickModel(c, 'claude-sonnet-4-5'), 'm-main', 'a family without a tier model');
  assert.equal(pickModel(c, 'gpt-anything'), 'm-main');
  assert.equal(pickModel(c, undefined), 'm-main');
  const custom = configOf({
    provider: 'custom',
    baseUrl: 'http://localhost:11434/v1',
    fallbacks: [
      { provider: 'custom', model: 'b' },
      { provider: 'openai', model: 'c' },
    ],
  });
  assert.deepEqual(attemptsOf(custom, 'a'), [
    { provider: 'custom', model: 'a', baseUrl: 'http://localhost:11434/v1' },
    { provider: 'custom', model: 'b', baseUrl: 'http://localhost:11434/v1' },
    { provider: 'openai', model: 'c', baseUrl: undefined },
  ]);
});

test('an OpenAI-wire provider: translated there and back, with the config’s model and the provider’s key as a bearer', async (t) => {
  const up = await upstream(t, {
    '/chat/completions': (_q, body, res) => res.end(JSON.stringify({ echo: JSON.parse(body.toString()).model })),
  });
  const r = await router(t, { bases: { openai: up.base }, configs: { c1: configOf({ tierModels: { haiku: 'gpt-mini' } }) } });
  const reply = await ask(r, { model: 'claude-haiku-4-5', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(reply.status, 200);
  assert.equal(reply.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(reply.body), { type: 'message', from: { echo: 'gpt-mini' } });
  assert.equal(JSON.parse(up.seen[0].body.toString()).translated, true);
  assert.equal(up.seen[0].headers.authorization, `Bearer ${KEY}`);
  assert.doesNotMatch(reply.body, new RegExp(KEY));
});

test('an Anthropic provider: the body as sent with the config’s model, its key as x-api-key, beta and version headers kept', async (t) => {
  const up = await upstream(t, {
    '/v1/messages': (_q, body, res) => res.end(JSON.stringify({ type: 'message', model: JSON.parse(body.toString()).model })),
  });
  const r = await router(t, {
    bases: { anthropic: up.base },
    keys: { anthropic: KEY },
    configs: { c1: configOf({ provider: 'anthropic', model: 'claude-own' }) },
  });
  const sent = { model: 'claude-sonnet-4-5', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] };
  const reply = await ask(r, sent, 'c1', 'v1/messages?beta=true', { 'anthropic-beta': 'b1', 'anthropic-version': '2023-06-01' });
  assert.equal(reply.status, 200);
  assert.deepEqual(JSON.parse(reply.body), { type: 'message', model: 'claude-own' });
  const got = up.seen[0];
  assert.equal(got.path, '/v1/messages?beta=true');
  assert.equal(got.headers['x-api-key'], KEY);
  assert.equal(got.headers.authorization, undefined, "the caller's token is not passed on");
  assert.equal(got.headers['anthropic-beta'], 'b1');
  assert.deepEqual(JSON.parse(got.body.toString()), { ...sent, model: 'claude-own' });
  // without the caller's version the router names one
  await ask(r, sent);
  assert.equal(up.seen[1].headers['anthropic-version'], '2023-06-01');
  assert.equal(up.seen[1].headers['anthropic-beta'], undefined);
});

test('B2: fallbacks run in order after a failure, and when all fail the caller hears each one with a status it acts on', async (t) => {
  const up = await upstream(t, {
    '/chat/completions': (_q, body, res) => {
      const model = JSON.parse(body.toString()).model;
      if (model === 'down') return void res.writeHead(500).end(JSON.stringify({ error: { message: `boom with ${KEY}` } }));
      if (model === 'limited') return void res.writeHead(429).end('slow down');
      if (model === 'refused') return void res.writeHead(401).end(JSON.stringify({ error: 'bad key' }));
      if (model === 'blank') return void res.writeHead(503).end();
      res.end(JSON.stringify({ model }));
    },
  });
  const bases = { openai: up.base, deepseek: up.base, openrouter: up.base };
  const keys = { openai: KEY, deepseek: 'sk-ds-0000-test' };
  const fb = (fallbacks: any[], model = 'down') => ({ c1: configOf({ model, fallbacks }) });
  // the first fallback that answers is the reply
  let r = await router(t, {
    bases,
    keys,
    configs: fb([
      { provider: 'openrouter', model: 'nokey' },
      { provider: 'deepseek', model: 'ok-ds' },
    ]),
  });
  const ok = await ask(r, { messages: [] });
  assert.equal(ok.status, 200);
  assert.deepEqual(JSON.parse(ok.body), { type: 'message', from: { model: 'ok-ds' } });
  assert.equal(up.seen.at(-1)!.headers.authorization, 'Bearer sk-ds-0000-test', 'each provider gets its own key');
  // all fail: the last one's status, and every reason
  r = await router(t, {
    bases,
    keys,
    configs: fb([
      { provider: 'gemini', model: 'g' },
      { provider: 'deepseek', model: 'limited' },
    ]),
  });
  const all = await ask(r, { messages: [] });
  assert.equal(all.status, 429);
  const message = JSON.parse(all.body).error.message;
  assert.match(message, /^OpenAI \(down\) answered 500: boom with \[key\] Fallback Google Gemini \(g\): MoPilot can't send/);
  assert.match(message, /Fallback DeepSeek \(limited\) answered 429: slow down$/);
  assert.equal(JSON.parse(all.body).error.type, 'rate_limit_error');
  assert.doesNotMatch(all.body, new RegExp(KEY), 'a key a provider echoes is taken out');
  // a refused key is a refused key (Claude Code says so of the key it runs on); a provider's own trouble is a bad gateway
  r = await router(t, { bases, keys, configs: fb([], 'refused') });
  const refused = await ask(r, { messages: [] });
  assert.equal(refused.status, 401);
  assert.equal(JSON.parse(refused.body).error.type, 'authentication_error');
  assert.equal(JSON.parse(refused.body).error.message, 'OpenAI (refused) answered 401: bad key');
  r = await router(t, { bases, keys, configs: fb([], 'blank') });
  const blank = await ask(r, { messages: [] });
  assert.equal(blank.status, 502);
  assert.deepEqual(JSON.parse(blank.body).error, { type: 'api_error', message: 'OpenAI (blank) answered 503: no reason given' });
  // no key at all, and an unknown provider
  r = await router(t, { bases, keys: {}, configs: { c1: configOf({ fallbacks: [{ provider: 'mistral', model: 'x' }] }) } });
  const none = JSON.parse((await ask(r, { messages: [] })).body).error.message;
  assert.match(none, /there is no key for OpenAI\. Add one in Settings/);
  assert.match(none, /“mistral” is not a provider MoPilot knows\.$/);
});

test('a translation the core refuses is that attempt’s failure, and a reply it can’t read is the provider’s', async (t) => {
  const up = await upstream(t, { '/chat/completions': (_q, _b, res) => res.end('{}') });
  const r = createRouter({
    configs: { get: () => configOf({ fallbacks: [{ provider: 'deepseek', model: 'd' }] }) },
    keys: { get: () => KEY },
    bases: { openai: up.base, deepseek: up.base },
    translate: {
      ...fakeTranslate,
      translateRequest: async (i: string, b: Buffer, c: any) => {
        if (c.model === 'gpt-test') throw new Error('a document by URL is refused');
        return fakeTranslate.translateRequest(i, b, c);
      },
      translateResponse: async () => {
        throw new Error('no choices');
      },
    },
  });
  await r.start();
  t.after(() => r.stop());
  const reply = await ask(r, { messages: [] });
  assert.equal(reply.status, 502);
  assert.equal(
    JSON.parse(reply.body).error.message,
    "OpenAI (gpt-test): a document by URL is refused Fallback DeepSeek (d): its reply couldn't be read (no choices).",
  );
});

test('B2: a provider that can’t be reached is a bad gateway; one cut off mid-reply is that attempt’s failure', async (t) => {
  const up = await upstream(t, {
    '/chat/completions': (_q, _b, res) => {
      res.writeHead(200, { 'content-length': 100 });
      res.write('{"part');
      setTimeout(() => res.destroy(), 20);
    },
  });
  const r = await router(t, {
    bases: { openai: up.base, deepseek: 'http://127.0.0.1:1' },
    keys: { openai: KEY, deepseek: KEY },
    configs: { c1: configOf({ fallbacks: [{ provider: 'deepseek', model: 'd' }] }) },
  });
  const reply = await ask(r, { messages: [] });
  assert.equal(reply.status, 502);
  const message = JSON.parse(reply.body).error.message;
  assert.match(message, /^OpenAI \(gpt-test\): its reply was cut off \(.+\)\. Fallback DeepSeek \(d\): connect ECONNREFUSED/);
});

test('one deadline covers every attempt: a provider that never answers uses it up, and the caller hears so', async (t) => {
  const up = await upstream(t, { '*': () => {} });
  const r = await router(t, {
    bases: { openai: up.base, deepseek: up.base },
    keys: { openai: KEY, deepseek: KEY },
    configs: { c1: configOf({ fallbacks: [{ provider: 'deepseek', model: 'd' }] }) },
    timeouts: { deadline: 150 },
  });
  const at = Date.now();
  const reply = await ask(r, { messages: [] });
  assert.ok(Date.now() - at < 2000, 'bounded by the deadline');
  assert.equal(reply.status, 504);
  assert.equal(JSON.parse(reply.body).error.message, 'OpenAI (gpt-test): it took too long to answer.');
  assert.equal(up.seen.length, 1, 'no time was left for the fallback');
});

test('the router listens once, has no base before it starts or after it stops, and starts again on a new port', async () => {
  const r = createRouter({ configs: { get: () => null }, keys: { get: () => null } });
  assert.equal(r.baseFor('c1'), null);
  const [a, b] = await Promise.all([r.start(), r.start()]);
  assert.equal(a, b);
  assert.match(r.baseFor('c1'), new RegExp(`^${a}/[0-9a-f]{36}/c/c1$`));
  assert.match(r.token, /^[0-9a-f]{48}$/);
  r.stop();
  r.stop();
  assert.equal(r.baseFor('c1'), null);
  await r.start();
  assert.ok(r.baseFor('c1'));
  r.stop();
  // a listen that is stopped, or that fails, can be tried again
  const blocked = createRouter({ configs: { get: () => null }, keys: { get: () => null } });
  const p = blocked.start();
  blocked.stop();
  await assert.rejects(p, /stopped while opening/);
  await blocked.start();
  blocked.stop();
  let fails = 1;
  const flaky = createRouter({
    configs: { get: () => null },
    keys: { get: () => null },
    listen: async (...a: any[]) => {
      if (fails-- > 0) throw new Error('EMFILE');
      return (require('../electron/platform/listenLoopback.cjs').listenLoopback as any)(...a);
    },
  });
  await assert.rejects(flaky.start(), /EMFILE/);
  assert.equal(flaky.baseFor('c1'), null);
  await flaky.start();
  assert.ok(flaky.baseFor('c1'));
  flaky.stop();
});

test('a request too large is refused; one whose caller drops it part way is let go', async (t) => {
  const up = await upstream(t, {});
  const r = await router(t, { bases: { openai: up.base }, bodyMax: 64 });
  const big = await ask(r, { messages: [{ role: 'user', content: 'x'.repeat(200) }] });
  assert.equal(big.status, 413);
  assert.equal(JSON.parse(big.body).error.type, 'request_too_large');
  await new Promise<void>((resolve) => {
    const req = http.request(`${r.baseFor('c1')}/v1/messages`, { method: 'POST', headers: { ...auth(r), 'content-length': 50 } });
    req.on('error', () => resolve());
    req.write('{"mess');
    setTimeout(() => (req.destroy(), resolve()), 30);
  });
  // the router still answers
  assert.equal((await ask(r, { model: 'x', messages: [] }, 'c1', 'v1/messages/count_tokens')).status, 200);
  assert.equal(up.seen.length, 0);
});

test('a provider’s words: its error’s message, its own message, else its text, cut short; https goes over TLS', async (t) => {
  const long = 'z'.repeat(400);
  const up = await upstream(t, {
    '/chat/completions': (_q, body, res) => {
      const model = JSON.parse(body.toString()).model;
      if (model === 'own') return void res.writeHead(400).end(JSON.stringify({ message: 'bad model' }));
      if (model === 'odd') return void res.writeHead(400).end(JSON.stringify({ error: { code: 7 } }));
      res.writeHead(400).end(long);
    },
  });
  const bases = { openai: up.base, deepseek: 'https://127.0.0.1:1' };
  const r = await router(t, {
    bases,
    keys: { openai: KEY, deepseek: KEY },
    configs: {
      own: configOf({ model: 'own' }),
      odd: configOf({ model: 'odd' }),
      long: configOf({ model: 'long', fallbacks: [{ provider: 'deepseek', model: 'd' }] }),
    },
  });
  assert.equal(JSON.parse((await ask(r, { messages: [] }, 'own')).body).error.message, 'OpenAI (own) answered 400: bad model');
  assert.equal(JSON.parse((await ask(r, { messages: [] }, 'odd')).body).error.message, 'OpenAI (odd) answered 400: {"error":{"code":7}}');
  const message = JSON.parse((await ask(r, { messages: [] }, 'long')).body).error.message;
  assert.ok(message.startsWith(`OpenAI (long) answered 400: ${'z'.repeat(300)}… Fallback DeepSeek (d): connect ECONNREFUSED`), message);
});

test('a server of your own: at its own address, with its key when it has one and none when it takes none', async (t) => {
  const up = await upstream(t, { '/v1/chat/completions': (_q, _b, res) => res.end('{}') });
  const own = configOf({ provider: 'custom', baseUrl: `${up.base}/v1`, model: 'llama' });
  const origin = new URL(up.base).origin;
  let r = await router(t, { keys: {}, configs: { c1: own } });
  assert.equal((await ask(r, { messages: [] })).status, 200);
  assert.equal(up.seen[0].path, '/v1/chat/completions');
  assert.equal(up.seen[0].headers.authorization, undefined, 'no key: none sent');
  r = await router(t, { keys: { [`custom:${origin}`]: 'tok-1' }, configs: { c1: own } });
  await ask(r, { messages: [] });
  assert.equal(up.seen[1].headers.authorization, 'Bearer tok-1');
});

test('a whole reply that stops part way until the deadline is a timeout; a core that can’t open a stream is a failure', async (t) => {
  const up = await upstream(t, {
    '/chat/completions': (_q, _b, res) => {
      res.writeHead(200, { 'content-length': 100 });
      res.write('{"part');
    },
  });
  let r = await router(t, { bases: { openai: up.base }, timeouts: { deadline: 120 } });
  const reply = await ask(r, { messages: [] });
  assert.equal(reply.status, 504);
  assert.match(JSON.parse(reply.body).error.message, /^OpenAI \(gpt-test\): its reply was cut off/);
  const broken = {
    ...fakeTranslate,
    StreamTranslator: class {
      constructor() {
        throw new Error('The Rust core is missing');
      }
    },
  };
  r = await router(t, { bases: { openai: up.base }, translate: broken });
  const stream = await ask(r, { stream: true, messages: [] });
  assert.equal(stream.status, 502);
  assert.equal(JSON.parse(stream.body).error.message, 'The Rust core is missing');
});

test('the deadline counts translating too; one used up before any attempt says so; a stalled refusal holds no fallback up', async (t) => {
  const up = await upstream(t, {
    '/chat/completions': (_q, body, res) => {
      const model = JSON.parse(body.toString()).model;
      if (model === 'stalls') return void (res.writeHead(500), res.flushHeaders());
      res.end('{}');
    },
  });
  const slow = {
    ...fakeTranslate,
    translateRequest: async (...a: any[]) => {
      await new Promise((r) => setTimeout(r, 60));
      return (fakeTranslate.translateRequest as any)(...a);
    },
  };
  let r = await router(t, { bases: { openai: up.base }, translate: slow, timeouts: { deadline: 30 } });
  let reply = await ask(r, { messages: [] });
  assert.equal(reply.status, 504);
  assert.equal(JSON.parse(reply.body).error.message, 'OpenAI (gpt-test): it took too long to answer.');
  assert.equal(up.seen.length, 0, 'nothing sent once the deadline passed while translating');
  r = await router(t, { bases: { openai: up.base }, timeouts: { deadline: 0 } });
  assert.equal(JSON.parse((await ask(r, { messages: [] })).body).error.message, 'The providers took too long to answer.');
  r = await router(t, {
    bases: { openai: up.base, deepseek: up.base },
    keys: { openai: KEY, deepseek: KEY },
    configs: { c1: configOf({ model: 'stalls', fallbacks: [{ provider: 'deepseek', model: 'fine' }] }) },
    timeouts: { refusal: 50 },
  });
  const at = Date.now();
  reply = await ask(r, { messages: [] });
  assert.equal(reply.status, 200, 'the fallback answered');
  assert.ok(Date.now() - at < 2000);
});
