// Terminal launch specs preserve Windows command lines that the shared CLI launcher has already escaped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { spawnSpec } = createRequire(import.meta.url)('../electron/platform/pty.cjs');

test('Windows command-line strings bypass argument re-escaping; other terminal launches keep structured argv', () => {
  const ctx = { env: {}, home: '/home', shell: 'shell', isDir: () => true, platform: 'win32' };
  const raw = '/d /s /c "C:\\Program^ Files\\Claude\\claude.cmd ^"mcp^" ^"login^" ^"stripe^""';
  assert.equal(spawnSpec({ command: ['cmd.exe'], windowsCommandLine: raw }, ctx).args, raw);
  assert.equal(spawnSpec({ command: ['cmd.exe'], windowsCommandLine: '' }, ctx).args, '');
  assert.deepEqual(spawnSpec({ command: ['claude.exe', 'mcp', 'login', 'stripe'] }, ctx).args, ['mcp', 'login', 'stripe']);
  assert.deepEqual(spawnSpec({ windowsCommandLine: raw }, ctx).args, ['-NoLogo']);
  assert.deepEqual(spawnSpec({ command: ['claude', 'mcp', 'login'], windowsCommandLine: raw }, { ...ctx, platform: 'darwin' }).args, [
    'mcp',
    'login',
  ]);
});
