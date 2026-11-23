// The model router's streamed replies (electron/routing/forward.cjs streamReply) against a fake upstream on loopback: translated as they
// arrive, or passed through from an Anthropic provider; a stream that stalls, pings without getting further or drops ends in an error
// event the chat shows, and one that fails before saying anything falls back; a caller that leaves stops the provider.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
import { KEY, upstream, fakeTranslate, configOf, router, auth, ask, type Handler } from './support/routingRouterKit.ts';

const require = createRequire(import.meta.url);
const { createRouter } = require('../electron/routing/router.cjs');
const { pingOnly, errorBody } = require('../electron/routing/forward.cjs');

/** An SSE handler that writes `chunks` with `gap` ms between them, then ends (or not). */
const sse =
  (chunks: string[], o: { gap?: number; end?: boolean; drop?: boolean } = {}): Handler =>
  (_q, _b, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.flushHeaders();
    let i = 0;
    const next = () => {
      if (res.destroyed) return;
      if (i < chunks.length) {
        res.write(chunks[i++]);
        return void setTimeout(next, o.gap ?? 5);
      }
      if (o.drop) res.destroy();
      else if (o.end !== false) res.end();
    };
    next();
  };
const stream = (r: any, id = 'c1') => ask(r, { stream: true, messages: [] }, id);

test('a stream is translated as it arrives and finished by the translator', async (t) => {
  fakeTranslate.StreamTranslator.made = [];
  const up = await upstream(t, { '/chat/completions': sse(['data: a\n\n', ': keep-alive\n\n', 'data: b\n\n']) });
  const r = await router(t, { bases: { openai: up.base } });
  const reply = await stream(r);
  assert.equal(reply.status, 200);
  assert.equal(reply.headers['content-type'], 'text/event-stream');
  assert.equal(reply.body, 'event: t\ndata: data: a\n\nevent: t\ndata: data: b\n\nevent: message_stop\ndata: {}\n\n');
  assert.equal(fakeTranslate.StreamTranslator.made[0].finished, true);
  assert.equal(fakeTranslate.StreamTranslator.made[0].config.model, 'gpt-test');
});

test('an Anthropic stream passes through as it is', async (t) => {
  const events = ['event: message_start\ndata: {}\n\n', 'event: ping\ndata: {"type": "ping"}\n\n', 'event: message_stop\ndata: {}\n\n'];
  const up = await upstream(t, { '/v1/messages': sse(events) });
  const r = await router(t, {
    bases: { anthropic: up.base },
    keys: { anthropic: KEY },
    configs: { c1: configOf({ provider: 'anthropic' }) },
  });
  const reply = await stream(r);
  assert.equal(reply.status, 200);
  assert.equal(reply.body, events.join(''));
});

test('B5: a stream that goes quiet after it started ends in an error event the chat shows; so does one that only pings', async (t) => {
  const quiet = { quiet: 120 };
  // silence after the first event
  let up = await upstream(t, { '/chat/completions': sse(['data: a\n\n'], { end: false }) });
  let r = await router(t, { bases: { openai: up.base }, timeouts: quiet });
  let reply = await stream(r);
  assert.equal(reply.status, 200);
  assert.match(reply.body, /^event: t\ndata: data: a\n\nevent: error\ndata: /);
  const err = JSON.parse(reply.body.split('event: error\ndata: ')[1]);
  assert.deepEqual(err, errorBody(502, 'OpenAI (gpt-test): it sent nothing further for 0 seconds, so the reply was stopped.'));
  // an Anthropic provider that keeps pinging, never getting further: still no progress
  const pings = Array.from({ length: 60 }, () => 'event: ping\ndata: {"type": "ping"}\n\n');
  up = await upstream(t, { '/v1/messages': sse(['event: message_start\ndata: {}\n\n', ...pings], { gap: 10 }) });
  r = await router(t, {
    bases: { anthropic: up.base },
    keys: { anthropic: KEY },
    configs: { c1: configOf({ provider: 'anthropic' }) },
    timeouts: quiet,
  });
  const at = Date.now();
  reply = await stream(r);
  assert.ok(Date.now() - at < 550, 'stopped at the quiet limit, not after every ping');
  assert.match(reply.body, /event: error\ndata: .*sent nothing further/);
  // keep-alive comments through a translator are no progress either
  const comments = Array.from({ length: 60 }, () => ': OPENROUTER PROCESSING\n\n');
  up = await upstream(t, { '/chat/completions': sse(['data: a\n\n', ...comments], { gap: 10 }) });
  r = await router(t, { bases: { openai: up.base }, timeouts: quiet });
  reply = await stream(r);
  assert.match(reply.body, /event: error\ndata: .*sent nothing further/);
});

