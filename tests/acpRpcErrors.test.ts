// An ACP agent's error answer keeps the reason it gave in `data` (electron/harness/acp/rpc.cjs agentErrorText):
// real agents answer "Internal error" and say why only there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { RpcPeer, agentErrorText, DETAIL_MAX } = require('../electron/harness/acp/rpc.cjs');
const { isAuthError } = require('../electron/harness/acp/signin.cjs');

/** A peer whose agent answers every request with `error`. */
function peerAnswering(error: unknown) {
  const input = new PassThrough();
  const output = new PassThrough();
  output.setEncoding('utf8');
  output.on('data', (line: string) => {
    const { id } = JSON.parse(line);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id, error })}\n`);
  });
  return new RpcPeer({ input, output, onRequest: async () => null });
}

test('a request the agent fails rejects with the reason in its data, its code and data kept', async () => {
  // Qwen Code 0.25.2's authenticate without OPENAI_API_KEY, as observed
  const qwen = { code: -32603, message: 'Internal error', data: { details: "Missing API key for openai auth. Set 'OPENAI_API_KEY'." } };
  await assert.rejects(peerAnswering(qwen).request('authenticate', { methodId: 'openai' }), (e: any) => {
    assert.equal(e.message, "Internal error: Missing API key for openai auth. Set 'OPENAI_API_KEY'.");
    assert.equal(e.code, -32603);
    assert.deepEqual(e.data, qwen.data);
    assert.equal(e.said, 'Internal error');
    return true;
  });
  // Goose 1.54.0's session/new with no provider: the reason is the data string
  const goose = { code: -32603, message: 'Internal error', data: 'Failed to resolve provider: GOOSE_PROVIDER' };
  await assert.rejects(peerAnswering(goose).request('session/new', {}), {
    message: 'Internal error: Failed to resolve provider: GOOSE_PROVIDER',
  });
});

test('the reason: data string, details or message; a detail that repeats the message is not doubled', () => {
  assert.equal(agentErrorText({ message: 'Internal error', data: 'boom' }), 'Internal error: boom');
  assert.equal(agentErrorText({ message: 'Internal error', data: { details: 'no key' } }), 'Internal error: no key');
  // Cursor's: the detail starts with the message and says more
  assert.equal(
    agentErrorText({ message: 'Authentication required', data: { message: "Authentication required. Run 'agent login' first." } }),
    "Authentication required. Run 'agent login' first.",
  );
  assert.equal(agentErrorText({ message: 'Not logged in: run kimi login', data: 'kimi login' }), 'Not logged in: run kimi login');
  assert.equal(agentErrorText({ message: 'Authentication required', data: { authMethods: [] } }), 'Authentication required');
  assert.equal(agentErrorText({ message: 'Bad', data: '  ' }), 'Bad');
  assert.equal(agentErrorText({ message: 'Bad' }), 'Bad');
  assert.equal(agentErrorText({ message: '', data: null }), 'error');
  assert.equal(agentErrorText({ code: 1 }), 'error');
  assert.equal(agentErrorText(undefined), 'error');
});

test("a sign-in is read from the agent's own words, not from a detail that may be a tool's", async () => {
  const tool = { code: -32603, message: 'Internal error', data: 'MCP server github: authentication required' };
  await assert.rejects(peerAnswering(tool).request('session/prompt', {}), (e: any) => {
    assert.equal(e.message, 'Internal error: MCP server github: authentication required');
    assert.equal(isAuthError(e), false);
    return true;
  });
  await assert.rejects(peerAnswering({ code: 1, message: 'Not logged in', data: 'x' }).request('session/new', {}), (e: any) =>
    isAuthError(e),
  );
  // an error made here (no agent message apart) is read as it is
  assert.equal(isAuthError(new Error('Login required')), true);
});

test('only the first line of a long detail is shown, cut at a whole character', () => {
  assert.equal(
    agentErrorText({ message: 'Internal error', data: '\n  panic: no provider  \n  at main.rs:1\n' }),
    'Internal error: panic: no provider',
  );
  const long = `${'x'.repeat(DETAIL_MAX - 1)}😀tail`;
  assert.equal(agentErrorText({ message: 'E', data: long }), `E: ${'x'.repeat(DETAIL_MAX - 1)}😀…`);
});
