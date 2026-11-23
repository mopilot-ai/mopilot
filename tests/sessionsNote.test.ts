// The note on starting other sessions (electron/capabilities/contract/sessionsNote.cjs) reaches every harness that is shown
// start_session, beside the note on what the tools reach: a Claude Code session as its first tool server's MCP
// instructions (under the names it sees), a Codex thread in its instructions note (managed and native), and an ACP
// session ahead of its first prompt (registryNote). It names no harness, and a session without start_session gets none.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fakeSdk } from './support/control-matrix-kit.ts';

const require = createRequire(import.meta.url);
const { sessionsNote, withSessionsNote, SESSION_RULES } = require('../electron/capabilities/contract/sessionsNote.cjs');
const { registryNote, claudeNames } = require('../electron/capabilities/contract/surfaceNote.cjs');
const { CodexToolInjection } = require('../electron/capabilities/channels/codexConfig.cjs');
const { hasBackend } = require('../electron/capabilities/channels/codexBrowserBackends.cjs');
const { Registry } = require('../electron/capabilities/contract/registry.cjs');
const { ToolSessions } = require('../electron/capabilities/contract/session.cjs');
const { prepareSessionTools } = require('../electron/harness/claude/sessionTools.cjs');
const { registerSessionTools } = require('../electron/capabilities/tools/sessions.cjs');

const SESSION_TOOLS = [
  'start_session',
  'dismiss_task',
  'hand_off_to_session',
  'list_sessions',
  'send_message',
  'stop_session',
  'archive_session',
];

function registry(names: string[]) {
  const r = new Registry();
  for (const name of names)
    r.register({ name, description: name, schema: { type: 'object', properties: {} }, policy: 'observe', handler: async () => 'ok' });
  return r;
}

