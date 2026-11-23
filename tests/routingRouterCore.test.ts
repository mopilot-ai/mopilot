// The model router (electron/routing/router.cjs) through the real Rust core's translation (core/crates/llmroute), to a fake OpenAI
// upstream: Claude Code's request reaches the provider as the core translates it, the same bytes from two routers (two app runs) so
// the provider's prompt cache keeps hitting (B8), and the reply comes back in Anthropic's wire naming the model that answered with its
// usage, so the request ledger prices it, streamed or whole.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createRouter } = require('../electron/routing/router.cjs');

const fixture = (name: string) => fs.readFileSync(new URL(`../core/crates/llmroute/fixtures/${name}`, import.meta.url));
const KEY = 'sk-dummy-0000-test-key-abcd';

async function provider(t: any) {
  const bodies: Buffer[] = [];
  const server = http.createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on('data', (d) => parts.push(d));
    req.on('end', () => {
      const body = Buffer.concat(parts);
      bodies.push(body);
      if (JSON.parse(body.toString()).stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        // cut anywhere: the translator holds a partial event until it completes
        const sse = fixture('openai-stream.sse');
        res.write(sse.subarray(0, 37));
        res.end(sse.subarray(37));
      } else
        res.end(
          JSON.stringify({
            id: 'chatcmpl-1',
            object: 'chat.completion',
            model: 'gpt-4o-mini-2024-07-18',
            choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
          }),
        );
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  t.after(() => server.close());
  return { bodies, base: `http://127.0.0.1:${(server.address() as any).port}/v1` };
}

async function router(t: any, base: string) {
  const r = createRouter({
    configs: { get: () => ({ id: 'c1', name: 'Work', provider: 'openai', model: 'gpt-4o-mini', tierModels: {}, fallbacks: [] }) },
    keys: { get: () => KEY },
    bases: { openai: base },
  });
  await r.start();
  t.after(() => r.stop());
  return r;
}

function post(r: any, body: Buffer | string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      `${r.baseFor('c1')}/v1/messages`,
      { method: 'POST', headers: { authorization: `Bearer ${r.token}` } },
      (res) => {
        const parts: Buffer[] = [];
        res.on('data', (d) => parts.push(d));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(parts).toString() }));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

/** An Anthropic stream's events by name, with their data. */
const events = (text: string) =>
  text
    .split('\n\n')
    .filter(Boolean)
    .map((e) => ({ event: /^event: (.+)$/m.exec(e)?.[1], data: JSON.parse(/^data: (.+)$/m.exec(e)?.[1] ?? 'null') }));

test('B8: a Claude Code stream reaches the provider as the same bytes from two routers, and comes back naming the model and its usage', async (t) => {
  const up = await provider(t);
  const a = await router(t, up.base);
  const b = await router(t, up.base);
  const first = await post(a, fixture('claude-request.json'));
  await post(b, fixture('claude-request.json'));
  assert.equal(first.status, 200);
  assert.ok(up.bodies[0].equals(up.bodies[1]), 'two routers send the same prefix');
  assert.equal(JSON.parse(up.bodies[0].toString()).model, 'gpt-4o-mini', "the config's model, not the request's");
  const out = events(first.body);
  assert.equal(out[0].event, 'message_start');
  assert.equal(out[0].data.message.model, 'gpt-4o-mini-2024-07-18', 'the model that answered, for the ledger to price');
  const delta = out.find((e) => e.event === 'message_delta')!;
  assert.ok(delta.data.usage.output_tokens > 0);
  assert.equal(out.at(-1)!.event, 'message_stop');
  assert.doesNotMatch(first.body, new RegExp(KEY));
});

test('a whole reply comes back as an Anthropic message with the model that answered and its usage', async (t) => {
  const up = await provider(t);
  const r = await router(t, up.base);
  const reply = await post(r, JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }));
  assert.equal(reply.status, 200);
  const msg = JSON.parse(reply.body);
  assert.equal(msg.type, 'message');
  assert.equal(msg.model, 'gpt-4o-mini-2024-07-18');
  assert.deepEqual([msg.usage.input_tokens, msg.usage.output_tokens], [12, 3]);
  assert.deepEqual(msg.content, [{ type: 'text', text: 'hi' }]);
});
