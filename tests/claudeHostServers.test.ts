// Claude's view of the Registry's host tool sets (electron/capabilities/contract/hostServers.cjs and
// sdkMcp.cjs): browser_* and desktop_* tools on servers of their own under short names, every other
// tool on the session's sage_<nonce> server, descriptions rewritten to the names Claude sees, the
// read-only allowlist and canUseTool's exact-name auto-allow. Driven through the Agent SDK's real
// in-process MCP servers and an MCP client.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as sdk from '@anthropic-ai/claude-agent-sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { browserToolSpecs } from './support/tool-specs.ts';

const require = createRequire(import.meta.url);
const z = require('zod');
const { Registry } = require('../electron/capabilities/contract/registry.cjs');
const hostServers = require('../electron/capabilities/contract/hostServers.cjs');
const { HOST_SERVERS, HOST_SERVER_NAMES, RESERVED, isReserved, placement, nameRewriter, rewriteSchema } = hostServers;
const {
  sdkMcpServer,
  sdkMcpServers,
  readOnlyAllowedTools,
  injectSdkMcp,
  injectSdkMcpServers,
  autoAllow,
} = require('../electron/capabilities/mcp/sdkMcp.cjs');

const SAGE = 'sage_aaaaaaaaaaaa';
const owner = { chatId: 'chat-1', segmentId: 'seg-1' };

/** A Registry with one sage tool, two browser tools and two desktop tools whose texts name each other. */
function registry() {
  const r = new Registry();
  const calls: any[] = [];
  const add = (name: string, policy: string, description: string, inputSchema: any = { type: 'object', properties: {} }) =>
    r.register({
      name,
      description,
      schema: inputSchema,
      policy,
      authorizesItself: true,
      handler: (args: any) => (calls.push({ name, args }), `${name} ran`),
    });
  add('sage_debug_echo', 'observe', 'Echo. See browser_navigate and desktop_screenshot.', {
    type: 'object',
    properties: { text: { type: 'string' } },
  });
  add('browser_navigate', 'observe', 'Open a URL. Then browser_read_page; for the desktop use desktop_screenshot.', {
    type: 'object',
    properties: { url: { type: 'string', description: 'Like browser_navigate does. Not browser_navigatex.' } },
    required: ['url'],
  });
  add('browser_read_page', 'observe', 'Read the page.');
  add('browser_batch', 'act', 'Run several browser tools; browser_navigate first.', {
    type: 'object',
    properties: { actions: { type: 'array', items: { type: 'object' } } },
    required: ['actions'],
  });
  add('desktop_screenshot', 'observe', 'A screenshot. In a browser, use browser_navigate.');
  add('desktop_batch', 'act', 'Several desktop actions; desktop_screenshot first.');
  return { r, calls };
}

async function connect(server: any) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(a);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(b);
  return client;
}

test('hostServers: fixed, non-reserved server names; placement by prefix with the batch renames', () => {
  assert.deepEqual(HOST_SERVER_NAMES, [
    'mopilot_browser',
    'mopilot_computer',
    'mopilot_chrome',
    'mopilot_ios_simulator',
    'mopilot_android_emulator',
  ]);
  // the user's Chrome over MoPilot's relay (B2): Claude in Chrome's names, on a server that is not the reserved one
  assert.deepEqual(placement('chrome_tabs_context_mcp', 'sage_x'), { server: 'mopilot_chrome', name: 'tabs_context_mcp' });
  assert.equal(isReserved('mopilot_chrome'), false);
  assert.ok(Object.isFrozen(HOST_SERVERS) && HOST_SERVERS.every((h: any) => Object.isFrozen(h) && Object.isFrozen(h.rename)));
  for (const r of RESERVED) assert.equal(isReserved(r), true);
  // compared without case or separators
  assert.equal(isReserved('claude_browser'), true);
  assert.equal(isReserved('Computer Use'), true);
  assert.equal(isReserved('CLAUDE-IN-CHROME'), true);
  assert.equal(isReserved('mopilot_browser'), false);
  for (const name of HOST_SERVER_NAMES) assert.equal(isReserved(name), false);

  assert.deepEqual(placement('browser_navigate', SAGE), { server: 'mopilot_browser', name: 'navigate' });
  assert.deepEqual(placement('browser_batch', SAGE), { server: 'mopilot_browser', name: 'browser_batch' });
  assert.deepEqual(placement('browser_script', SAGE), { server: 'mopilot_browser', name: 'browser_script' });
  assert.deepEqual(placement('desktop_left_click', SAGE), { server: 'mopilot_computer', name: 'left_click' });
  assert.deepEqual(placement('desktop_batch', SAGE), { server: 'mopilot_computer', name: 'computer_batch' });
  // the bare prefix, other tools and the legacy sage_browser_* stay on the sage server
  assert.deepEqual(placement('browser_', SAGE), { server: SAGE, name: 'browser_' });
  assert.deepEqual(placement('desktop_', SAGE), { server: SAGE, name: 'desktop_' });
  assert.deepEqual(placement('sage_browser_navigate', SAGE), { server: SAGE, name: 'sage_browser_navigate' });
});

