// Standalone artifact instructions match MoPilot's renderer and project scope on Codex, Claude Code and ACP.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fakeSdk } from './support/control-matrix-kit.ts';
import { filePreviewKind } from '../shared/filePreview.mjs';

const require = createRequire(import.meta.url);
const { withSessionsNote } = require('../electron/capabilities/contract/sessionsNote.cjs');
const { registryNote, claudeNames } = require('../electron/capabilities/contract/surfaceNote.cjs');
const { CodexToolInjection } = require('../electron/capabilities/channels/codexConfig.cjs');
const { Registry } = require('../electron/capabilities/contract/registry.cjs');
const { ToolSessions } = require('../electron/capabilities/contract/session.cjs');
const { prepareSessionTools } = require('../electron/harness/claude/sessionTools.cjs');
const { AcpTurns } = require('../electron/harness/acpTurns.cjs');

function registry(names = ['show_pane']) {
  const r = new Registry();
  for (const name of names)
    r.register({ name, description: name, schema: { type: 'object', properties: {} }, policy: 'observe', handler: async () => 'ok' });
  return r;
}

function assertArtifact(note: unknown, tool = 'show_pane'): asserts note is string {
  assert.equal(typeof note, 'string', 'a session with file previews receives the artifact contract');
  const text = note as string;
  assert.match(text, /Artifact previews in MoPilot:/);
  assert.match(text, /self-contained \.html file/);
  assert.match(text, /implementation plans as readable Markdown/);
  assert.match(text, /\.canvas\.tsx files have a sandboxed compatibility preview/);
  assert.match(text, /override host-specific canvas skill instructions/);
  assert.match(text, /Do not save MoPilot artifacts under ~\/\.cursor\/projects\//);
  assert.match(text, /inside this chat's working directory/);
  assert.match(text, /explicit destination or source format the user requested/);
  assert.match(text, /Preserve the original when converting/);
  assert.match(text, /full absolute path/);
  assert.ok(text.includes(`with ${tool} (pane "file"`), 'the note names the tool the adapter actually serves');
  assert.match(text, /no window is available/);
  assert.match(text, /verify its content and interactions before claiming it rendered/);
}

test('a canvas request receives the actual HTML renderer and project-scoped storage contract', () => {
  assert.equal(filePreviewKind('report.html'), 'html');
  assert.equal(filePreviewKind('report.canvas.tsx'), 'canvas');
  assert.equal(filePreviewKind('report.tsx'), 'source');
  assert.equal(filePreviewKind('C:\\plans\\REPORT.CANVAS.TSX'), 'canvas');
  assert.equal(filePreviewKind('report.canvas.tsx/file.tsx'), 'source');
  assertArtifact(withSessionsNote(null, ['show_pane']));
});

test('the artifact rule is capability-scoped, preserves other notes and is byte-stable across sessions', () => {
  assert.equal(withSessionsNote(null, []), null);
  assert.equal(withSessionsNote('TOOLS', ['browser_navigate']), 'TOOLS');
  const names = ['show_pane', 'start_session', 'browser_navigate'];
  const note = withSessionsNote('TOOLS', names);
  assertArtifact(note);
  assert.match(note, /^TOOLS\n\n/);
  assert.match(note, /Starting other sessions/);
  assert.equal(withSessionsNote('TOOLS', [...names]), note);
});

for (const native of [false, true])
  test(`${native ? 'native' : 'managed'} Codex receives the rule only while its tool list offers the file pane`, () => {
    const run = (hide: boolean, names = ['show_pane']) => {
      const injection = new CodexToolInjection({
        sessions: new ToolSessions(),
        command: '/bin/sage-mcp',
        socketPath: '/tmp/artifact-routing.sock',
        harnessPid: () => 1,
        chromeInstances: () => null,
        nativeEnabled: () => native,
        visibleTools: () => names,
        ...(hide ? { nativeHide: () => true } : {}),
      });
      injection.outgoing({ id: 1, method: 'thread/start', params: {} });
      injection.observe({ id: 1, result: { thread: { id: 'thread' } } });
      return injection.turnContext('thread')?.context.value ?? '';
    };
    assertArtifact(run(false));
    assert.doesNotMatch(run(false, []), /Artifact previews/);
    if (native) assert.doesNotMatch(run(true), /Artifact previews/);
  });

test('Claude receives the same contract in MCP instructions using its own qualified tool name', async () => {
  const options: any = { systemPrompt: { type: 'preset', preset: 'claude_code' } };
  const state = {
    sdk: async () => ({ tool: fakeSdk.tool, createSdkMcpServer: (o: any) => o }),
    sageTools: { registry: registry(), sessions: new ToolSessions(), enabled: () => true },
  };
  await prepareSessionTools(state, { takesPluginDirs: () => false }, '/cli', options, {}, { chatId: 'chat' }, 'key', () => 'chat');
  const [server, value] = Object.entries(options.mcpServers)[0] as [string, any];
  assertArtifact(value.instructions, claudeNames(server).name('show_pane'));
  assert.deepEqual(options.systemPrompt, { type: 'preset', preset: 'claude_code' });
});

test('ACP sends the artifact rule to the model before the first prompt without putting it in the user message', async () => {
  const sent: any[] = [];
  const turns = new AcpTurns({
    send: async (_chat: string, _key: string, payload: any) => (sent.push(payload), { turnId: `turn-${sent.length}` }),
    rename: () => {},
    readImage: async () => null,
    named: () => true,
    toolsNote: () => registryNote(registry(), null),
  });
  const ref = { kind: 'acp:opencode', id: 'native', key: 'acp:opencode:native' };
  await turns.startTurn('chat', ref, { text: 'Create an architecture canvas' });
  assertArtifact(sent[0].blocks[0].text);
  assert.deepEqual(sent[0].blocks[0].annotations, { audience: ['assistant'] });
  assert.doesNotMatch(JSON.stringify(sent[0].display), /Artifact previews/);
  await turns.startTurn('chat', ref, { text: 'Update the report' });
  assert.deepEqual(sent[1].blocks, [{ type: 'text', text: 'Update the report' }]);
});
