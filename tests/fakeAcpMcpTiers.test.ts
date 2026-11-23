// The fake ACP executor must follow the actual session's tool tiers and preserve MCP failures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mcpWords } from './fixtures/fake-acp-mcp.mjs';
import { world } from './support/tool-tiers-kit.ts';

async function setup(tiered: boolean, hide?: (name: string) => boolean) {
  const w = world();
  w.sessions.open('fixture-session', { chatId: 'chat', segmentId: 'segment', tiered, hide });
  const wire: { name: string; arguments: any }[] = [];
  const server = {
    tools: await w.list('fixture-session'),
    call: async (method: string, args: any) => {
      assert.equal(method, 'tools/call');
      wire.push(args);
      return w.call('fixture-session', args.name, args.arguments);
    },
  };
  const updates: any[] = [];
  const logs: any[] = [];
  const run = (tool: string, args: object) =>
    mcpWords(`MCPTOOL ${tool} ${JSON.stringify(args)}`, new Map([['fixture', server]]), {
      update: (event: any) => updates.push(event),
      log: (event: any) => logs.push(event),
      sessionId: 'fixture-session',
    });
  return { w, server, wire, updates, logs, run };
}

for (const tiered of [true, false]) {
  test(`fake ACP executes browser, Chrome and desktop calls against real tiered=${tiered} sessions`, async () => {
    const { w, wire, updates, logs, run } = await setup(tiered);
    const cases = [
      ['browser_navigate', { url: 'https://example.com' }, 'browser_navigate'],
      ['browser_get_page_text', {}, 'browser_more_tools'],
      ['chrome_get_page_text', { tabId: 1 }, 'browser_more_tools'],
      ['desktop_app_scroll', { app: 'Notes', dy: 3 }, 'desktop_more_tools'],
    ] as const;
    for (const [tool, args, deferred] of cases) {
      assert.match(await run(tool, args), new RegExp(`ran ${tool}`));
      const actual = tiered ? deferred : tool;
      const input = actual === tool ? args : { call: tool, arguments: args };
      assert.deepEqual(wire.at(-1), { name: actual, arguments: input });
      assert.deepEqual(w.calls.at(-1), { name: tool, args, chatId: 'chat', segmentId: 'segment' });
      assert.equal(updates.at(-2).title, `fixture_${actual}`);
      assert.deepEqual(updates.at(-2).rawInput, input);
      assert.equal(updates.at(-1).status, 'completed');
      assert.equal(updates.at(-1).toolCallId, updates.at(-2).toolCallId);
      assert.equal(logs.at(-1).sessionId, 'fixture-session');
    }
    assert.equal(new Set(updates.filter((u) => u.sessionUpdate === 'tool_call').map((u) => u.toolCallId)).size, cases.length);
  });
}

test('fake ACP preserves missing capabilities and unknown tools instead of routing them to another tool', async () => {
  const { w, server, updates, run } = await setup(true);
  server.tools = [];
  assert.match(await run('browser_get_page_text', {}), /no server lists browser_get_page_text/);
  assert.match(await run('unknown_fixture_tool', {}), /no server lists unknown_fixture_tool/);
  assert.deepEqual(w.calls, []);
  assert.deepEqual(updates, []);
});

test('a more tool still enforces the receiving session visibility and reports the refusal', async () => {
  const { w, updates, run } = await setup(true, (name) => name === 'browser_get_page_text');
  assert.match(await run('browser_get_page_text', {}), /not a tool browser_more_tools runs here/);
  assert.deepEqual(w.calls, []);
  assert.equal(updates.at(-1).status, 'failed');
});

test('thrown MCP errors fail both directly listed and deferred scripted calls and a retry can succeed', async () => {
  for (const tool of ['browser_navigate', 'browser_get_page_text']) {
    const { server, updates, run } = await setup(true);
    const call = server.call;
    server.call = async () => {
      throw new Error('fixture transport failed');
    };
    assert.match(await run(tool, {}), /fixture transport failed/);
    assert.equal(updates.at(-1).status, 'failed');
    server.call = call;
    assert.match(await run(tool, tool === 'browser_navigate' ? { url: 'https://example.com' } : {}), new RegExp(`ran ${tool}`));
    assert.equal(updates.at(-1).status, 'completed');
  }
});

test('MCPCALL echo controls retain their wire arguments and error text without synthetic tool steps', async () => {
  const updates: any[] = [];
  const logs: any[] = [];
  const wire: any[] = [];
  const server = {
    call: async (method: string, args: any) => {
      wire.push({ method, args });
      if (args.arguments.text === 'fail') throw 'fixture echo failed';
      return { content: [{ type: 'text', text: args.arguments.text }] };
    },
  };
  const run = (text: string) =>
    mcpWords(text, new Map([['fixture', server]]), {
      update: (event: any) => updates.push(event),
      log: (event: any) => logs.push(event),
      sessionId: 'echo-session',
    });
  assert.equal(await run('MCPCALL hello'), ' [mcp fixture: hello]');
  assert.equal(await run('MCPCALL fail'), ' [mcp fixture: fixture echo failed]');
  assert.deepEqual(
    wire.map((call) => call.args),
    [
      { name: 'sage_debug_echo', arguments: { text: 'hello' } },
      { name: 'sage_debug_echo', arguments: { text: 'fail' } },
    ],
  );
  assert.ok(wire.every((call) => call.method === 'tools/call'));
  assert.deepEqual(updates, []);
  assert.equal(logs.at(-1).kind, 'mcpCall');
  assert.equal(logs.at(-1).sessionId, 'echo-session');
});