test('hostServers: the reserved-name guard refuses a host server named like the vendor servers', () => {
  const file = require.resolve('../electron/capabilities/contract/hostServers.cjs');
  const saved = require.cache[file];
  const freeze = Object.freeze;
  // load a copy whose first host server is called "Claude_Browser"
  Object.freeze = ((o: any) => (o && o.server === 'mopilot_browser' ? freeze({ ...o, server: 'Claude_Browser' }) : freeze(o))) as any;
  delete require.cache[file];
  try {
    assert.throws(() => require(file), /Claude_Browser is a reserved MCP server name/);
  } finally {
    Object.freeze = freeze;
    require.cache[file] = saved;
  }
});

test('hostServers: names are rewritten to what Claude sees; schemas are copied only when they change', () => {
  const placed = new Map([
    ['browser_navigate', { server: 'mopilot_browser', name: 'navigate' }],
    ['browser_navigate_back', { server: 'mopilot_browser', name: 'navigate_back' }],
    ['desktop_screenshot', { server: 'mopilot_computer', name: 'screenshot' }],
    ['sage_debug_echo', { server: SAGE, name: 'sage_debug_echo' }],
  ]);
  const rw = nameRewriter(placed);
  const inBrowser = rw('mopilot_browser');
  // the longest name wins; whole words only; other servers' tools get their full name
  assert.equal(
    inBrowser('Use browser_navigate_back, browser_navigate or desktop_screenshot; not xbrowser_navigate.'),
    'Use navigate_back, navigate or mcp__mopilot_computer__screenshot; not xbrowser_navigate.',
  );
  assert.equal(rw(SAGE)('browser_navigate and sage_debug_echo'), 'mcp__mopilot_browser__navigate and sage_debug_echo');
  assert.equal(inBrowser(undefined), undefined);
  assert.equal(inBrowser(42 as any), 42);
  // nothing hosted: text passes through
  const none = nameRewriter(new Map([['sage_debug_echo', { server: SAGE, name: 'sage_debug_echo' }]]));
  assert.equal(none(SAGE)('browser_navigate'), 'browser_navigate');

  const schema = {
    type: 'object',
    properties: { url: { type: 'string', description: 'see browser_navigate' }, n: { type: 'integer', minimum: 1 } },
  };
  const out = rewriteSchema(schema, inBrowser);
  assert.notEqual(out, schema);
  assert.equal(out.properties.url.description, 'see navigate');
  assert.equal(out.properties.n.minimum, 1);
  assert.equal(schema.properties.url.description, 'see browser_navigate', "the Registry's own schema is untouched");
  const plain = { type: 'object', properties: { q: { type: 'string' } } };
  assert.equal(rewriteSchema(plain, inBrowser), plain, 'unchanged: the same object');
  assert.equal(rewriteSchema(null, inBrowser), null);
  assert.equal(rewriteSchema(undefined, inBrowser), undefined);
  assert.equal(rewriteSchema('browser_navigate', inBrowser), 'browser_navigate');
});

