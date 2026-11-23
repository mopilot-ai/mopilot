// Claude MCP bridge contracts: explicit account/folder routing and safe validated settings projection.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fakes, load, fakeBin, tmp, lastQuery } from './support/electron-claude.ts';

const bin = fakeBin('mcp-login/claude');
test('MCP sign-in returns an account-scoped command; mutations keep the selected project', async () => {
  const t = load();
  const spec = await t.call('claude:mcpLoginCommand', bin, 'plugin:stripe:stripe', 'default');
  assert.deepEqual(spec, { command: [bin, 'mcp', 'login', 'plugin:stripe:stripe'], env: { CLAUDE_CONFIG_DIR: null } });
  await assert.rejects(t.call('claude:mcpLoginCommand', bin, '', null), /Invalid MCP/);
  await assert.rejects(t.call('claude:mcpLoginCommand', '/missing/bin', 'stripe', null), /not installed/);
  await assert.rejects(t.call('claude:mcpLoginCommand', bin, 'stripe', 'default', 'apiKey'), /authentication mode changed/);
  assert.deepEqual((await t.call('claude:mcpLoginCommand', bin, 'stripe', 'default', 'subscription')).command, [
    bin,
    'mcp',
    'login',
    'stripe',
  ]);
  await assert.rejects(t.call('claude:mcp', bin, ['mcp', 'remove', 'x'], 'default', tmp, 'apiKey'), /authentication mode changed/);
  fakes.run = (_bin: string, _args: string[], opts: any) => {
    assert.equal(opts.cwd, tmp);
    return { stdout: 'Removed' };
  };
  assert.equal(await t.call('claude:mcp', bin, ['mcp', 'remove', '--scope', 'project', 'x'], 'default', tmp, 'subscription'), 'Removed');
});

test('MCP server projection preserves source, scope and transport but omits authentication material', async () => {
  const t = load();
  fakes.onQuery = (q: any) =>
    (q.mcpServerStatus = async () => [
      {
        name: 'plugin:stripe:stripe',
        status: 'needs-auth',
        source: 'plugin',
        scope: 'user',
        config: { type: 'http', url: 'https://private', headers: { Authorization: 'secret' } },
      },
      { name: 'legacy', status: 'new-status', extra: 1 },
    ]);
  assert.deepEqual((await t.call('claude:extras', bin, path.join(tmp, 'missing'), 'default')).mcp, [
    { name: 'plugin:stripe:stripe', status: 'needs-auth', source: 'plugin', scope: 'user', transport: 'http' },
    { name: 'legacy', status: 'new-status' },
  ]);
  assert.equal(lastQuery().closed, true);
});

test('malformed lists, identities and provenance become a retryable read error, never destructive capabilities', async () => {
  const t = load();
  const server = { name: 'x', status: 'needs-auth' };
  for (const data of [
    null,
    {},
    [null],
    [{}],
    [{ ...server, name: 1 }],
    [{ ...server, name: '' }],
    [{ ...server, status: null }],
    [server, server],
    [{ ...server, source: [], scope: 'user' }],
    [{ ...server, scope: 1 }],
  ]) {
    fakes.onQuery = (q: any) => (q.mcpServerStatus = async () => data);
    const result = await t.call('claude:extras', bin, null, null);
    assert.deepEqual(result.mcp, []);
    assert.match(result.mcpError, /invalid MCP/);
  }
  fakes.onQuery = (q: any) => (q.mcpServerStatus = async () => [server]);
  assert.deepEqual((await t.call('claude:extras', bin, null, null)).mcp, [server]);
});
