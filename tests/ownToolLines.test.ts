// MoPilot's own tools read as what they did on every harness (src/lib/ownToolLines.ts, #2280): MoMo's "Searched memory"
// rather than "Called sage_3f880302123f_momo_memory_search", whichever form the harness wrote the name in; and every tool
// MoPilot registers has a line (the guard: a new tool without one would show its raw name again).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { OWN_TOOL_LINES, isOwnServer, ownToolLine, shownToolName } from '../src/lib/ownToolLines.ts';
import { nameOf } from '../src/lib/scheduledTaskCall.ts';
import { ownCallLine } from '../src/lib/windowToolCall.ts';
import { claudeActivityParts } from '../src/session/activityUx.ts';
import { controlTool } from '../src/lib/agentNarration/common.ts';

export const GUARDS = ['electron/capabilities/', 'electron/momo/', 'src/lib/'];

const require = createRequire(import.meta.url);
const call = (tool: string, o: Record<string, unknown> = {}) => ({ type: 'mcpToolCall', tool, arguments: {}, status: 'completed', ...o });

test('a MoMo tool reads as what it did, running, done and failed, in each harness’s form of its name', () => {
  for (const form of [
    { tool: 'sage_3f880302123f_momo_memory_search' }, // opencode (ACP): server and tool joined by "_"
    { tool: 'mcp__sage_3f880302123f__momo_memory_search' }, // Claude Code
    { server: 'sage_3f880302123f', tool: 'momo_memory_search' }, // Codex, and Claude Code once translated
    { tool: 'momo_memory_search', type: 'dynamicToolCall' },
  ]) {
    assert.deepEqual(ownToolLine(call('', { ...form, status: 'inProgress' })), { text: 'Searching memory', failed: false });
    assert.deepEqual(ownToolLine(call('', form)), { text: 'Searched memory', failed: false });
    assert.deepEqual(ownToolLine(call('', { ...form, status: 'failed' })), { text: 'Couldn’t search memory', failed: true });
  }
  assert.equal(ownToolLine(call('momo_memory_save', { error: { message: 'refused' } }))?.text, 'Couldn’t remember');
  assert.equal(ownToolLine(call('momo_memory_save', { result: { isError: true } }))?.text, 'Couldn’t remember');
  assert.equal(ownToolLine(call('momo_memory_save', { status: undefined }))?.text, 'Remembered', 'an item with no status is done');
  assert.equal(ownToolLine(call('momo_calendar_events'))?.text, 'Read Calendar');
  assert.equal(ownToolLine(call('send_message_to_chat'))?.text, 'Sent a message');
});

test('another server’s tool, an unknown tool or a non-tool item has no own line', () => {
  assert.equal(ownToolLine(call('momo_memory_search', { server: 'github' })), null);
  assert.equal(ownToolLine(call('mcp__github__list_chats')), null);
  assert.equal(ownToolLine(call('sage_3f880302123f_something_new')), null);
  assert.equal(ownToolLine({ type: 'commandExecution', tool: 'momo_memory_search' }), null);
  assert.equal(ownToolLine(null), null);
  assert.equal(ownToolLine(call('constructor')), null, 'a prototype name is no line');
});

test('nameOf splits a basic harness’s joined name only for MoPilot’s server, and only when no server was given', () => {
  assert.deepEqual(nameOf({ tool: 'sage_3f880302123f_momo_files_read' }), { server: 'sage_3f880302123f', tool: 'momo_files_read' });
  assert.deepEqual(nameOf({ tool: 'sage_browser_navigate' }), { server: '', tool: 'sage_browser_navigate' }, 'no nonce: a tool name');
  assert.deepEqual(nameOf({ tool: 'sage_3f880302123f_x', server: 'other' }), { server: 'other', tool: 'sage_3f880302123f_x' });
});

test('the step and its card name the tool without MoPilot’s server nonce; another server stays named', () => {
  assert.equal(shownToolName({ tool: 'sage_3f880302123f_momo_memory_search' }), 'momo_memory_search');
  assert.equal(shownToolName({ server: 'sage_3f880302123f', tool: 'momo_memory_search' }), 'momo_memory_search');
  assert.equal(shownToolName({ server: 'github', tool: 'create_issue' }), 'github · create_issue');
  assert.equal(shownToolName({ tool: 'Bash' }), 'Bash');
  assert.equal(shownToolName({}), 'Tool');
  assert.equal(isOwnServer('SAGE'), true);
  assert.equal(isOwnServer('sagebrush'), false);
});