test('sdkMcp: one SDK server per set, short names, rewritten texts, and calls reach the Registry under its own names', async () => {
  const { r, calls } = registry();
  const seen: any[] = [];
  const orig = r.invoke.bind(r);
  r.invoke = (chatId: string, segmentId: string, tool: string, args: any, o: any) => (
    seen.push({ chatId, segmentId, tool, callId: o.callId }), orig(chatId, segmentId, tool, args, o)
  );
  const servers = sdkMcpServers({ sdk, z, registry: r, serverName: SAGE, owner });
  assert.deepEqual([...servers.keys()], [SAGE, 'mopilot_browser', 'mopilot_computer'], 'the sage server first');
  for (const [name, s] of servers) assert.equal(s.name, name);

  const browser = await connect(servers.get('mopilot_browser'));
  const listed = (await browser.listTools()).tools;
  assert.deepEqual(listed.map((t: any) => t.name).sort(), ['browser_batch', 'navigate', 'read_page']);
  const nav = listed.find((t: any) => t.name === 'navigate')!;
  assert.equal(nav.description, 'Open a URL. Then read_page; for the desktop use mcp__mopilot_computer__screenshot.');
  assert.equal((nav.inputSchema as any).properties.url.description, 'Like navigate does. Not browser_navigatex.');
  assert.deepEqual(nav.inputSchema.required, ['url']);
  assert.equal(nav.annotations?.readOnlyHint, true);
  assert.equal(nav._meta?.['anthropic/alwaysLoad'], true);
  const batch = listed.find((t: any) => t.name === 'browser_batch')!;
  assert.equal(batch.annotations?.readOnlyHint, false);
  assert.equal(batch.description, 'Run several browser tools; navigate first.');

  const res: any = await browser.callTool({
    name: 'navigate',
    arguments: { url: 'https://example.com' },
    _meta: { 'claudecode/toolUseId': 'toolu_9' },
  });
  // the result's text names tools as this server presents them
  assert.deepEqual(res.content, [{ type: 'text', text: 'navigate ran' }]);
  assert.equal(res.isError, false);
  const computer = await connect(servers.get('mopilot_computer'));
  assert.deepEqual((await computer.listTools()).tools.map((t: any) => t.name).sort(), ['computer_batch', 'screenshot']);
  await computer.callTool({ name: 'computer_batch', arguments: {} });
  const sage = await connect(servers.get(SAGE));
  const echo = (await sage.listTools()).tools.find((t: any) => t.name === 'sage_debug_echo')!;
  assert.equal(echo.description, 'Echo. See mcp__mopilot_browser__navigate and mcp__mopilot_computer__screenshot.');
  assert.deepEqual(
    calls.map((c) => c.name),
    ['browser_navigate', 'desktop_batch'],
  );
  assert.deepEqual(seen, [
    { ...owner, tool: 'browser_navigate', callId: 'toolu_9' },
    { ...owner, tool: 'desktop_batch', callId: null },
  ]);
  // a failure comes back as an MCP error with the Registry's message
  const bad: any = await browser.callTool({ name: 'navigate', arguments: {} });
  assert.equal(bad.isError, true);
  await Promise.all([browser.close(), computer.close(), sage.close()]);
});

test('sdkMcp: hidden tools are left out when built and refused at call time; empty servers are dropped', async () => {
  const { r, calls } = registry();
  const hidden = new Set(['desktop_screenshot', 'desktop_batch', 'sage_debug_echo']);
  const hide = (name: string) => hidden.has(name);
  const servers = sdkMcpServers({ sdk, z, registry: r, serverName: SAGE, owner, hide });
  assert.deepEqual([...servers.keys()], ['mopilot_browser'], 'no sage or computer server without tools');
  assert.equal(sdkMcpServer({ sdk, z, registry: r, serverName: SAGE, owner, hide }), null);
  // the channel changed while the session runs: the next call is refused without reaching the Registry
  hidden.add('browser_read_page');
  const client = await connect(servers.get('mopilot_browser'));
  const res: any = await client.callTool({ name: 'read_page', arguments: {} });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /^read_page is unavailable in this session/);
  assert.deepEqual(calls, []);
  await client.close();
});

