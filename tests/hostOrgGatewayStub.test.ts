// The test gateway for organization access (scripts/host-org-idp/gateway-stub.mjs): it takes only a token the IdP signed (RS256 against the JWKS, issuer, audience, expiry), from either header Claude Code's key helper and Codex send, and answers the Anthropic Messages and OpenAI Responses shapes the CLIs read; it never logs a token.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { bearerOf, createGateway, createVerifier, fingerprint } from '../scripts/host-org-idp/gateway-stub.mjs';

const ISSUER = 'http://127.0.0.1:8080/realms/mopilot-test';
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', kty: 'RSA' };
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
const sign = (claims: object, o: { kid?: string; alg?: string; key?: crypto.KeyObject } = {}) => {
  const head = `${b64({ alg: o.alg ?? 'RS256', kid: o.kid ?? 'k1' })}.${b64(claims)}`;
  return `${head}.${crypto.sign('RSA-SHA256', Buffer.from(head), o.key ?? privateKey).toString('base64url')}`;
};
const good = {
  iss: ISSUER,
  aud: ['mopilot-gateway', 'account'],
  exp: Math.floor(Date.now() / 1000) + 3600,
  preferred_username: 'alice',
  sub: 's1',
};

test('the verifier takes only a live token the issuer signed for this audience, and fetches the keys again for a new key id', async () => {
  let fetched = 0;
  const fetch = (async () => (fetched++, { json: async () => ({ keys: [jwk, { kid: 'ec', kty: 'EC' }] }) })) as any;
  const verify = createVerifier({ issuer: ISSUER, audience: 'mopilot-gateway', fetch });
  assert.deepEqual((await verify(sign(good))).ok, true);
  assert.equal((await verify(sign({ ...good, aud: 'mopilot-gateway' }))).ok, true, 'a single audience');
  assert.equal(fetched, 1, 'keys are kept');
  const why = async (t: string) => ((await verify(t)) as any).why;
  assert.equal(await why('abc'), 'not a JWT');
  assert.equal(await why('a.b.c'), 'unreadable');
  assert.equal(await why(sign(good, { alg: 'HS256' })), 'alg');
  assert.equal(await why(sign(good, { kid: 'nope' })), 'unknown key');
  assert.equal(fetched, 2, 'an unknown key id asks again');
  assert.equal(await why(sign(good, { key: other.privateKey })), 'signature');
  assert.equal(await why(sign({ ...good, iss: 'http://evil.test' })), 'issuer');
  assert.equal(await why(sign({ ...good, aud: 'other' })), 'audience');
  assert.equal(await why(sign({ ...good, exp: 1 })), 'expired');
});

