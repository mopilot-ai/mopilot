// One chat never reaches another chat's MoPilot tool server on an ACP harness (#2311, #2302): a harness that shares
// MCP servers per folder (opencode) gives each chat a process of its own, and a call naming a server that is not the
// chat's own is refused (permission) or stopped (turn), whichever chat the server belongs to.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { setup, settle, KEY, dir as tmp } from './support/acp-host/fixture';

const require = createRequire(import.meta.url);
const { isForeignSageCall, sageServersCalled } = require('../electron/harness/acp/clientMethods.cjs');

const OWN = 'sage_0123456789ab';
const OTHER = 'sage_ba9876543210';
const options = [
  { optionId: 'a', kind: 'allow_once' },
  { optionId: 'r', kind: 'reject_once' },
];
const folder = () => fs.mkdtempSync(path.join(tmp, 'ws-'));
const byDefault = { label: 'Fake', args: ['acp'] };
const sessionScoped = { label: 'Fake', args: ['acp'], mcpScope: 'session' };

function world(quirks: any = byDefault) {
  return setup({
    quirks: (id: string) => (id === 'fake' ? quirks : null),
    handlers: { 'session/new': () => ({ sessionId: `s-${Math.random().toString(36).slice(2, 8)}` }) },
  });
}
const ask = (t: any, chat: any, toolCall: any) =>
  t.host.onAgentRequest(chat.agent, 'session/request_permission', { sessionId: chat.sessionId, toolCall, options });

test('by default every chat holds a process alone; only a quirk claiming per-session MCP servers shares one', async () => {
  const t = world();
  const ws = folder();
  const [a, b] = await Promise.all([t.host.ensure(KEY, { cwd: ws }), t.host.ensure('acp:fake:c2', { cwd: ws })]);
  assert.notEqual(a.agent, b.agent);
  assert.equal(a.isolated, false, 'a coding chat keeps its capabilities');
  for (const proc of t.sp.procs) assert.equal(proc.received.filter((m: any) => m.method === 'session/new').length, 1);
  t.host.close(KEY);
  await settle();
  assert.ok(t.sp.procs[0].stdin.ended);
  assert.equal(t.sp.procs[1].stdin.ended, false);
  t.host.closeAll();
  const s = world(sessionScoped);
  const [c, d] = await Promise.all([s.host.ensure(KEY, { cwd: ws }), s.host.ensure('acp:fake:c2', { cwd: ws })]);
  assert.equal(c.agent, d.agent);
  // on the shared process each session/new carries only that chat's own server, as the claim is
  const opened = s.sp.procs[0].received.filter((m: any) => m.method === 'session/new');
  assert.equal(opened.length, 2);
  for (const m of opened)
    assert.deepEqual(
      m.params.mcpServers.map((x: any) => x.name),
      [OWN],
    );
  s.host.closeAll();
});

test('a permission request for another chat’s tool server is refused without a card, even in a coding chat', async () => {
  const t = world();
  const chat = await t.host.ensure(KEY, { cwd: folder() });
  chat.serverName = OWN;
  assert.deepEqual(await ask(t, chat, { title: `mcp__${OWN}__echo` }), { outcome: { outcome: 'selected', optionId: 'a' } });
  for (const title of [`mcp__${OTHER}__echo`, `${OTHER}/echo`, `echo (${OTHER} MCP Server)`])
    assert.deepEqual(await ask(t, chat, { title }), { outcome: { outcome: 'selected', optionId: 'r' } }, title);
  assert.deepEqual(await ask(t, chat, { title: 'x', _meta: { claude: { toolName: `mcp__${OTHER}__echo` } } }), {
    outcome: { outcome: 'selected', optionId: 'r' },
  });
  // fail closed: a chat with no server of its own can't call any
  chat.serverName = null;
  assert.deepEqual(await ask(t, chat, { title: `mcp__${OWN}__echo` }), { outcome: { outcome: 'selected', optionId: 'r' } });
  assert.equal(t.events.filter((e: any) => e.kind === 'permission').length, 0);
  t.host.closeAll();
});

test('a tool call naming another chat’s server stops the turn and shows as failed, not as this chat’s call', async () => {
  const t = world();
  const chat = await t.host.ensure(KEY, { cwd: folder() });
  chat.serverName = OWN;
  const update = (u: any) => t.host.onAgentNotification(chat.agent, 'session/update', { sessionId: chat.sessionId, update: u });
  update({ sessionUpdate: 'tool_call', toolCallId: '1', title: `mcp__${OWN}__echo`, status: 'pending' });
  update({ sessionUpdate: 'tool_call', toolCallId: '2', title: `mcp__${OTHER}__send_message`, status: 'pending' });
  const shown = t.events.filter((e: any) => e.kind === 'update').map((e: any) => e.update);
  assert.equal(shown[0].status, 'pending');
  assert.equal(shown[1].status, 'failed');
  assert.match(shown[1].rawOutput, /Refused/);
  assert.ok(t.sp.procs[0].received.some((m: any) => m.method === 'session/cancel'));
  t.host.closeAll();
});

test('the parser names every server a call mentions only where a tool name sits, never in arguments', () => {
  assert.deepEqual([...sageServersCalled({ title: `mcp__${OWN}__a` })], [OWN]);
  assert.equal(sageServersCalled({ title: 'run', rawInput: { command: `mcp__${OTHER}__a` } }).size, 0);
  assert.equal(sageServersCalled({ kind: 'execute', title: `mcp__${OTHER}__a` }).size, 0);
  assert.equal(sageServersCalled(null).size, 0);
  assert.equal(sageServersCalled({ title: 5, _meta: { a: 1 } }).size, 0);
  assert.equal(isForeignSageCall({ title: `mcp__${OWN}__a` }, OWN), false);
  assert.equal(isForeignSageCall({ title: `mcp__${OTHER}__a` }, OWN), true);
  assert.equal(isForeignSageCall({ title: 'Read file' }, OWN), false);
});

test('a chat takes the process a prewarm started; a second chat starts its own', async () => {
  const t = world();
  const warm = await t.host.agent('fake');
  const a = await t.host.ensure(KEY, { cwd: folder() });
  assert.equal(a.agent, warm, 'adopted, not a second process');
  assert.equal(t.host.agents.has('fake'), false);
  assert.equal(t.host.codingAgents.size, 1);
  const b = await t.host.ensure('acp:fake:c2', { cwd: folder() });
  assert.notEqual(b.agent, a.agent);
  assert.equal(t.sp.calls.length, 2);
  t.host.closeAll();
  assert.equal(t.host.codingAgents.size, 0);
});

test('a sign-in uses a chat’s own process when one runs', async () => {
  const t = world();
  const a = await t.host.ensure(KEY, { cwd: folder() });
  assert.equal(await t.host.agentForLogin('fake'), a.agent);
  t.host.closeAll();
});