test('B5, B2: a stream that fails before it said anything falls back; once started, a drop ends in an error event', async (t) => {
  const up = await upstream(t, {
    '/chat/completions': (q, body, res) => {
      const model = JSON.parse(body.toString()).model;
      if (model === 'silent') return sse([], { end: false })(q, body, res);
      if (model === 'empty') return sse([])(q, body, res);
      if (model === 'drops') return sse(['data: a\n\n'], { drop: true })(q, body, res);
      return sse(['data: ok\n\n'])(q, body, res);
    },
  });
  const bases = { openai: up.base, deepseek: up.base };
  const keys = { openai: KEY, deepseek: KEY };
  let r = await router(t, {
    bases,
    keys,
    timeouts: { quiet: 80 },
    configs: {
      c1: configOf({
        model: 'silent',
        fallbacks: [
          { provider: 'deepseek', model: 'empty' },
          { provider: 'deepseek', model: 'fine' },
        ],
      }),
    },
  });
  let reply = await stream(r);
  assert.equal(reply.status, 200);
  assert.equal(reply.body, 'event: t\ndata: data: ok\n\nevent: message_stop\ndata: {}\n\n');
  r = await router(t, { bases, keys, configs: { c1: configOf({ model: 'empty' }) } });
  reply = await stream(r);
  assert.equal(reply.status, 502);
  assert.equal(JSON.parse(reply.body).error.message, 'OpenAI (empty): its stream ended without a reply.');
  r = await router(t, { bases, keys, configs: { c1: configOf({ model: 'drops', fallbacks: [{ provider: 'deepseek', model: 'fine' }] }) } });
  reply = await stream(r);
  assert.equal(reply.status, 200);
  assert.match(reply.body, /^event: t\ndata: data: a\n\nevent: error\ndata: .*OpenAI \(drops\): its stream broke off/);
  assert.equal(up.seen.filter((s) => JSON.parse(s.body.toString()).model === 'fine').length, 1, 'a started reply never falls back');
});

