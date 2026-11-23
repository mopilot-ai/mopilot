// MCP login launch specifications keep opaque arguments and account config, and never send credentials over IPC.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { createCli } = createRequire(import.meta.url)('../electron/harness/claude/cli.cjs');
test('MCP login uses the selected config directory and exact argv without exposing credentials', async () => {
  const accounts: any[] = [];
  const cli = createCli(
    {},
    {
      cleanEnv: (account: string) => {
        accounts.push(account);
        return { ANTHROPIC_API_KEY: 'private', CLAUDE_CONFIG_DIR: account === 'default' ? undefined : `/config/${account}` };
      },
    },
  );
  const name = 'plugin:x:"a:b\\c"';
  assert.deepEqual(await cli.mcpLoginCommand(process.execPath, name, 'a'), {
    command: [process.execPath, 'mcp', 'login', name],
    env: { CLAUDE_CONFIG_DIR: '/config/a' },
  });
  assert.deepEqual((await cli.mcpLoginCommand(process.execPath, 'stripe', 'default')).env, { CLAUDE_CONFIG_DIR: null });
  assert.deepEqual(accounts, ['a', 'default']);
  for (const name of [undefined, null, '', '-option', 'bad\0name', []])
    await assert.rejects(cli.mcpLoginCommand(process.execPath, name, 'a'), /Invalid MCP/);
});

test('a Windows npm shim is normalized to its executable for the embedded sign-in terminal', async (t) => {
  const require = createRequire(import.meta.url);
  const winbin = require('../electron/platform/winbin.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mopilot-mcp-shim-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const shim = path.join(dir, 'claude.cmd');
  fs.writeFileSync(shim, 'shim');
  const target = path.win32.join(path.win32.dirname(shim), 'claude.exe');
  t.mock.method(winbin, 'realIo', () => ({
    platform: 'win32',
    env: {},
    execPath: process.execPath,
    readFile: () => '"%dp0%\\claude.exe" %*',
    exists: (p: string) => p === target,
  }));
  const file = require.resolve('../electron/harness/claude/cli.cjs');
  delete require.cache[file];
  try {
    const cli = require(file).createCli({}, { cleanEnv: () => ({ CLAUDE_CONFIG_DIR: 'C:\\account-a' }) });
    assert.deepEqual(await cli.mcpLoginCommand(shim, 'plugin:stripe:stripe', 'a'), {
      command: [target, 'mcp', 'login', 'plugin:stripe:stripe'],
      env: { CLAUDE_CONFIG_DIR: 'C:\\account-a' },
    });
    winbin.realIo = () => ({
      platform: 'win32',
      env: {},
      execPath: process.execPath,
      readFile: () => '@echo custom.cmd %*',
      exists: () => false,
    });
    delete require.cache[file];
    const fallback = await require(file)
      .createCli({}, { cleanEnv: () => ({}) })
      .mcpLoginCommand(shim, 'stripe', 'a');
    const expected = winbin.launchSpec(shim, ['mcp', 'login', 'stripe'], {}, winbin.realIo());
    assert.deepEqual(fallback.command, [expected.command]);
    assert.equal(fallback.windowsCommandLine, expected.args.join(' '));
  } finally {
    delete require.cache[file];
  }
});
