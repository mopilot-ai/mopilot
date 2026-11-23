// Exercises the scripted Claude fixture's permission decisions, MCP calls and tool-result lifecycle.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeClaudeTools } from './e2e/fixtures/fake-claude-tools.mjs';

const SERVER = 'sage_123456abcdef';
function fixture() {
  const state = { permissionMode: 'default', sdkServers: [SERVER, 'other'] };
  const allowedTools: string[] = [];
  const asks: any[] = [];
  const events: any[] = [];
  const logs: any[] = [];
  const records: any[] = [];
  const peer: any = {
    permission: { response: { behavior: 'allow' } },
    listed: { result: { tools: [{ name: 'sage_debug_echo', _meta: { 'anthropic/alwaysLoad': true } }] } },
    called: { result: { content: [{ type: 'text', text: 'answer' }] } },
  };
  const tools = createFakeClaudeTools({
    version: 'test-version',
    sessionId: 'session',
    allowedTools,
    state,
    resolvedModel: () => 'model',
    send: (event: any) => events.push(event),
    log: (entry: any) => logs.push(entry),
    record: (type: string, entry: any) => records.push({ type, ...entry }),
    askSdk: async (request: any) => {
      asks.push(request);
      if (request.subtype === 'can_use_tool') return peer.permission;
      const method = request.message.method;
      return { response: { mcp_response: await (method === 'tools/list' ? peer.listed : method === 'tools/call' ? peer.called : {}) } };
    },
  });
  return { ...tools, state, allowedTools, asks, events, logs, records, peer };
}

test('permission checks use current mode and allowlist before asking the SDK, with absent replies denied', async () => {
  const f = fixture();
  f.state.permissionMode = 'bypassPermissions';
  assert.equal(await f.permit('Bash', {}), 'allow');
  f.state.permissionMode = 'default';
  f.allowedTools.push('Bash');
  assert.equal(await f.permit('Bash', {}), 'allow');
  f.state.permissionMode = 'acceptEdits';
  for (const name of ['Edit', 'Write']) assert.equal(await f.permit(name, {}), 'allow');
  f.state.permissionMode = 'dontAsk';
  assert.equal(await f.permit('WebFetch', {}), 'deny');
  assert.equal(f.asks.length, 0);
  f.state.permissionMode = 'acceptEdits';
  assert.equal(await f.permit('WebFetch', { url: 'url' }, { name: SERVER, source: 'sdk' }), 'allow');
  assert.equal(f.asks[0].subtype, 'can_use_tool');
  assert.deepEqual(f.asks[0].input, { url: 'url' });
  assert.deepEqual(f.asks[0].mcp_server, { name: SERVER, source: 'sdk' });
  assert.match(f.asks[0].tool_use_id, /^toolu_fake_/);
  for (const response of [null, {}, { response: {} }, { response: { behavior: 'deny' } }]) {
    f.peer.permission = response;
    assert.equal(await f.permit('WebFetch', {}), 'deny');
  }
});

test('SDK echo calls select sage servers, initialize with the fixture version and preserve errors and metadata', async () => {
  for (const kind of ['allow', 'deny', 'missing', 'absent-list', 'absent-tools', 'peer-error', 'empty-call', 'missing-content']) {
    const f = fixture();
    if (kind === 'deny') f.peer.permission = { response: { behavior: 'deny' } };
    if (kind === 'missing') f.peer.listed = { result: { tools: [] } };
    if (kind === 'absent-list') f.peer.listed = undefined;
    if (kind === 'absent-tools') f.peer.listed = { result: {} };
    if (kind === 'peer-error') f.peer.called = { error: { message: 'failed' } };
    if (kind === 'empty-call') f.peer.called = undefined;
    if (kind === 'missing-content') f.peer.called = { result: {} };
    const expected =
      kind === 'allow'
        ? 'answer'
        : kind === 'deny'
          ? 'deny'
          : ['missing', 'absent-list', 'absent-tools'].includes(kind)
            ? 'missing'
            : kind === 'peer-error'
              ? 'failed'
              : 'undefined';
    assert.equal(await f.callSdkMcp('word'), ` [mcp: ${expected}]`);
    assert.equal(f.asks[0].message.params.clientInfo.version, 'test-version');
    assert.equal(f.logs.length, 1);
    assert.equal(f.logs[0].server, SERVER);
    assert.equal(f.logs[0].alwaysLoad, !['missing', 'absent-list', 'absent-tools'].includes(kind));
    assert.ok(f.asks.every((request: any) => request.server_name !== 'other'));
  }
  const f = fixture();
  f.state.sdkServers = [];
  assert.equal(await f.callSdkMcp('word'), '');
});

