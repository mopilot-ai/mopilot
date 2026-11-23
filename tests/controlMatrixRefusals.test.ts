// The control matrix's refusal-wins cases (docs/control-plane/matrix.md, group Q): a computer-use call refused because
// nobody is there to give an OK pauses its chat, and that pause aborts the call; the call still answers with the
// refusal's own text on every channel (Codex item/tool/call, sage-mcp, the Claude SDK's MCP server), even when the
// chat's previous turn ended late while the call was in its checks (its epoch moved, or its turn token was retired).
// The Registry, the computer-use tools, the tool socket and the channels are the real modules; the helper is a fake.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fakeSdk, z, registryNameOf, sageMcpClient } from './support/control-matrix-kit.ts';
import { waitFor } from './support/waitFor.ts';

export const GUARDS = ['electron/', 'shared/'];

const require = createRequire(import.meta.url);
const { Registry } = require('../electron/capabilities/contract/registry.cjs');
const { recordRefusal, guarded } = require('../electron/capabilities/contract/actionGuard.cjs');
const { ComputerUse } = require('../electron/capabilities/tools/computer.cjs');
const { codexServerRequests } = require('../electron/capabilities/contract/serverRequests.cjs');
const { sdkMcpServers } = require('../electron/capabilities/mcp/sdkMcp.cjs');
const { ToolSessions } = require('../electron/capabilities/contract/session.cjs');
const { ToolSocket } = require('../electron/capabilities/mcp/socket.cjs');

const NOTES = { bundleId: 'com.apple.Notes', name: 'Notes', pid: 7 };
const REFUSAL = /^Controlling Notes needs the user's OK, and nobody is here to give it \(a turn MoPilot started\)/;

type Race = 'none' | 'epoch' | 'token';
const races: Race[] = ['none', 'epoch', 'token'];

/**
 * A Registry with the real computer_* tools over a fake helper, no grants, and nobody there. While the call reads
 * whether anyone is there, the chat's previous turn ends late (`race`): its epoch moves (the desktop's turn end) or
 * its turn token is retired (the ledger). The refusal then pauses the chat as main does (computerUse.cjs
 * onUnattended: the refusal is recorded, then the stop aborts the chat's calls before it awaits anything).
 */
function rig(race: Race) {
  const r = new Registry();
  const helper = {
    running: true,
    start: async () => ({}),
    targetInfo: async () => NOTES,
    glowStart: async () => {},
    glowStop: async () => {},
  };
  const paused: string[] = [];
  const cu = new ComputerUse({
    helper,
    grants: { forChat: () => [], deny: () => [], grant: () => {} },
    broker: { ask: async () => assert.fail('no card while nobody is here') },
    session: () => ({ modality: 'image' }),
    chatOf: (id: string) => id,
    unattended: async (chatId: string) => {
      await new Promise((resolve) => setImmediate(resolve));
      if (race === 'epoch') cu.interrupt(chatId);
      if (race === 'token') r.turns.retire(chatId);
      return 'a turn MoPilot started';
    },
    onUnattended: (chatId: string, e: { code: string; message: string }) => {
      recordRefusal(e.code, e.message);
      paused.push(chatId);
      r.abortChat(chatId, 'stopped');
    },
  });
  for (const t of cu.tools()) r.register(t);
  return { r, paused };
}

test("CM-Q07: Codex item/tool/call: a refused call's pause never replaces its refusal, even after a late turn end", async () => {
  for (const race of races) {
    const { r, paused } = rig(race);
    const sent: any[] = [];
    const handle = codexServerRequests({ send: (m: any) => sent.push(m), registry: r });
    const params = { threadId: 'cx-1', callId: 'k1', tool: 'computer_click', arguments: { x: 1, y: 2 } };
    assert.equal(handle({ id: 9, method: 'item/tool/call', params }), true);
    await waitFor(() => sent.length, 'a sent reply');
    assert.equal(sent.length, 1, race);
    assert.equal(sent[0].result.success, false, race);
    assert.match(sent[0].result.contentItems[0].text, REFUSAL, race);
    assert.deepEqual(paused, ['cx-1'], race);
  }
});

test("CM-Q08: sage-mcp (a Codex thread's MCP session): a refused call's pause never replaces its refusal", async () => {
  for (const race of races) {
    const { r, paused } = rig(race);
    const sessions = new ToolSessions();
    const socket = new ToolSocket({ sessions, registry: r, verifyPeer: async () => null });
    try {
      const socketPath = await socket.listen();
      const { token } = sessions.open('cx-1', { harnessPid: 1 });
      const client = await sageMcpClient(socketPath, token);
      const res = await client.request('tools/call', { name: 'computer_click', arguments: { x: 1, y: 2 } });
      assert.equal(res.result.isError, true, race);
      assert.match(res.result.content[0].text, REFUSAL, race);
      assert.deepEqual(paused, ['cx-1'], race);
    } finally {
      socket.close();
    }
  }
});

test("CM-Q09: Claude Code's SDK MCP server: a refused call's pause never replaces its refusal", async () => {
  for (const race of races) {
    const { r, paused } = rig(race);
    const owner = { chatId: 'c1', segmentId: 's1' };
    const servers = sdkMcpServers({ sdk: fakeSdk, z, registry: r, serverName: 'sage_aaaaaaaaaaaa', owner });
    const handler = [...servers.values()]
      .flatMap((s: any) => s.tools.map((t: any) => ({ name: registryNameOf(s.name, t.name, r), handler: t.handler })))
      .find((t: any) => t.name === 'computer_click')?.handler;
    assert.ok(handler, 'computer_click is presented to the Claude session');
    const extra = { _meta: { 'claudecode/toolUseId': `toolu_${race}` }, signal: new AbortController().signal };
    const res = await handler({ x: 1, y: 2 }, extra);
    assert.equal(res.isError, true, race);
    assert.match(res.content[0].text, REFUSAL, race);
    assert.deepEqual(paused, ['c1'], race);
  }
});

test('CM-Q10: a refusal recorded after a Stop already aborted the call keeps the Stop; nothing is recorded outside a call', () => {
  let reports = 0;
  const onRefusal = () => reports++;
  // aborted (Stop, the harness's cancel): the Stop is what the call answers
  guarded({ signal: AbortSignal.abort(), onRefusal }, () => recordRefusal('unattended', 'too late'));
  // an inner guard whose own signal is live, inside an aborted call: still the Stop
  guarded({ signal: AbortSignal.abort(), onRefusal }, () =>
    guarded({ signal: new AbortController().signal }, () => recordRefusal('unattended', 'too late')),
  );
  assert.equal(reports, 0);
  // a call whose epoch moved (its turn ended late) still records why it was refused
  let epoch = 0;
  guarded({ onRefusal }, () =>
    guarded({ epoch: () => epoch }, () => {
      epoch++;
      recordRefusal('unattended', 'refused');
    }),
  );
  assert.equal(reports, 1);
  recordRefusal('unattended', 'outside a call');
  assert.equal(reports, 1);
});