test('the note sends the model to start_session’s description, which carries every rule, and names no harness', () => {
  const note = sessionsNote(SESSION_TOOLS);
  assert.match(note, /^Starting other sessions \(linked MoPilot chats\):/);
  assert.match(note, /goes through start_session\. Load it first and follow the rules in its description, before any plan or work/);
  assert.doesNotMatch(note, /Codex|Claude|ACP|OpenCode|Gemini/);
  // the same short note whatever else the session is shown: the tools' own rules live in the description (G11)
  assert.equal(sessionsNote(['start_session']), note);
  assert.ok(note!.length < 400, 'one paragraph, not the rules');
  assert.equal(sessionsNote(['list_sessions', 'browser_navigate']), null);
  // the rules are the tail of start_session’s description, after the field guidance, whichever tools a session has
  const tools = new Registry();
  registerSessionTools(tools, { orchestrator: {}, owner: {} });
  const start = tools.list().find((t: any) => t.name === 'start_session');
  const rules = start.description.split('Rules for starting sessions:\n')[1];
  assert.equal(rules, SESSION_RULES);
  // as the reference runs a session elsewhere only where the user names the place (#2084)
  assert.match(start.description, /Starts on this chat’s harness unless the user named another; harness "auto" picks/);
  assert.match(start.description, /after names sessions this chat started: the child waits/);
  assert.match(start.description, /context "fresh" \(default\) needs background of at least 80 characters/);
  assert.match(start.description, /use_worktree false shares this folder and requires nonoverlapping paths/);
  assert.match(start.inputSchema.properties.harness.description, /only when the user named it/);
  assert.match(rules, /Quick things \(a question, a read, one edit, a handful of tool calls\) stay here/);
  assert.match(rules, /"offer" for a task the user named in their latest message without saying where to run it/);
  assert.match(rules, /"user_asked" only when the user asked in words for separate, parallel or background work/);
  assert.match(rules, /"own_initiative" for work you propose yourself .* At most 3 per turn, never the same one twice/);
  assert.match(rules, /A follow-up you name gets a card/);
  assert.match(rules, /In a turn the user did not start, only propose with "own_initiative"/);
  assert.match(rules, /something else while you are in the middle of a task: move that task to its own session with hand_off_to_session/);
  assert.match(
    rules,
    /Right before each start_session or hand_off_to_session call, in the same message, write a bold title line and one sentence/,
  );
  assert.match(rules, /\[its title\]\(mopilot:chat\/<chat id>\)/);
  assert.match(rules, /Never poll a session you started \(no repeated list_sessions calls/);
  assert.match(rules, /naming each branch by its full ref \(refs\/heads\/…\)/);
  assert.match(rules, /Archive a linked session with archive_session only after the user says yes/);
  assert.match(rules, /you may show that session beside this one with open_session_in \(target "split"\) if you are shown it/);
  assert.match(rules, /If it says this session is not on screen, don't retry/);
  assert.match(rules, /Close only panes you opened \(close_split\); a pane the user arranged is theirs/);
  assert.doesNotMatch(rules, /Codex|Claude|ACP|OpenCode|Gemini/);
  // how to fill the fields is the description's, not repeated in the rules
  assert.doesNotMatch(rules, /use_worktree|`harness|`after`|80 characters/);
  // no start_session, no note
  assert.equal(withSessionsNote(null, ['browser_navigate']), null);
  assert.equal(withSessionsNote('TOOLS', ['browser_navigate']), 'TOOLS');
  assert.match(withSessionsNote('TOOLS', ['start_session']), /^TOOLS\n\nStarting other sessions/);
  assert.match(withSessionsNote(null, ['start_session']), /^Starting other sessions/);
});

test('a Claude Code session is told in its first tool server’s MCP instructions, under the names it sees', async () => {
  const sdk = { tool: fakeSdk.tool, createSdkMcpServer: (o: any) => o };
  const run = async (names: string[]) => {
    const state: any = {
      sdk: async () => sdk,
      sageTools: { registry: registry(names), sessions: new ToolSessions(), enabled: () => true },
    };
    const options: any = { systemPrompt: { type: 'preset', preset: 'claude_code' } };
    await prepareSessionTools(state, { takesPluginDirs: () => false }, '/cli', options, {}, { chatId: 'c1' }, 'k1', () => 'c1');
    const servers = Object.entries(options.mcpServers ?? {}) as [string, any][];
    return { server: servers[0]?.[0], instructions: servers[0]?.[1].instructions as string | undefined };
  };
  const { server, instructions } = await run([...SESSION_TOOLS, 'browser_navigate']);
  const full = claudeNames(server).name;
  // the browser note first, then the sessions note, each tool under its mcp__<server>__ name
  assert.match(instructions!, /computer and browser tools[\s\S]*\n\nStarting other sessions/);
  assert.ok(instructions!.includes(`goes through ${full('start_session')}. Load it first`));
  // only the sessions tools: the sessions note alone
  assert.match((await run(SESSION_TOOLS)).instructions!, /^Starting other sessions/);
  // neither: no instructions
  assert.equal((await run(['sage_debug_echo'])).instructions, undefined);
});

test('a Codex thread is told in its instructions note, managed or native, once it is shown start_session', () => {
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
  const managed = thread({ nativeEnabled: () => false, visibleTools: () => SESSION_TOOLS });
  assert.match(managed, /^Starting other sessions/);
  assert.match(managed, /goes through start_session\. Load it first/);
  assert.equal(thread({ nativeEnabled: () => false, visibleTools: () => ['sage_debug_echo'] }), null);
  // a native thread: after the scope note that ties MoPilot's tools to its server
  const native = thread({ nativeEnabled: () => true, visibleTools: () => SESSION_TOOLS });
  assert.match(native, /This note is from MoPilot and applies only while the sage_\w+ MCP server is in your tool list/);
  assert.match(native, /\n\nStarting other sessions/);
  // a session hidden start_session gets no sessions note
  const hidden = thread({ nativeEnabled: () => true, visibleTools: () => SESSION_TOOLS, nativeHide: (n: string) => n === 'start_session' });
  assert.doesNotMatch(hidden ?? '', /Starting other sessions/);
});

test('an ACP session gets it with the note sent ahead of its first prompt (registryNote)', () => {
  const control = { drivesUserChrome: () => false };
  assert.match(registryNote(registry(SESSION_TOOLS), control), /^Starting other sessions/);
  assert.match(
    registryNote(registry([...SESSION_TOOLS, 'browser_navigate']), control),
    /built-in browser[\s\S]*\n\nStarting other sessions/,
  );
  assert.equal(registryNote(registry(['sage_debug_echo']), control), null);
});

test('hasBackend reads a thread’s browser backend, false without backends or when they cannot say', () => {
  assert.equal(hasBackend(null, 'th'), false);
  assert.equal(hasBackend({ has: (id: string) => id === 'th' }, 'th'), true);
  assert.equal(
    hasBackend(
      {
        has: () => {
          throw new Error('gone');
        },
      },
      'th',
    ),
    false,
  );
});

test('a tiered session (ACP, a Codex without native deferral) gets the rules when it loads the sessions group, with the call-first path pointed at the load', () => {
  const tiers = require('../electron/capabilities/mcp/toolTiers.cjs');
  const tools = new Registry();
  registerSessionTools(tools, { orchestrator: {}, owner: {} });
  const byName = new Map<string, any>(tools.list().map((t: any) => [t.name, t]));
  const visible = new Set(byName.keys());
  const describe = (n: string) => ({ description: byName.get(n).description, inputSchema: byName.get(n).inputSchema });
  // start_session waits in the app surface's sessions group, so the first list carries neither it nor its rules
  assert.equal(tiers.groupOf('start_session').group, 'sessions');
  assert.equal(
    tiers.tieredList([...byName.values()], new Set()).some((t: any) => t.name === 'start_session'),
    false,
  );
  // loading the group answers with the full description, rules included
  const loaded = tiers.moreCall('app_more_tools', { load: ['sessions'] }, visible, describe);
  assert.ok(loaded.answer.includes(JSON.stringify(SESSION_RULES.split('\n')[0]).slice(1, -1)), 'the load answer carries the rules');
  assert.deepEqual(loaded.load, ['app/sessions']);
});