test('sdkMcp: injection adds every server, lists read-only tools by full name and returns the exact tool set', () => {
  const { r } = registry();
  const opts: any = { mcpServers: { other: { type: 'stdio' } }, allowedTools: ['Read'] };
  const out = injectSdkMcpServers(opts, { sdk, z, registry: r, serverName: SAGE, owner });
  assert.deepEqual(out.servers, [SAGE, 'mopilot_browser', 'mopilot_computer']);
  assert.deepEqual(Object.keys(opts.mcpServers), ['other', SAGE, 'mopilot_browser', 'mopilot_computer']);
  assert.deepEqual(opts.allowedTools, [
    'Read',
    `mcp__${SAGE}__sage_debug_echo`,
    'mcp__mopilot_browser__navigate',
    'mcp__mopilot_browser__read_page',
    'mcp__mopilot_computer__screenshot',
  ]);
  assert.deepEqual(
    [...out.tools],
    [
      `mcp__${SAGE}__sage_debug_echo`,
      'mcp__mopilot_browser__navigate',
      'mcp__mopilot_browser__read_page',
      'mcp__mopilot_browser__browser_batch',
      'mcp__mopilot_computer__screenshot',
      'mcp__mopilot_computer__computer_batch',
    ],
  );
  assert.deepEqual(
    readOnlyAllowedTools(r, SAGE, (n: string) => n.startsWith('desktop_')),
    [`mcp__${SAGE}__sage_debug_echo`, 'mcp__mopilot_browser__navigate', 'mcp__mopilot_browser__read_page'],
  );

  // without an allowedTools list (not read-only) it is left alone
  const plain: any = {};
  injectSdkMcpServers(plain, { sdk, z, registry: r, serverName: SAGE, owner });
  assert.equal(plain.allowedTools, undefined);
  assert.deepEqual(Object.keys(plain.mcpServers), [SAGE, 'mopilot_browser', 'mopilot_computer']);

  // nothing to give
  const none: any = {};
  assert.deepEqual(injectSdkMcpServers(none, { sdk, z, registry: new Registry(), serverName: SAGE, owner }), {
    servers: [],
    tools: new Set(),
  });
  assert.equal(none.mcpServers, undefined);
  assert.equal(injectSdkMcp({}, { sdk, z, registry: new Registry(), serverName: SAGE, owner }), null);

  // injectSdkMcp names the sage server, or the first host server when the sage server has no tools
  assert.equal(injectSdkMcp({}, { sdk, z, registry: r, serverName: SAGE, owner }), SAGE);
  const hostOnly = new Registry();
  hostOnly.register({ name: 'browser_navigate', description: 'x', policy: 'observe', handler: () => 'ok' });
  assert.equal(injectSdkMcp({}, { sdk, z, registry: hostOnly, serverName: SAGE, owner }), 'mopilot_browser');
});

test('sdkMcp: canUseTool allows exactly the tools the session was given', () => {
  const { r } = registry();
  const { tools } = injectSdkMcpServers(
    {},
    { sdk, z, registry: r, serverName: SAGE, owner, hide: (n: string) => n === 'browser_read_page' },
  );
  assert.deepEqual(autoAllow(tools, 'mcp__mopilot_browser__navigate', { url: 'x' }), { behavior: 'allow', updatedInput: { url: 'x' } });
  assert.deepEqual(autoAllow(tools, 'mcp__mopilot_computer__computer_batch', {}), { behavior: 'allow', updatedInput: {} });
  assert.equal(autoAllow(tools, 'mcp__mopilot_browser__read_page', {}), null, 'a hidden tool of the same server');
  assert.equal(autoAllow(tools, 'mcp__mopilot_browser__javascript_exec', {}), null, 'another tool of a same-named server');
  assert.equal(autoAllow(tools, 'mcp__sage_bbbbbbbbbbbb__sage_debug_echo', {}), null);
  assert.equal(autoAllow(tools, 'Bash', {}), null);
  assert.equal(autoAllow(tools, undefined as any, {}), null);
  // the older form: any tool of the session's own sage server
  assert.deepEqual(autoAllow(SAGE, `mcp__${SAGE}__sage_debug_echo`, {}), { behavior: 'allow', updatedInput: {} });
  assert.equal(autoAllow(SAGE, 'mcp__mopilot_browser__navigate', {}), null);
});