test('the gateway answers both APIs as the signed-in person, refuses anything else with 401, and counts what it saw', async (t) => {
  const lines: string[] = [];
  const { server, stats } = createGateway({
    verify: createVerifier({
      issuer: ISSUER,
      audience: 'mopilot-gateway',
      fetch: (async () => ({ json: async () => ({ keys: [jwk] }) })) as any,
    }),
    log: (l: string) => lines.push(l),
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const token = sign(good);
  const call = (p: string, body: unknown, headers: Record<string, string> = { authorization: `Bearer ${token}` }) =>
    fetch(`${url}${p}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const msg = await (await call('/anthropic/v1/messages', { model: 'claude-x' }, { 'x-api-key': token })).json();
  assert.deepEqual([msg.type, msg.content[0].text, msg.stop_reason, msg.model], ['message', 'gateway-ok:alice', 'end_turn', 'claude-x']);
  const streamed = await (await call('/anthropic/v1/messages?beta=true', { stream: true })).text();
  assert.match(streamed, /event: message_start[\s\S]*"text":"gateway-ok:alice"[\s\S]*event: message_stop/);
  assert.deepEqual(await (await call('/anthropic/v1/messages/count_tokens', {})).json(), { input_tokens: 1 });
  const responses = await (await call('/openai/v1/responses', { model: 'gpt-x', stream: true })).text();
  assert.match(responses, /event: response\.created[\s\S]*"delta":"gateway-ok:alice"[\s\S]*event: response\.completed/);
  assert.match(await (await call('/openai/v1/responses', 'not json')).text(), /"model":"stub"/);
  const raw = await fetch(`${url}/openai/v1/responses`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: '{oops' });
  assert.equal(raw.status, 200, 'a body that is not JSON still gets the fixed reply');
  assert.deepEqual(await (await call('/openai/v1/models', undefined)).json(), { data: [], object: 'list' });
  assert.equal((await call('/anthropic/v1/models', undefined)).status, 200);
  assert.equal((await call('/elsewhere', {})).status, 404);
  const refused = await call('/anthropic/v1/messages', {}, { authorization: 'Bearer nope' });
  assert.equal(refused.status, 401);
  assert.match((await refused.json()).error.message, /gateway: not a JWT/);
  assert.equal((await call('/anthropic/v1/messages', {}, {})).status, 401, 'no token at all');
  const counts = await (await fetch(`${url}/stats`)).json();
  assert.deepEqual(
    [counts, stats.accepted],
    [
      { accepted: 9, rejected: 2, bySubject: { alice: 9 }, byWhy: { 'not a JWT': 1, 'no token': 1 }, byToken: { [fingerprint(token)]: 9 } },
      9,
    ],
  );
  assert.ok(
    lines.some((l) => l === `200 POST /anthropic/v1/messages as alice token ${fingerprint(token)}`),
    'a line names the token by its fingerprint',
  );
  assert.match(fingerprint(token), /^[0-9a-f]{8}$/);
  assert.doesNotMatch(lines.join('\n'), new RegExp(token.slice(0, 40)), 'no token in the log');
});

test('a person with no preferred username is named by their subject; a gateway made with no log still serves', async (t) => {
  const { server } = createGateway({ verify: async () => ({ ok: true, claims: { sub: 'subject-only' } }) });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const msg = await (await fetch(`${url}/anthropic/v1/messages`, { method: 'POST', headers: { 'x-api-key': 'x' }, body: '{}' })).json();
  assert.equal(msg.content[0].text, 'gateway-ok:subject-only');
});

test('the bearer comes from Authorization first, else x-api-key, else none', () => {
  assert.equal(bearerOf({ headers: { authorization: 'Bearer abc ', 'x-api-key': 'k' } } as any), 'abc');
  assert.equal(bearerOf({ headers: { authorization: 'Basic x', 'x-api-key': ' k ' } } as any), 'k');
  assert.equal(bearerOf({ headers: {} } as any), '');
});

test('run as a program it needs --issuer, and serves on the port it is given', async () => {
  const script = path.join(import.meta.dirname, '../scripts/host-org-idp/gateway-stub.mjs');
  const run = (args: string[]) => {
    const child = spawn(process.execPath, [script, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    return { child, out: () => out, exit: new Promise<number | null>((r) => child.once('exit', r)) };
  };
  const missing = run([]);
  assert.notEqual(await missing.exit, 0);
  assert.match(missing.out(), /--issuer is required/);
  const port = await new Promise<number>((r) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => r(p));
    });
  });
  const served = run(['--issuer', ISSUER, '--port', String(port)]);
  const end = Date.now() + 5000;
  while (!served.out().includes('gateway stub on') && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  assert.match(served.out(), new RegExp(`gateway stub on http://127.0.0.1:${port}`));
  const stats = await (await fetch(`http://127.0.0.1:${port}/stats`)).json();
  assert.equal(stats.accepted, 0);
  // a refused call is logged by path and reason, never with the token
  await fetch(`http://127.0.0.1:${port}/anthropic/v1/messages`, { method: 'POST', headers: { authorization: 'Bearer nope-dummy' } });
  while (!served.out().includes('401') && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  assert.match(served.out(), /401 POST \/anthropic\/v1\/messages \(not a JWT\) token [0-9a-f]{8}/);
  assert.doesNotMatch(served.out(), /nope-dummy/);
  served.child.kill();
  await served.exit;
});

test('a long turn: with tool turns, a Messages call that offers Bash gets `sleep` until enough tool results came back, then the reply', async (t) => {
  const { server } = createGateway({ verify: async () => ({ ok: true, claims: { sub: 's' } }), toolTurns: 2, toolSleep: 7 });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/anthropic/v1/messages`;
  const tools = [{ name: 'Bash' }];
  const result = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] };
  const post = async (body: unknown) => fetch(url, { method: 'POST', headers: { 'x-api-key': 'k' }, body: JSON.stringify(body) });
  const first = await (await post({ tools, messages: [{ role: 'user', content: 'go' }] })).json();
  assert.deepEqual([first.stop_reason, first.content[0].name, first.content[0].input.command], ['tool_use', 'Bash', 'sleep 7']);
  const streamed = await (await post({ tools, stream: true, messages: [{ role: 'user', content: 'go' }, result] })).text();
  assert.match(streamed, /"type":"tool_use"[\s\S]*input_json_delta[\s\S]*"stop_reason":"tool_use"/);
  const done = await (
    await post({ tools, messages: [{ role: 'user', content: 'go' }, result, result, { role: 'user', content: 'plain' }, null] })
  ).json();
  assert.equal(done.content[0].text, 'gateway-ok:s', 'two tool results: the turn ends');
  // a call that offers no Bash (a title, a summary) is answered at once; one with no messages starts the loop
  assert.equal((await (await post({ tools: [{ name: 'Read' }], messages: [] })).json()).content[0].text, 'gateway-ok:s');
  assert.equal((await (await post({ tools })).json()).stop_reason, 'tool_use');
});
