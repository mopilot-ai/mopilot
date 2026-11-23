// Whole-repository rule (#2305): a Claude Code session of a MoMo chat is allowlist-only. It starts with no built-in tool
// (`--tools ""`: no Workflow, Monitor, WebFetch, WebSearch, Cron… nor any tool a later CLI adds), no MCP server but MoPilot's own (`--strict-mcp-config`), no claude.ai connector, no skill, no plugin folder and no Claude in Chrome, and its
// permission check refuses any tool it wasn't given. Never a list of tools to take away. Other chats start as before. Run
// against a fake Agent SDK and a fake Electron; the session code is real.
import { waitFor } from './support/waitFor.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';

export const GUARDS = ['electron/'];

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-claude-confined-'));
fs.writeFileSync(
  path.join(tmp, 'electron.cjs'),
  `module.exports = { app: { getPath: () => ${JSON.stringify(tmp)} }, safeStorage: { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from('enc:' + s), decryptString: (b) => String(b).slice(4) } };`,
);
fs.writeFileSync(
  path.join(tmp, 'sdk.mjs'),
  [
    'export const query = (args) => globalThis.__fakeConfinedQuery(args);',
    'export const tool = (name, description, schema, handler, extra) => ({ name, description, handler, extra });',
    "export const createSdkMcpServer = (o) => ({ type: 'sdk', ...o });",
  ].join('\n'),
);
const fakes: Record<string, string> = { electron: 'electron.cjs', '@anthropic-ai/claude-agent-sdk': 'sdk.mjs' };
registerHooks({
  resolve(specifier, context, next) {
    if (fakes[specifier]) return { url: pathToFileURL(path.join(tmp, fakes[specifier])).href, shortCircuit: true };
    return next(specifier, context);
  },
});

/** A CLI process that answers each prompt with a result and ends when closed. */
const queries: any[] = [];
(globalThis as any).__fakeConfinedQuery = ({ prompt, options }: { prompt: AsyncIterable<any>; options: any }) => {
  const out: any[] = [];
  let wake = () => {};
  const q: any = {
    options,
    closed: false,
    close() {
      q.closed = true;
      wake();
    },
    async interrupt() {},
    async setPermissionMode() {},
    async getSettings() {
      return { applied: {} };
    },
    async applyFlagSettings() {},
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (out.length) yield out.shift();
        else if (q.closed) return;
        else await new Promise<void>((r) => (wake = r));
      }
    },
  };
  (async () => {
    for await (const m of prompt) {
      out.push({ type: 'result', subtype: 'success', echo: m.message.content });
      wake();
    }
  })();
  queries.push(q);
  return q;
};

const require = createRequire(import.meta.url);
const claude = require('../electron/harness/claude/index.cjs').createClaudeHarness();
const { ToolSessions } = require('../electron/capabilities/contract/session.cjs');
const { isolateOptions, confineTools, ISOLATED_ENV, ISOLATED_DENIAL, HOOK_DENIAL } = require('../electron/harness/claude/isolation.cjs');
const { prepareSessionTools } = require('../electron/harness/claude/sessionTools.cjs');

const handlers = new Map<string, (...a: any[]) => any>();
const call = (name: string, ...args: any[]) => handlers.get(name)!({}, ...args);
claude.register({ handle: (name: string, fn: any) => handlers.set(name, fn) }, () => undefined);
async function until(what: string, ok: () => boolean) {
  await waitFor(ok, what).catch(() => {});
  assert.ok(ok(), `timed out waiting for ${what}`);
}
let serial = 0;
/** Starts a chat's CLI and returns its query once it answered the first message. */
async function startChat(chatId: string, extra: any = {}) {
  const sid = `confined-${++serial}`;
  const key = `claude:${sid}`;
  const before = queries.length;
  await claude.send(
    key,
    { bin: process.execPath, sessionId: sid, resume: true, cwd: tmp, account: 'default', chatId, ...extra },
    { role: 'user', content: 'hi' },
  );
  await until('the CLI', () => queries.length > before);
  return { key, q: queries[before] };
}
function registry(names: string[]) {
  return {
    list: () => names.map((name) => ({ name, description: name, inputSchema: { type: 'object', properties: {} }, policy: 'observe' })),
    invoke: async () => ({ ok: true, content: [] }),
  };
}
const toolNames = (q: any) => Object.values(q.options.mcpServers ?? {}).flatMap((s: any) => s.tools.map((t: any) => t.name));
/** Claude Code's own tools and the account's connectors that a MoMo chat must never reach (#2305). */
const NOT_GIVEN = ['Bash', 'Read', 'Agent', 'Workflow', 'Monitor', 'WebFetch', 'WebSearch', 'CronCreate', 'RemoteTrigger', 'Skill'];
const CONNECTOR = 'mcp__claude_ai_Gmail__send_message';
/** What the session's PreToolUse hooks answer for a call (the CLI runs them in every permission mode). */
const hookAnswers = async (o: any, name: string) => {
  const out: unknown[] = [];
  for (const m of o.hooks.PreToolUse)
    for (const h of m.hooks) out.push(await h({ hook_event_name: 'PreToolUse', tool_name: name }, 'id', {}));
  return out;
};

