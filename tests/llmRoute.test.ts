// The model router's translation as the JS calls it (electron/platform/llmRoute.cjs) on the real core (core/crates/llmroute):
// a request and a reply framed across, a stream translator's life, the fixtures' journey, and what a refusal looks like.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { translateRequest, translateResponse, StreamTranslator } = require('../electron/platform/llmRoute.cjs');

const config = { id: 'cfg-1', provider: 'openai', model: 'gpt-4o-mini', baseUrl: 'https://api.openai.com/v1' } as const;
const fixture = (name: string) => fs.readFileSync(new URL(`../core/crates/llmroute/fixtures/${name}`, import.meta.url));

test('a Claude Code request goes out as the OpenAI request the fixture holds, with where and how to send it', async () => {
  const sent = await translateRequest('anthropic', fixture('claude-request.json'), { ...config, cacheKey: 'chat-1f3c' });
  assert.deepEqual(
    { path: sent.path, headers: sent.headers, stream: sent.stream, model: sent.model },
    {
      path: '/chat/completions',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      stream: true,
      model: 'gpt-4o-mini',
    },
  );
  assert.ok(Buffer.isBuffer(sent.body));
  assert.equal(sent.body.toString(), fixture('openai-request.json').toString());
  const again = await translateRequest('anthropic', fixture('claude-request.json'), { ...config, cacheKey: 'chat-1f3c' });
  assert.ok(again.body.equals(sent.body), 'the same turn is the same bytes, so the prompt cache keeps hitting');
});

test('a body given as a string is read the same, and an untranslatable request rejects with why', async () => {
  const sent = await translateRequest('anthropic', JSON.stringify({ max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }), config);
  assert.equal(
    sent.body.toString(),
    '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hi"}],"stream":false,"max_completion_tokens":8}',
  );
  assert.equal(sent.headers.accept, 'application/json');
  await assert.rejects(
    translateRequest('anthropic', '{"messages":[{"role":"user","content":[{"type":"hologram"}]}]}', config),
    /'hologram'/,
  );
  await assert.rejects(translateRequest('gemini', '{}', config), /no inbound wire 'gemini'/);
});

test("a provider's whole reply comes back as an Anthropic message naming the model that answered", async () => {
  const reply = await translateResponse(
    'anthropic',
    '{"id":"chatcmpl-9","model":"gpt-4o-mini-2024-07-18","choices":[{"message":{"role":"assistant","content":"ok"},"finish_reason":"stop"}]}',
    config,
  );
  assert.deepEqual(JSON.parse(reply.toString()), {
    id: 'msg_9',
    type: 'message',
    role: 'assistant',
    model: 'gpt-4o-mini-2024-07-18',
    content: [{ type: 'text', text: 'ok' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  });
  await assert.rejects(translateResponse('anthropic', '<html>502</html>', config), /not a chat completion/);
});

test("a provider's stream, pushed as it arrives, is the event stream the fixture holds, and finishing lets it go", () => {
  const stream = fixture('openai-stream.sse');
  const translator = new StreamTranslator('anthropic', config);
  const heard = [translator.push(stream.subarray(0, 101)), translator.push(stream.subarray(101)), translator.finish()];
  assert.equal(Buffer.concat(heard).toString(), `${fixture('anthropic-stream.sse')}\n`);
  assert.equal(translator.open, false);
  translator.close();
  assert.throws(() => translator.push('data: {}\n\n'), new RegExp(`no stream translator ${translator.id}`));
});

test('a stream given up part way is closed once, and one cut short ends in an error event', () => {
  const abandoned = new StreamTranslator('anthropic', config);
  assert.equal(abandoned.push('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n').toString().includes('"text":"Hi"'), true);
  abandoned.close();
  abandoned.close();
  assert.equal(abandoned.open, false);
  assert.throws(() => abandoned.finish(), /no stream translator/);
  const cut = new StreamTranslator('anthropic', config);
  cut.push('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n');
  assert.match(
    cut.finish().toString(),
    /event: error\ndata: \{"type":"error","error":\{"type":"api_error","message":"The provider's stream ended/,
  );
  assert.throws(() => new StreamTranslator('anthropic', { provider: 'openai' }), /missing field `model`/);
});

test('without the core there is no translation, and it says so', async () => {
  await assert.rejects(translateRequest('anthropic', '{}', config, null), { message: 'The Rust core is missing.' });
  await assert.rejects(translateResponse('anthropic', '{}', config, null), { message: 'The Rust core is missing.' });
  assert.throws(() => new StreamTranslator('anthropic', config, null), { message: 'The Rust core is missing.' });
});