test('SDK tool calls preserve result blocks, step records, parent routing and full server names', async () => {
  const f = fixture();
  f.peer.called = {
    result: {
      content: [
        { type: 'image', mimeType: 'image/png', data: 'pixels' },
        { type: 'text', text: 'done' },
      ],
    },
  };
  assert.equal(await f.callSdkTool('click', { x: 1 }, null, { step: true }), ' [cu: <image> done]');
  assert.deepEqual(
    f.events.map((event: any) => event.type),
    ['assistant', 'user'],
  );
  assert.deepEqual(
    f.records.map((entry: any) => entry.type),
    ['assistant', 'user'],
  );
  assert.deepEqual(f.events[1].message.content[0].content, [
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'pixels' } },
    { type: 'text', text: 'done' },
  ]);
  assert.equal(f.events[1].message.content[0].is_error, undefined);
  assert.equal(f.events[0].session_id, 'session');
  assert.equal(f.events[0].message.model, 'model');
  assert.deepEqual(f.asks.at(-1).message.params.arguments, { x: 1 });
  assert.equal(f.asks.at(-1).message.params._meta['claudecode/toolUseId'], f.events[0].message.content[0].id);
  f.events.length = 0;
  f.records.length = 0;
  f.state.sdkServers = ['mopilot_browser'];
  assert.equal(await f.callSdkTool('mcp__mopilot_browser__open', {}, 'parent', { step: true }), ' [cu: <image> done]');
  assert.equal(f.events.length, 1);
  assert.equal(f.events[0].parent_tool_use_id, 'parent');
  assert.equal(f.records.length, 0);
  assert.equal(f.logs.at(-1).tool, 'open');
  assert.equal(await f.callSdkTool('mcp__absent__open', {}), '');
});

test('SDK tool calls preserve denial, peer failures, empty fallback and interruption without a completed peer reply', async () => {
  for (const kind of ['denied', 'is-error', 'peer-error', 'empty', 'no-content', 'cut']) {
    const f = fixture();
    if (kind === 'denied') f.peer.permission = { response: { behavior: 'deny' } };
    if (kind === 'is-error') f.peer.called = { result: { isError: true, content: [{ type: 'text', text: 'bad' }] } };
    if (kind === 'peer-error') f.peer.called = { error: { message: 'failed' } };
    if (kind === 'empty') f.peer.called = undefined;
    if (kind === 'no-content') f.peer.called = { result: {} };
    if (kind === 'cut') f.peer.called = new Promise(() => {});
    const expected =
      kind === 'denied'
        ? 'deny'
        : kind === 'is-error'
          ? 'error: bad'
          : kind === 'peer-error'
            ? 'failed'
            : kind === 'cut'
              ? 'interrupted'
              : 'undefined';
    assert.equal(
      await f.callSdkTool('click', {}, null, { step: true, cut: kind === 'cut' ? Promise.resolve() : null }),
      ` [cu: ${expected}]`,
    );
    const result = f.events.at(-1).message.content[0];
    assert.equal(result.is_error, kind === 'no-content' ? undefined : true);
    if (kind === 'cut') assert.deepEqual(result.content, [{ type: 'text', text: '[Request interrupted by user for tool use]' }]);
  }
  const f = fixture();
  assert.equal(await f.callSdkTool('click', {}), ' [cu: answer]');
  assert.equal(f.events.length, 0);
  assert.equal(f.records.length, 0);
});

test('MCP IDs belong to the connection across tool and echo invocations', async () => {
  const f = fixture();
  await f.callSdkTool('start_session', {});
  await f.callSdkMcp('echo');
  await f.callSdkTool('start_session', {});
  const ids = f.asks.filter((r: any) => r.subtype === 'mcp_message').map((r: any) => r.message.id);
  assert.equal(new Set(ids).size, ids.length);
});

for (const oldFirst of [true, false]) {
  test(`an interrupted MCP reply cannot replace its successor (${oldFirst ? 'old' : 'new'} response first)`, async () => {
    const pending = new Map<string, (value: any) => void>();
    const requests: { key: string; resolve: (value: any) => void }[] = [];
    const logs: any[] = [];
    let reached!: () => void;
    const nextRequest = () =>
      new Promise<void>((resolve) => {
        reached = resolve;
      });
    const tools = createFakeClaudeTools({
      version: 'test',
      sessionId: 'session',
      allowedTools: [],
      state: { permissionMode: 'bypassPermissions', sdkServers: [SERVER] },
      resolvedModel: () => 'model',
      send() {},
      record() {},
      log: (entry: any) => logs.push(entry),
      askSdk: async (request: any) => {
        const { id, method } = request.message;
        if (method !== 'tools/call') return { response: { mcp_response: {} } };
        return new Promise((resolve) => {
          const key = `${request.server_name}:${id}`;
          pending.set(key, resolve);
          requests.push({ key, resolve });
          reached();
        });
      },
    });
    let interrupt!: () => void;
    const cut = new Promise<void>((resolve) => {
      interrupt = resolve;
    });
    const firstReached = nextRequest();
    const first = tools.callSdkTool('start_session', { title: 'old' }, null, { cut });
    await firstReached;
    interrupt();
    assert.equal(await first, ' [cu: interrupted]');
    const secondReached = nextRequest();
    const second = tools.callSdkTool('start_session', { title: 'new' });
    await secondReached;
    assert.notEqual(requests[0].key, requests[1].key, 'late replies must retain their original request identity');
    const settle = (index: number, text: string) => {
      const key = requests[index].key;
      const resolve = pending.get(key)!;
      pending.delete(key);
      resolve({ response: { mcp_response: { result: { content: [{ type: 'text', text }] } } } });
    };
    if (oldFirst) settle(0, 'start_cancelled');
    settle(1, 'started');
    assert.equal(await second, ' [cu: started]');
    if (!oldFirst) settle(0, 'start_cancelled');
    assert.deepEqual(
      logs.map((entry) => entry.text),
      ['interrupted', 'started'],
    );
    assert.equal(pending.size, 0);
  });
}