test('a stream the translator can’t read ends there', async (t) => {
  const up = await upstream(t, { '/chat/completions': sse(['data: a\n\n', 'data: bad\n\n']) });
  const r = createRouter({
    configs: { get: () => configOf() },
    keys: { get: () => KEY },
    bases: { openai: up.base },
    translate: {
      ...fakeTranslate,
      StreamTranslator: class extends fakeTranslate.StreamTranslator {
        push(b: Buffer) {
          if (b.toString().includes('bad')) throw new Error(`unreadable ${KEY}`);
          return super.push(b);
        }
      },
    },
  });
  await r.start();
  t.after(() => r.stop());
  const reply = await stream(r);
  assert.match(reply.body, /event: error\ndata: .*its stream couldn't be read \(unreadable \[key\]\)/);
});

test('a caller that leaves stops the provider’s reply', async (t) => {
  let closed: () => void;
  const gone = new Promise<void>((r) => (closed = r));
  const up = await upstream(t, {
    '/chat/completions': (_q, _b, res) => {
      res.writeHead(200);
      res.write('data: a\n\n');
      res.on('close', () => closed());
    },
  });
  const r = await router(t, { bases: { openai: up.base } });
  await new Promise<void>((resolve) => {
    const req = http.request(`${r.baseFor('c1')}/v1/messages`, { method: 'POST', headers: auth(r) }, (res) => {
      res.once('data', () => (req.destroy(), resolve()));
    });
    req.end(JSON.stringify({ stream: true, messages: [] }));
  });
  await gone;
  // and a caller that leaves before any provider answered stops there too
  const stalled = await upstream(t, { '*': () => {} });
  const r2 = await router(t, {
    bases: { openai: stalled.base, deepseek: stalled.base },
    keys: { openai: KEY, deepseek: KEY },
    configs: { c1: configOf({ fallbacks: [{ provider: 'deepseek', model: 'd' }] }) },
  });
  const req = http.request(`${r2.baseFor('c1')}/v1/messages`, { method: 'POST', headers: auth(r2) });
  req.on('error', () => {});
  req.end(JSON.stringify({ messages: [] }));
  while (stalled.seen.length === 0) await new Promise((res) => setTimeout(res, 5));
  req.destroy();
  await new Promise((res) => setTimeout(res, 50));
  assert.equal(stalled.seen.length, 1, 'no fallback is tried for a caller that left');
  // and with no fallback, the caller that left is sent nothing
  const only = await router(t, { bases: { openai: stalled.base } });
  const alone = http.request(`${only.baseFor('c1')}/v1/messages`, { method: 'POST', headers: auth(only) });
  alone.on('error', () => {});
  alone.end(JSON.stringify({ messages: [] }));
  while (stalled.seen.length === 1) await new Promise((res) => setTimeout(res, 5));
  alone.destroy();
  await new Promise((res) => setTimeout(res, 50));
});

test('a translator that can’t finish the reply ends it in an error event', async (t) => {
  const up = await upstream(t, { '/chat/completions': sse(['data: a\n\n']) });
  const r = await router(t, {
    bases: { openai: up.base },
    translate: {
      ...fakeTranslate,
      StreamTranslator: class extends fakeTranslate.StreamTranslator {
        finish(): any {
          throw new Error('lost the stream');
        }
      },
    },
  });
  const reply = await stream(r);
  assert.equal(reply.status, 200);
  assert.match(reply.body, /^event: t\ndata: data: a\n\nevent: error\ndata: .*its stream couldn't be finished \(lost the stream\)/);
});

test('pings and comments are no progress; anything else is', () => {
  assert.equal(pingOnly(Buffer.from('event: ping\ndata: {"type": "ping"}\n\n')), true);
  assert.equal(pingOnly(Buffer.from(': keep-alive\n\n')), true);
  assert.equal(pingOnly(Buffer.from('event: content_block_delta\ndata: {}\n\n')), false);
  assert.equal(pingOnly(Buffer.from('event: pi')), true, 'a line still arriving says nothing yet');
  assert.deepEqual(errorBody(413, 'big').error.type, 'request_too_large');
  assert.deepEqual(errorBody(404, 'x').error.type, 'not_found_error');
  assert.deepEqual(errorBody(400, 'x').error.type, 'invalid_request_error');
});

test('an Anthropic provider’s pings before its reply are held: one that then fails falls back; one that answers sends them with it', async (t) => {
  const ping = 'event: ping\ndata: {"type": "ping"}\n\n';
  const up = await upstream(t, {
    '/v1/messages': (q, body, res) => {
      const model = JSON.parse(body.toString()).model;
      if (model === 'pings') return sse([ping, ping], { drop: true })(q, body, res);
      sse([ping, 'event: message_start\ndata: {}\n\n', 'event: message_stop\ndata: {}\n\n'])(q, body, res);
    },
  });
  const r = await router(t, {
    bases: { anthropic: up.base },
    keys: { anthropic: KEY },
    configs: { c1: configOf({ provider: 'anthropic', model: 'pings', fallbacks: [{ provider: 'anthropic', model: 'fine' }] }) },
  });
  const reply = await stream(r);
  assert.equal(reply.status, 200);
  assert.equal(reply.body, `${ping}event: message_start\ndata: {}\n\nevent: message_stop\ndata: {}\n\n`, 'only the fallback’s reply');
});

test('a stream the deadline cuts before it said anything is a timeout', async (t) => {
  const up = await upstream(t, { '/chat/completions': sse([], { end: false }) });
  const r = await router(t, { bases: { openai: up.base }, timeouts: { deadline: 80 } });
  const reply = await stream(r);
  assert.equal(reply.status, 504);
  assert.equal(JSON.parse(reply.body).error.message, 'OpenAI (gpt-test): it took too long to answer.');
});

test('a caller that leaves while its request is translated sends nothing to the provider', async (t) => {
  const up = await upstream(t, {});
  let release: () => void = () => {};
  const translating = new Promise<void>((r) => (release = r));
  let asked: () => void = () => {};
  const started = new Promise<void>((r) => (asked = r));
  const r = await router(t, {
    bases: { openai: up.base },
    translate: {
      ...fakeTranslate,
      translateRequest: async (...a: any[]) => {
        asked();
        await translating;
        return (fakeTranslate.translateRequest as any)(...a);
      },
    },
  });
  const req = http.request(`${r.baseFor('c1')}/v1/messages`, { method: 'POST', headers: auth(r) });
  req.on('error', () => {});
  req.end(JSON.stringify({ messages: [] }));
  await started;
  req.destroy();
  await new Promise((res) => setTimeout(res, 30));
  release();
  await new Promise((res) => setTimeout(res, 30));
  assert.equal(up.seen.length, 0);
});

test('a provider that keeps sending a refusal, or a reply past its limit, is let go with the attempt', async (t) => {
  let closed = 0;
  const up = await upstream(t, {
    '/chat/completions': (_q, _b, res) => {
      res.writeHead(500);
      const timer = setInterval(() => res.write('x'.repeat(16 * 1024)), 2);
      res.on('close', () => (clearInterval(timer), closed++));
    },
  });
  const r = await router(t, { bases: { openai: up.base } });
  const reply = await ask(r, { messages: [] });
  assert.equal(reply.status, 502);
  assert.match(JSON.parse(reply.body).error.message, /^OpenAI \(gpt-test\) answered 500: x+…$/);
  while (!closed) await new Promise((res) => setTimeout(res, 5));
});

test('a ping cut in two before the reply is still a ping; a reply whose last event only the translator’s end gives is a reply', async (t) => {
  const up = await upstream(t, {
    '/v1/messages': (q, body, res) => {
      const model = JSON.parse(body.toString()).model;
      if (model === 'split') return sse(['event: pi', 'ng\ndata: {"type": "ping"}\n\n'], { drop: true })(q, body, res);
      sse(['event: message_start\ndata: {}\n\n'])(q, body, res);
    },
    '/chat/completions': sse(['data: whole']),
  });
  let r = await router(t, {
    bases: { anthropic: up.base },
    keys: { anthropic: KEY },
    configs: { c1: configOf({ provider: 'anthropic', model: 'split', fallbacks: [{ provider: 'anthropic', model: 'fine' }] }) },
  });
  let reply = await stream(r);
  assert.equal(reply.body, 'event: message_start\ndata: {}\n\n', 'the split ping started nothing: the fallback answered');
  const finishing = {
    ...fakeTranslate,
    StreamTranslator: class extends fakeTranslate.StreamTranslator {
      push(): any {
        return Buffer.alloc(0);
      }
      finish(): any {
        return Buffer.from('event: message_start\ndata: {}\n\nevent: message_stop\ndata: {}\n\n');
      }
    },
  };
  r = await router(t, { bases: { openai: up.base }, translate: finishing });
  reply = await stream(r);
  assert.equal(reply.status, 200);
  assert.equal(reply.body, 'event: message_start\ndata: {}\n\nevent: message_stop\ndata: {}\n\n');
});