test('a MoMo chat’s Claude Code session is allowlist-only: no built-in tool, no other MCP server, connector, skill or Claude in Chrome', async () => {
  const isolated = (id: string) => id === 'momo';
  claude.setIsolated(isolated);
  claude.setTools({
    // the registry's chat scope keeps a MoMo chat's list to MoMo's own tools (momo/contract/toolIsolation.cjs)
    registry: registry(['momo_memory_read', 'sage_browser_click']),
    sessions: new ToolSessions(),
    nativeChrome: () => true,
    hideTool: (name: string) => name.startsWith('sage_browser_'),
  });
  const { key, q } = await startChat('momo');
  try {
    const o = q.options;
    assert.deepEqual(o.tools, []);
    assert.equal(o.strictMcpConfig, true);
    assert.deepEqual(o.skills, []);
    assert.equal(o.env.ENABLE_CLAUDEAI_MCP_SERVERS, 'false');
    assert.equal(o.disallowedTools, undefined, 'an allowlist, never a list of tools to take away');
    // no Claude in Chrome: MoMo's own browser tools stay
    assert.deepEqual(o.extraArgs, { 'no-chrome': null });
    assert.deepEqual(toolNames(q), ['momo_memory_read', 'sage_browser_click']);
    // what it was given passes without a card; anything else is refused, whatever the CLI offers
    const [server] = Object.keys(o.mcpServers);
    assert.deepEqual(await o.canUseTool(`mcp__${server}__momo_memory_read`, { a: 1 }, {}), { behavior: 'allow', updatedInput: { a: 1 } });
    for (const name of [...NOT_GIVEN, CONNECTOR, `mcp__${server}__send_message_to_chat`]) {
      assert.deepEqual(await o.canUseTool(name, {}, {}), { ...ISOLATED_DENIAL }, name);
      assert.deepEqual(await hookAnswers(o, name), [HOOK_DENIAL], name);
    }
    assert.deepEqual(await hookAnswers(o, `mcp__${server}__momo_memory_read`), [{}]);
  } finally {
    await call('claude:control', key, 'close');
  }
  // a coding chat on the same switches starts as before
  const code = await startChat('code');
  try {
    const o = code.q.options;
    assert.equal(o.tools, undefined);
    assert.equal(o.strictMcpConfig, undefined);
    assert.equal(o.skills, undefined);
    assert.equal(o.env.ENABLE_CLAUDEAI_MCP_SERVERS, undefined);
    assert.deepEqual(o.extraArgs, { chrome: null });
    assert.deepEqual(toolNames(code.q), ['momo_memory_read']);
    assert.equal(o.hooks, undefined);
  } finally {
    await call('claude:control', code.key, 'close');
    claude.setTools(null);
    claude.setIsolated(() => false);
  }
});

test('a MoMo session under Full access or read-only still runs only what it was given', async () => {
  claude.setIsolated((id: string) => id === 'momo');
  claude.setTools({ registry: registry(['momo_memory_read']), sessions: new ToolSessions(), nativeChrome: () => false });
  // read-only auto-allows none of Claude Code's own tools, only MoPilot's read-only ones
  const ro = await startChat('momo', { permission: 'read-only' });
  const full = await startChat('momo', { permission: 'full-access' });
  try {
    const [server] = Object.keys(ro.q.options.mcpServers);
    assert.deepEqual(ro.q.options.allowedTools, [`mcp__${server}__momo_memory_read`]);
    // Full access never asks canUseTool: the PreToolUse hook refuses there
    assert.equal(full.q.options.permissionMode, 'bypassPermissions');
    for (const name of NOT_GIVEN) assert.deepEqual(await hookAnswers(full.q.options, name), [HOOK_DENIAL], name);
  } finally {
    await call('claude:control', ro.key, 'close');
    await call('claude:control', full.key, 'close');
    claude.setTools(null);
    claude.setIsolated(() => false);
  }
});

