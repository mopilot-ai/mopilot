import { test } from 'node:test';
import assert from 'node:assert/strict';

const { mergeCodexMcp, claudeMcpAddArgv, claudeMcpProblem, shellLine } = await import('../src/lib/mcpConfig.ts');
const { claudeHooksFrom, parseClaudeHooks } = await import('../src/lib/claudeHooks.ts');

test('saving a Codex MCP server keeps the keys the editor does not own (D-45)', () => {
  const original = {
    command: 'old',
    args: ['a'],
    env: { A: '1' },
    enabled: false,
    startup_timeout_sec: 30,
    tool_timeout_sec: 5,
    enabled_tools: ['x'],
    oauth_resource: 'https://r',
    experimental_flag: true,
  };
  const out = mergeCodexMcp(original, { command: 'new', args: ['b'] });
  assert.deepEqual(out, {
    command: 'new',
    args: ['b'],
    enabled: false,
    startup_timeout_sec: 30,
    tool_timeout_sec: 5,
    enabled_tools: ['x'],
    oauth_resource: 'https://r',
    experimental_flag: true,
  });
});

test('switching a server from command to URL drops the command keys, not the rest', () => {
  const out = mergeCodexMcp({ command: 'x', args: ['y'], env: { K: 'v' }, enabled: true, custom: 1 }, { url: 'https://h/mcp' });
  assert.deepEqual(out, { url: 'https://h/mcp', enabled: true, custom: 1 });
  assert.deepEqual(mergeCodexMcp(null, { command: 'c' }), { command: 'c' });
});

const form = {
  name: 'github',
  type: 'stdio' as const,
  command: 'npx',
  args: ['-y', '@x/server'],
  url: '',
  env: [{ key: 'TOKEN', value: 'a b' }],
  headers: [],
};

test('claude mcp add: user scope, options before the name, command after --', () => {
  assert.deepEqual(claudeMcpAddArgv('claude', form), [
    'claude',
    'mcp',
    'add',
    '--scope',
    'user',
    '--env',
    'TOKEN=a b',
    'github',
    '--',
    'npx',
    '-y',
    '@x/server',
  ]);
  const http = {
    ...form,
    type: 'http' as const,
    url: 'https://e.com/mcp',
    headers: [{ key: 'Authorization', value: 'Bearer t' }],
    env: [],
  };
  assert.deepEqual(claudeMcpAddArgv('claude', http), [
    'claude',
    'mcp',
    'add',
    '--scope',
    'user',
    '--transport',
    'http',
    '--header',
    'Authorization: Bearer t',
    'github',
    'https://e.com/mcp',
  ]);
});

test('the preview quotes what a shell would split', () => {
  assert.equal(shellLine(claudeMcpAddArgv('claude', form)), "claude mcp add --scope user --env 'TOKEN=a b' github -- npx -y @x/server");
  assert.equal(shellLine(["it's"]), `'it'\\''s'`);
});

test('the form says what is missing before anything runs', () => {
  assert.equal(claudeMcpProblem(form), null);
  assert.match(claudeMcpProblem({ ...form, name: '' })!, /Name/);
  assert.match(claudeMcpProblem({ ...form, name: 'a b' })!, /Name/);
  assert.match(claudeMcpProblem({ ...form, command: ' ' })!, /command/);
  assert.match(claudeMcpProblem({ ...form, type: 'http', url: 'ftp://x' })!, /URL/);
  assert.equal(claudeMcpProblem({ ...form, type: 'sse', url: 'https://x/sse' }), null);
});

test('hooks are listed from a settings.json, and anything odd is skipped', () => {
  const settings = {
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: './check.sh' }] }],
      Stop: [
        {
          hooks: [
            { type: 'command', command: 'say done' },
            { type: 'http', url: 'https://h' },
          ],
        },
        { nothing: true },
      ],
      Broken: 'no',
    },
  };
  assert.deepEqual(claudeHooksFrom(settings), [
    { event: 'PreToolUse', matcher: 'Bash', type: 'command', run: './check.sh' },
    { event: 'Stop', matcher: null, type: 'command', run: 'say done' },
    { event: 'Stop', matcher: null, type: 'http', run: 'https://h' },
  ]);
  assert.deepEqual(claudeHooksFrom({}), []);
  assert.deepEqual(parseClaudeHooks(null), []);
  assert.equal(parseClaudeHooks('{nope'), null);
});
