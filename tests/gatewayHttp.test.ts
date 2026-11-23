// The gateway over a real streamable HTTP MCP server on 127.0.0.1 (the SDK's own server transport), through the real client (electron/gateway/client.cjs connectServer): a bearer token, a user name and password, or a URL parameter reaches the server on every request the gateway makes, a wrong or missing one fails as the server's refusal (B2), and a credential is never filled from the environment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fakeSafe } from './support/momo-fixtures.ts';
import { gatewayDir, tick } from './support/gatewayWorld.ts';
import { httpServer } from './support/gatewayHttpServer.ts';

const require = createRequire(import.meta.url);
const { Gateway } = require('../electron/gateway/service.cjs');

const settled = async () => {
  for (let i = 0; i < 40; i++) await tick();
};

test('bearer, basic and URL-parameter credentials reach the server on every request; tools list and run', async () => {
  const cases = [
    {
      auth: 'bearer',
      credential: { type: 'bearer', token: '${HOME}-tok' },
      ok: (r: any) => r.headers.authorization === 'Bearer ${HOME}-tok',
    },
    {
      auth: 'basic',
      credential: { type: 'basic', username: 'me', password: 'pw' },
      ok: (r: any) => r.headers.authorization === `Basic ${Buffer.from('me:pw').toString('base64')}`,
    },
    {
      auth: 'urlParam',
      credential: { type: 'urlParam', param: 'key', value: 'v 1' },
      ok: (r: any) => new URL(r.url, 'http://x').searchParams.get('key') === 'v 1',
    },
  ];
  for (const c of cases) {
    const h = await httpServer(c.ok);
    const gateway = new Gateway({ dir: gatewayDir(), safeStorage: fakeSafe() });
    const { key } = await gateway.add({ name: 'h', launch: { type: 'http', url: h.url, headers: { 'X-Team': 'core' } }, auth: c.auth });
    await settled();
    assert.equal(gateway.view().servers[0].status, 'needs_credentials', c.auth);
    assert.equal(h.seen.length, 0, 'nothing is sent before it is connected');
    await gateway.connect(key, c.credential);
    const r = gateway.upstreams.get(key);
    assert.equal(r.status, 'ready', `${c.auth}: ${r.error}`);
    const answer = await gateway.upstreams.call(key, r.epoch, 'whoami', {}, { timeout: 5000, maxTotalTimeout: 5000 });
    assert.equal(answer.content[0].text, 'you');
    assert.ok(h.seen.length >= 3);
    assert.ok(
      h.seen.every((s) => c.ok({ headers: { authorization: s.auth }, url: s.url })),
      `${c.auth}: every request carried it`,
    );
    gateway.close();
  }
});

test('B2: a server that refuses the credential fails with its kind only, and a new credential connects it', async () => {
  const h = await httpServer((r) => r.headers.authorization === 'Bearer good');
  const gateway = new Gateway({ dir: gatewayDir(), safeStorage: fakeSafe() });
  const { key } = await gateway.add({ name: 'h', launch: { type: 'http', url: h.url, headers: {} }, auth: 'bearer' });
  await gateway.connect(key, { type: 'bearer', token: 'bad' });
  const row = gateway.view().servers[0];
  assert.equal(row.status, 'failed');
  assert.doesNotMatch(row.error, /bad|unauthorized/);
  await gateway.connect(key, { type: 'bearer', token: 'good' });
  assert.equal(gateway.view().servers[0].status, 'ready');
  gateway.close();
});

test('a server reached with no credential of the gateway’s (MoMo’s servers) gets its configured headers only, filled', async () => {
  const { connectServer } = require('../electron/gateway/client.cjs');
  const h = await httpServer((r) => r.headers['x-team'] === (process.env.HOME ?? ''));
  const client = await connectServer({ type: 'http', url: h.url, headers: { 'X-Team': '${HOME}' } });
  const { tools } = await client.listTools();
  assert.ok(tools.length > 0);
  assert.equal(h.seen[0].auth, undefined);
  await client.close();
});