test('isolateOptions alone: memory, connectors, tools and skills off; a session without MoPilot’s tools is refused every tool', async () => {
  const options: any = { env: { PATH: '/bin' }, settings: { fastMode: true }, allowedTools: ['Read', 'WebFetch'] };
  isolateOptions(options);
  assert.deepEqual(options, {
    env: { PATH: '/bin', ...ISOLATED_ENV },
    settings: { fastMode: true, autoMemoryEnabled: false },
    allowedTools: [],
    tools: [],
    strictMcpConfig: true,
    skills: [],
  });
  assert.deepEqual(ISOLATED_ENV, {
    CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
  });
  // no check of its own to hand a given tool to: refused too; a hook call naming no tool is refused; hooks it had stay after the gate
  const bare: any = { hooks: { PreToolUse: [{ hooks: ['theirs'] }], Stop: ['s'] } };
  confineTools(bare, () => true);
  assert.deepEqual(await bare.canUseTool('mcp__s__t', {}, {}), { ...ISOLATED_DENIAL });
  assert.equal(await bare.hooks.PreToolUse[0].hooks[0]({}), HOOK_DENIAL);
  assert.deepEqual(bare.hooks.PreToolUse[1], { hooks: ['theirs'] });
  assert.deepEqual(bare.hooks.Stop, ['s']);
  // through the session's preparation, with MoPilot's tools switched off: nothing is given, so nothing passes
  const inner: string[] = [];
  const o: any = { canUseTool: async (n: string) => (inner.push(n), { behavior: 'allow' }) };
  await prepareSessionTools({ isolated: () => true }, { takesPluginDirs: () => true }, '/cli', o, {}, { chatId: 'm' }, 'k', () => 'm');
  assert.deepEqual(await o.canUseTool('mcp__sage_x__momo_memory_read', {}, {}), { ...ISOLATED_DENIAL });
  assert.deepEqual(inner, []);
});

test('a MoMo session loads no plugin folder (their servers, hooks and agents are the CLI’s): MoPilot serves their skills', async () => {
  const marked: any[] = [];
  const asked: string[] = [];
  const plugins = {
    markNative: (...a: any[]) => (marked.push(a), Object.assign(() => undefined, { fail: () => undefined })),
    forClaude: async () => (asked.push('forClaude'), { plugins: [{ type: 'local', path: '/p' }], withheld: [], release: () => undefined }),
  };
  const prepared = async (chatId: string) => {
    const o: any = {};
    const s: any = {};
    await prepareSessionTools(
      { isolated: (id: string) => id === 'momo', plugins },
      { takesPluginDirs: async () => true },
      '/cli',
      o,
      s,
      { chatId },
      'k',
      () => chatId,
    );
    return { o, s };
  };
  const momo = await prepared('momo');
  assert.equal(momo.o.plugins, undefined);
  assert.equal(momo.s.pluginDirs, false);
  assert.deepEqual(marked, [['claude', false, 'momo']]);
  assert.deepEqual(asked, []);
  // a coding chat loads them natively
  const code = await prepared('code');
  assert.deepEqual(code.o.plugins, [{ type: 'local', path: '/p' }]);
  assert.deepEqual(marked[1], ['claude', true, 'code']);
  // a session already marked by its start keeps that mark
  const o: any = {};
  await prepareSessionTools({ isolated: () => false }, { takesPluginDirs: () => false }, '/cli', o, { isolated: true }, {}, 'k', () => 'x');
  assert.deepEqual(o.tools, []);
});

test('the isolation module confines by allowlist only: it never writes a list of tools to take away', () => {
  const src = fs.readFileSync(new URL('../electron/harness/claude/isolation.cjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /disallowedTools\s*=/);
  assert.match(src, /options\.tools = \[\];/);
  assert.match(src, /options\.strictMcpConfig = true;/);
});
