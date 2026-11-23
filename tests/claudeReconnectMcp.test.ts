// A Claude Code session's control request to reconnect one MCP server (reconnectMcp, used by the reconnect_session_connector
// tool): it reaches the live CLI's reconnectMcpServer with the server's name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, fakeBin, lastQuery } from './support/electron-claude.ts';

test('reconnectMcp reaches the live CLI with the server name', async () => {
  const t = load();
  const key = 'claude:reconnect';
  await t.claude.send(key, { bin: fakeBin('sessions/claude'), sessionId: 'reconnect', ephemeral: true }, { role: 'user', content: 'hi' });
  await t.call('claude:control', key, 'reconnectMcp', { name: 'github' });
  await t.call('claude:control', key, 'reconnectMcp');
  assert.deepEqual(
    lastQuery().calls.filter((c: any[]) => c[0] === 'reconnectMcpServer'),
    [
      ['reconnectMcpServer', 'github'],
      ['reconnectMcpServer', 'undefined'],
    ],
  );
  await t.call('claude:control', key, 'close');
});