test('the activity line words a running own tool by its line and leaves MoPilot’s server out of others', () => {
  const step = (item: Record<string, unknown>) => claudeActivityParts({ kind: 'tool', item });
  assert.deepEqual(step(call('sage_3f880302123f_momo_memory_search', { status: 'inProgress' })), { verb: 'Searching memory' });
  assert.deepEqual(step(call('open_session_in', { server: 'sage_ab', status: 'inProgress' })), { verb: 'Opening session in split view' });
  assert.deepEqual(step(call('brand_new', { server: 'sage_3f880302123f', status: 'inProgress' })), { verb: 'Using brand_new' });
  assert.deepEqual(step(call('create_issue', { server: 'github', status: 'inProgress' })), { verb: 'Using github: create issue' });
  assert.deepEqual(step(call('', { server: 'github', tool: undefined })), { verb: 'Using github' });
  assert.deepEqual(step({ type: 'mcpToolCall' }), { verb: 'Using a tool' });
  // the removed Feed's tool has no line any more
  assert.equal(ownCallLine(call('momo_feed_post')), null);
});

/** Every tool name the registry gets from MoPilot's tool modules, registered on a stub registry. */
function registeredTools(): string[] {
  const names: string[] = [];
  const registry = { register: (spec: { name: string }) => (names.push(spec.name), () => {}), servesChat: () => true };
  const modules: [string, string][] = [
    ['../electron/capabilities/contract/peerMessages.cjs', 'registerPeerTools'],
    ['../electron/capabilities/tools/windowTools.cjs', 'registerWindowTools'],
    ['../electron/capabilities/tools/paneTools.cjs', 'registerPaneTools'],
    ['../electron/capabilities/tools/scheduledTasks.cjs', 'registerScheduledTaskTools'],
    ['../electron/capabilities/tools/designTools.cjs', 'registerDesignTools'],
    ['../electron/capabilities/tools/pluginSkills.cjs', 'registerPluginSkillTools'],
    ['../electron/capabilities/tools/chatList.cjs', 'registerChatListTool'],
    ['../electron/capabilities/tools/sidebarTools.cjs', 'registerSidebarTools'],
    ['../electron/capabilities/tools/settingsTools.cjs', 'registerSettingsTools'],
    ['../electron/capabilities/tools/connectorTools.cjs', 'registerConnectorTools'],
    ['../electron/capabilities/tools/mcpRegistry.cjs', 'registerMcpRegistryTool'],
    ['../electron/capabilities/tools/sessions.cjs', 'registerSessionTools'],
    ['../electron/capabilities/tools/sessionRead.cjs', 'registerSessionReadTools'],
    ['../electron/capabilities/tools/sessionControl.cjs', 'registerSessionControlTools'],
    ['../electron/momo/memoryTools.cjs', 'registerMemoryTools'],
    ['../electron/momo/sources/tools.cjs', 'registerSourceTools'],
    ['../electron/momo/sources/writeTools.cjs', 'registerWriteTools'],
    ['../electron/momo/outputsTools.cjs', 'registerOutputsTools'],
    ['../electron/momo/draftTools.cjs', 'registerDraftTools'],
  ];
  for (const [file, fn] of modules) require(file)[fn](registry, {});
  const computer = require('../electron/capabilities/tools/computerSpecs.cjs');
  return [...names, ...computer.SPECS.map((s: { name: string }) => s.name), ...computer.VISION_SPECS.map((s: { name: string }) => s.name)];
}

test('every tool MoPilot registers outside control narration reads as a line, never its raw name', () => {
  const names = registeredTools();
  assert.ok(names.length > 30, `found ${names.length} tools`);
  const missing = names.filter((tool) => !ownCallLine(call(tool, { server: 'sage_3f880302123f', arguments: {} })));
  assert.deepEqual(missing, []);
  for (const tool of OWN_TOOL_LINES) assert.ok(names.includes(tool), `${tool} is a registered tool`);
});

test('a basic harness’s joined name for a browser or desktop tool is still control narration', () => {
  assert.deepEqual(controlTool('sage_3f880302123f_browser_navigate'), { surface: 'browser', name: 'navigate' });
  assert.deepEqual(controlTool('sage_3f880302123f_desktop_screenshot'), { surface: 'desktop', name: 'screenshot' });
  assert.deepEqual(controlTool('sage_browser_navigate'), { surface: 'browser', name: 'navigate' }, 'the legacy prefix');
  assert.equal(controlTool('sage_3f88_browser_navigate'), null, 'not MoPilot’s nonce');
});

test('a coding-side MCP tool MoMo re-offers reads as a coding tool, never its raw name', () => {
  const item = (status: string, extra = {}) => ({
    type: 'mcpToolCall',
    server: 'sage_3f880302123f',
    tool: 'momo_mcp_notes_notes_list',
    status,
    ...extra,
  });
  assert.deepEqual(ownToolLine(item('inProgress')), { text: 'Using a coding tool', failed: false });
  assert.deepEqual(ownToolLine(item('completed')), { text: 'Used a coding tool', failed: false });
  assert.deepEqual(ownToolLine(item('failed')), { text: "A coding tool didn't run", failed: true });
  assert.equal(ownToolLine({ type: 'mcpToolCall', server: 'sage_3f880302123f', tool: 'momo_mcp_Bad', status: 'completed' }), null);
});