test('the real browser_* specs on the mopilot_browser server: short names, a name-agnostic browser_batch description and browser_script', async () => {
  const r = new Registry();
  for (const s of browserToolSpecs())
    r.register({
      name: s.name,
      description: s.description,
      schema: s.inputSchema,
      policy: s.policy,
      authorizesItself: true,
      handler: () => 'ok',
    });
  const client = await connect(sdkMcpServers({ sdk, z, registry: r, serverName: SAGE, owner }).get('mopilot_browser'));
  const tools = (await client.listTools()).tools;
  const names = tools.map((t: any) => t.name);
  assert.ok(
    names.includes('navigate') &&
      names.includes('computer') &&
      names.includes('tabs_context') &&
      names.includes('browser_batch') &&
      names.includes('browser_script'),
  );
  assert.ok(!names.some((n: string) => n.startsWith('browser_') && n !== 'browser_batch' && n !== 'browser_script'));
  for (const t of tools)
    assert.ok(
      !/\bbrowser_(?!batch\b|state\b|script\b)[a-z_]+/.test(t.description!),
      `${t.name}: no Registry tool names left in "${t.description}"`,
    );
  const batch = tools.find((t: any) => t.name === 'browser_batch')!;
  assert.ok(!batch.description!.includes('browser_*'), 'does not tell Claude its tools are called browser_*');
  assert.match(batch.description!, /short name \(for example navigate, computer or read_page; the "browser_" prefix is also accepted\)/);
  // browser_script keeps its name; for single steps it points Claude at its own short-named tools
  const script = tools.find((t: any) => t.name === 'browser_script')!;
  assert.match(script.description!, /For a single step, navigate, computer and read_page are simpler\.$/);
  await client.close();
});

test("sdkMcp: a paired computer's tool names reach Claude as they are, in its tool list and its refusals (#1364)", async () => {
  const { r } = registry();
  // what a paired computer answers names its own tools (browser_navigate there), never this session's
  r.register({
    name: 'remote_computer_tools',
    policy: 'observe',
    authorizesItself: true,
    handler: () => JSON.stringify({ tools: [{ name: 'browser_navigate' }, { name: 'desktop_screenshot' }] }),
  });
  r.register({
    name: 'remote_computer_call',
    policy: 'act',
    authorizesItself: true,
    handler: () => {
      throw Object.assign(new Error('desktop_screenshot is not something this device may use on this Mac'), { code: 'not_allowed' });
    },
  });
  const sage = await connect(sdkMcpServers({ sdk, z, registry: r, serverName: SAGE, owner }).get(SAGE));
  const listed: any = await sage.callTool({ name: 'remote_computer_tools', arguments: {} });
  assert.equal(listed.content[0].text, JSON.stringify({ tools: [{ name: 'browser_navigate' }, { name: 'desktop_screenshot' }] }));
  const refused: any = await sage.callTool({ name: 'remote_computer_call', arguments: {} });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /^desktop_screenshot is not something/);
  // this session's own tools are still rewritten as before
  const echo: any = await sage.callTool({ name: 'sage_debug_echo', arguments: { text: 'x' } });
  assert.equal(echo.content[0].text, 'sage_debug_echo ran');
  await sage.close();
});

test('sdkMcp: a result that ends the turn reaches the CLI with Claude Code’s end-turn flag', async () => {
  const r = new Registry();
  r.register({ name: 'wrap_up', policy: 'observe', handler: () => ({ shown: true, endsTurn: true }) });
  r.register({ name: 'list', policy: 'observe', handler: () => 'ok' });
  const sage = await connect(sdkMcpServers({ sdk, z, registry: r, serverName: SAGE, owner }).get(SAGE));
  const boxed: any = await sage.callTool({ name: 'wrap_up', arguments: {} });
  assert.deepEqual([boxed.content[0].text, boxed._meta], ['{"shown":true}', { 'claude/endTurn': true }]);
  assert.equal(((await sage.callTool({ name: 'list', arguments: {} })) as any)._meta, undefined);
  await sage.close();
});
