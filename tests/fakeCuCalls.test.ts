// The fake harnesses' CUCALL parser (fake-cu-calls.mjs) keeps nested JSON whole for one call and for several, inline or on lines of their own (#2460).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callLines, cuCallsOf } from './e2e/fixtures/fake-cu-calls.mjs';
import { callDynamicTools } from './e2e/fixtures/fake-codex-dynamic.mjs';

const nested = { tabId: 3, options: { filter: { kind: 'all' } }, list: [{ a: 1 }] };
const calls = (text: string) => cuCallsOf(text).map(([, tool, json]) => [tool, JSON.parse(json)]);

test('cuCallsOf: one CUCALL line with nested JSON is parsed whole', () => {
  assert.deepEqual(calls(`CUCALL chrome_read_page ${JSON.stringify(nested)}`), [['chrome_read_page', nested]]);
});

test('cuCallsOf: several CUCALL lines with nested JSON run each, in order', () => {
  const text = `CUSTEPS\nCUCALL chrome_navigate ${JSON.stringify({ a: { b: 1 } })}\nCUCALL chrome_read_page ${JSON.stringify(nested)}`;
  assert.deepEqual(calls(text), [
    ['chrome_navigate', { a: { b: 1 } }],
    ['chrome_read_page', nested],
  ]);
});

test('cuCallsOf: with no CUCALL line, the first CUCALL inside a sentence, to its line’s last brace; SUBCUCALL and handoff quotes are not this turn’s', () => {
  assert.deepEqual(calls(`/goal CONTINUE CUCALL computer_click ${JSON.stringify(nested)} SLOW`), [['computer_click', nested]]);
  assert.deepEqual(calls('run SUBCUCALL computer_click {"x":1}'), []);
  assert.deepEqual(calls('<sage-handoff>\nCUCALL computer_click {"x":1}\n</sage-handoff>\nhello'), []);
  // a message from another chat runs the calls its body holds; an unreadable one holds none
  const peer = (payload: string) => `<mopilot-peer-message>\n${payload}\n</mopilot-peer-message>`;
  assert.deepEqual(calls(peer(JSON.stringify({ body: `CUCALL send_message ${JSON.stringify(nested)}` }))), [['send_message', nested]]);
  assert.deepEqual(calls(peer(JSON.stringify({}))), []);
  assert.deepEqual(calls(peer('{not json CUCALL computer_click {"x":1}')), []);
  assert.equal(callLines('MCPCU computer_click {"x":{"y":1}}', 'MCPCU')[0][2], '{"x":{"y":1}}');
});

test('the Codex fake runs one nested-JSON call with its whole arguments', async () => {
  const seen: any[] = [];
  await callDynamicTools({
    text: `CUCALL chrome_read_page ${JSON.stringify(nested)}`,
    rec: {},
    turn: { items: [{ type: 'userMessage' }] },
    threadId: 'chat',
    turnId: 'turn',
    notify: () => {},
    ask: async (_method: string, params: any) => {
      seen.push(params.arguments);
      return { result: { success: true, contentItems: [] } };
    },
  });
  assert.deepEqual(seen, [nested]);
});
