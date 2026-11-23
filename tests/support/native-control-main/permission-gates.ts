// Native-control permission-gates unit cases with shared protocol and lifecycle fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  rejectNativeCuaElicitation,
  hideRule,
  sdkMcpServer,
  sdkMcpServers,
  injectSdkMcp,
  injectSdkMcpServers,
  readOnlyAllowedTools,
  autoAllow,
  fakeRegistry,
} from './fixture';

export function registerPermissionGatesCases() {
  test('a cua_repl elicitation reaches the card on a native thread and is declined on any other', () => {
    const sent: any[] = [];
    const notes: any[] = [];
    const native = new Set(['native']);
    const h = rejectNativeCuaElicitation({
      isNativeThread: (id: string) => native.has(id),
      send: (m: any) => sent.push(m),
      notify: (id: string, text: string) => notes.push([id, text]),
    });
    const req = (id: number, threadId: string, serverName = 'cua_repl') => ({
      id,
      method: 'mcpServer/elicitation/request',
      params: { threadId, serverName, mode: 'form', message: 'Allow?' },
    });
    assert.equal(h(req(1, 'native')), false);
    assert.deepEqual(sent, []);
    assert.equal(h(req(2, 'managed')), true);
    assert.deepEqual(sent, [{ id: 2, result: { action: 'decline', content: null, _meta: null } }]);
    assert.deepEqual(notes, [
      ['managed', "Declined a request from Codex's built-in computer use: it is off in this chat. MoPilot's computer use is used instead."],
    ]);
    assert.equal(h(req(3, 'native', 'docs')), false);
    assert.equal(h({ method: 'mcpServer/elicitation/request', id: 4 }), false);
  });

  /* ====================================================================== */
  /* sdkMcp: Claude's SDK servers with Claude in Chrome's hide filter        */
  /* ====================================================================== */

  const sdk = {
    tool: (name: string, description: string, schema: any, handler: Function, extra: any) => ({
      name,
      description,
      schema,
      handler,
      extra,
    }),
    createSdkMcpServer: (o: any) => ({ type: 'sdk', ...o }),
  };
  const z = { fromJSONSchema: (s: any) => s };
  const owner = { chatId: 'chat', segmentId: 'seg' };

  test('a hidden tool is left off every server and refused if called after it became hidden', async () => {
    const registry = fakeRegistry(['sage_browser_click', 'sage_files_read', 'browser_navigate', 'desktop_screenshot']);
    let hideChrome = true;
    const hide = (name: string) => hideChrome && name.startsWith('sage_browser_');
    const servers = sdkMcpServers({ sdk, z, registry, serverName: 'sage_aaaaaaaaaaaa', owner, hide });
    assert.deepEqual([...servers.keys()], ['sage_aaaaaaaaaaaa', 'mopilot_browser', 'mopilot_computer']);
    assert.deepEqual(
      servers.get('sage_aaaaaaaaaaaa').tools.map((t: any) => t.name),
      ['sage_files_read'],
    );
    // built while Your Chrome was not in use: the tool is there, and refused once it is hidden
    hideChrome = false;
    const sage = sdkMcpServer({ sdk, z, registry, serverName: 'sage_aaaaaaaaaaaa', owner, hide });
    const click = sage.tools.find((t: any) => t.name === 'sage_browser_click');
    assert.deepEqual(await click.handler({}, { _meta: { 'claudecode/toolUseId': 'toolu_1' } }), {
      content: [{ type: 'text', text: 'ran sage_browser_click' }],
      isError: false,
    });
    assert.deepEqual(registry.invoked.at(-1), {
      chatId: 'chat',
      segmentId: 'seg',
      name: 'sage_browser_click',
      args: {},
      callId: 'toolu_1',
    });
    hideChrome = true;
    assert.deepEqual(await click.handler({}, undefined), {
      content: [{ type: 'text', text: 'sage_browser_click is unavailable in this session.' }],
      isError: true,
    });
    assert.equal(registry.invoked.length, 1);
    // without a filter every tool runs
    const open = sdkMcpServer({ sdk, z, registry, serverName: 'sage_aaaaaaaaaaaa', owner });
    await open.tools[0].handler({}, {});
    assert.equal(registry.invoked.at(-1).callId, null);
  });

  test("a host-server tool hidden after the build is refused with the session rule's message, under the names Claude sees", async () => {
    const registry = fakeRegistry(['sage_files_read', 'desktop_screenshot']);
    let hidden = false;
    const hide = hideRule(
      (name: string) => hidden && name === 'desktop_screenshot',
      (name: string) => `${name} is unavailable: try desktop_screenshot later.`,
    );
    const servers = sdkMcpServers({ sdk, z, registry, serverName: 'sage_aaaaaaaaaaaa', owner, hide });
    const shot = servers.get('mopilot_computer').tools[0];
    assert.notEqual(shot.name, 'desktop_screenshot');
    hidden = true;
    assert.deepEqual(await shot.handler({}, undefined), {
      content: [{ type: 'text', text: `${shot.name} is unavailable: try ${shot.name} later.` }],
      isError: true,
    });
    assert.deepEqual(registry.invoked, []);
  });

  test('read-only sessions list only visible tools that read; the session gets the full names it may call', () => {
    const registry = fakeRegistry(['sage_browser_read', 'sage_files_read', 'browser_page_read', 'sage_poke']);
    const hide = (name: string) => name.startsWith('sage_browser_');
    assert.deepEqual(readOnlyAllowedTools(registry, 'sage_aaaaaaaaaaaa', hide), [
      'mcp__sage_aaaaaaaaaaaa__sage_files_read',
      'mcp__mopilot_browser__page_read',
    ]);
    assert.deepEqual(readOnlyAllowedTools(registry, 'sage_aaaaaaaaaaaa'), [
      'mcp__sage_aaaaaaaaaaaa__sage_browser_read',
      'mcp__sage_aaaaaaaaaaaa__sage_files_read',
      'mcp__mopilot_browser__page_read',
    ]);
    const options: any = { allowedTools: ['Read'], mcpServers: { mine: {} } };
    const injected = injectSdkMcpServers(options, { sdk, z, registry, serverName: 'sage_aaaaaaaaaaaa', owner, hide });
    assert.deepEqual(injected.servers, ['sage_aaaaaaaaaaaa', 'mopilot_browser']);
    assert.deepEqual(
      [...injected.tools],
      ['mcp__sage_aaaaaaaaaaaa__sage_files_read', 'mcp__sage_aaaaaaaaaaaa__sage_poke', 'mcp__mopilot_browser__page_read'],
    );
    assert.deepEqual(Object.keys(options.mcpServers), ['mine', 'sage_aaaaaaaaaaaa', 'mopilot_browser']);
    assert.deepEqual(options.allowedTools, ['Read', 'mcp__sage_aaaaaaaaaaaa__sage_files_read', 'mcp__mopilot_browser__page_read']);
    // canUseTool passes exactly the presented tools
    assert.deepEqual(autoAllow(injected.tools, 'mcp__mopilot_browser__page_read', { a: 1 }), { behavior: 'allow', updatedInput: { a: 1 } });
    assert.equal(autoAllow(injected.tools, 'mcp__sage_aaaaaaaaaaaa__sage_browser_read', {}), null);
    assert.equal(autoAllow(injected.tools, 42, {}), null);
    // with the sage server's name, any of its tools passes
    assert.deepEqual(autoAllow('sage_aaaaaaaaaaaa', 'mcp__sage_aaaaaaaaaaaa__sage_poke', {}), { behavior: 'allow', updatedInput: {} });
    assert.equal(autoAllow('sage_aaaaaaaaaaaa', 'mcp__mopilot_browser__page_read', {}), null);
    // nothing to give: nothing added
    const none: any = {};
    assert.deepEqual(
      injectSdkMcpServers(none, { sdk, z, registry: fakeRegistry(['sage_browser_x']), serverName: 'sage_aaaaaaaaaaaa', owner, hide }),
      { servers: [], tools: new Set() },
    );
    assert.equal(none.mcpServers, undefined);
  });

  test('a session whose only tools are host tools has no sage server; injectSdkMcp names the first one added', () => {
    const registry = fakeRegistry(['desktop_click', 'sage_browser_x']);
    const hide = (name: string) => name.startsWith('sage_browser_');
    assert.equal(sdkMcpServer({ sdk, z, registry, serverName: 'sage_aaaaaaaaaaaa', owner, hide }), null);
    const options: any = {};
    assert.equal(injectSdkMcp(options, { sdk, z, registry, serverName: 'sage_aaaaaaaaaaaa', owner, hide }), 'mopilot_computer');
    assert.equal(injectSdkMcp({}, { sdk, z, registry, serverName: 'sage_aaaaaaaaaaaa', owner }), 'sage_aaaaaaaaaaaa');
    assert.equal(injectSdkMcp({}, { sdk, z, registry: fakeRegistry([]), serverName: 'sage_aaaaaaaaaaaa', owner }), null);
  });
}
