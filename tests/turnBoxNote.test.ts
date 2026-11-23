// The note on keeping the task list and closing with wrap_up (electron/capabilities/contract/turnBoxNote.cjs), as Claude Desktop's
// system prompt says it, reaches every harness shown update_task_list: a Claude Code session in its first tool server's
// MCP instructions (which the CLI no longer cuts at 4096 characters), a Codex thread in its instructions note (managed
// and native), and an ACP session ahead of its first prompt. It names no harness; a session without the tool gets none.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fakeSdk } from './support/control-matrix-kit.ts';

const require = createRequire(import.meta.url);
const { turnBoxNote } = require('../electron/capabilities/contract/turnBoxNote.cjs');
const { withSessionsNote } = require('../electron/capabilities/contract/sessionsNote.cjs');
const { registryNote, claudeNames, surfaceNote } = require('../electron/capabilities/contract/surfaceNote.cjs');
const { CodexToolInjection } = require('../electron/capabilities/channels/codexConfig.cjs');
const { Registry } = require('../electron/capabilities/contract/registry.cjs');
const { ToolSessions } = require('../electron/capabilities/contract/session.cjs');
const { prepareSessionTools } = require('../electron/harness/claude/sessionTools.cjs');
const { MCP_INSTRUCTIONS_CHARS, buildSessionOptions } = require('../electron/harness/claude/sessionOptions.cjs');

const TURN_TOOLS = ['update_task_list', 'wrap_up'];

function registry(names: string[]) {
  const r = new Registry();
  for (const name of names)
    r.register({ name, description: name, schema: { type: 'object', properties: {} }, policy: 'observe', handler: async () => 'ok' });
  return r;
}

test('the note says the list rides with the first tool call, is sent again after each user message, and wrap_up closes', () => {
  const note = turnBoxNote(TURN_TOOLS);
  assert.match(note, /^Task list and wrap-up \(this app\):/);
  assert.match(note, /not by reading your messages, so keeping it is part of the task/);
  // both wait behind the tool search on every harness (G11): the note says to load them with the first tool call
  assert.match(
    note,
    /update_task_list and wrap_up wait behind the tool search\. For a request that edits files or runs more than one command, load them with your first tool call, then send update_task_list with the whole plan in the same message as your next tool call/,
  );
  assert.match(note, /Each message from the user, a new request or a word mid-task, gets its list/);
  assert.match(note, /closes with wrap_up, when the work is done and before any closing message/);
  // a browse-only answer is not forced through the list or the wrap-up (G10: browser turns carry no workflow calls)
  assert.match(note, /A question answered only by reading or browsing needs neither\./);
  assert.doesNotMatch(note, /Codex|Claude|ACP|OpenCode|Gemini/);
  // only what the session is shown: no wrap_up line without wrap_up, no note without update_task_list
  assert.doesNotMatch(turnBoxNote(['update_task_list']), /wrap_up|load them/);
  assert.match(turnBoxNote(['update_task_list']), /update_task_list waits behind the tool search\..*load it with your first tool call/);
  assert.equal(turnBoxNote(['wrap_up', 'start_session']), null);
  // under the names the session sees
  const naming = claudeNames('sage_x');
  assert.ok(turnBoxNote(TURN_TOOLS, naming).includes(`send ${naming.name('update_task_list')} with the whole plan`));
  // joined after the tools note and before the sessions note
  assert.match(
    withSessionsNote('TOOLS', [...TURN_TOOLS, 'start_session']),
    /^TOOLS\n\nTask list and wrap-up[\s\S]*\n\nStarting other sessions/,
  );
  assert.equal(withSessionsNote(null, ['browser_navigate']), null);
});

test('a Claude Code session gets it in its MCP instructions, whole: the CLI is told not to cut them at 4096', async () => {
  const sdk = { tool: fakeSdk.tool, createSdkMcpServer: (o: any) => o };
  const options: any = { systemPrompt: { type: 'preset', preset: 'claude_code' } };
  const state: any = {
    sdk: async () => sdk,
    sageTools: { registry: registry([...TURN_TOOLS, 'start_session']), sessions: new ToolSessions(), enabled: () => true },
  };
  await prepareSessionTools(state, { takesPluginDirs: () => false }, '/cli', options, {}, { chatId: 'c1' }, 'k1', () => 'c1');
  const [server, config] = Object.entries(options.mcpServers)[0] as [string, any];
  assert.ok(config.instructions.startsWith(`Task list and wrap-up (this app):`));
  assert.ok(config.instructions.includes(`send ${claudeNames(server).name('update_task_list')} with the whole plan`));
  // the CLI cuts server instructions at CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH (4096 unset): every note fits the cap
  const env = buildSessionOptions({ cwd: '/tmp' }, { env: { A: '1' } }).env;
  assert.equal(env.CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH, String(MCP_INSTRUCTIONS_CHARS));
  assert.equal(env.A, '1');
  // a value the user exported wins
  assert.equal(
    buildSessionOptions({ cwd: '/tmp' }, { env: { CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH: '9000' } }).env
      .CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH,
    '9000',
  );
  const every = registry([])
    .list()
    .map((t: any) => t.name);
  const names = [
    ...every,
    ...TURN_TOOLS,
    'browser_navigate',
    'chrome_navigate',
    'computer_screenshot',
    'design_quickstart',
    'show_pane',
    'start_session',
    'hand_off_to_session',
    'list_sessions',
    'open_session_in',
    'close_split',
    'archive_session',
  ];
  const naming = claudeNames('sage_0123456789ab');
  const longest = withSessionsNote(surfaceNote(names, { yourChrome: true, ownChrome: true, naming }), names, naming);
  assert.ok(longest.length > 4096, `the notes outgrew the CLI's default cap (${longest.length})`);
  assert.ok(longest.length <= MCP_INSTRUCTIONS_CHARS, `the notes run ${longest.length} characters`);
});

test('a Codex thread gets it in its instructions note, managed or native, once it is shown update_task_list', () => {
  const thread = (o: any) => {
    const inj = new CodexToolInjection({
      sessions: new ToolSessions(),
      command: '/bin/sage-mcp',
      socketPath: '/tmp/s.sock',
      harnessPid: () => 1,
      chromeInstances: () => null,
      ...o,
    });
    inj.outgoing({ id: 1, method: 'thread/start', params: {} });
    inj.observe({ id: 1, result: { thread: { id: 'th' } } });
    return inj.turnContext('th')?.context.value ?? null;
  };
  assert.match(thread({ nativeEnabled: () => false, visibleTools: () => TURN_TOOLS }), /^Task list and wrap-up/);
  const native = thread({ nativeEnabled: () => true, visibleTools: () => [...TURN_TOOLS, 'start_session'] });
  assert.match(native, /This note is from MoPilot and applies only while the sage_\w+ MCP server is in your tool list/);
  assert.match(native, /\n\nTask list and wrap-up[\s\S]*\n\nStarting other sessions/);
  // the same notes as the other paths: the design-systems note too
  assert.match(thread({ nativeEnabled: () => true, visibleTools: () => ['design_quickstart'] }), /\n\nDesign systems/);
  const hidden = thread({ nativeEnabled: () => true, visibleTools: () => TURN_TOOLS, nativeHide: (n: string) => n === 'update_task_list' });
  assert.doesNotMatch(hidden ?? '', /Task list and wrap-up/);
});

test('an ACP session gets it with the note sent ahead of its first prompt (registryNote)', () => {
  assert.match(registryNote(registry(TURN_TOOLS), { drivesUserChrome: () => false }), /^Task list and wrap-up/);
});
