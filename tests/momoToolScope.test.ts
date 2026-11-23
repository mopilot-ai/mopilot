// MoMo's tools are default deny (#2139, electron/momo/contract/toolIsolation.cjs): every tool the app registers is decided, on
// exactly one list: one a MoMo chat may use (momoTool) or one it never gets (NOT_MOMO). The registrars and spec lists are
// booted with stand-ins and their names collected; a file that registers tools and isn't booted here fails too, so a new
// tool can't slip past the decision. Each tool a MoMo chat may use also has a trust class (electron/momo/toolTrust.cjs,
// #2283), so none skips MoMo's trust gate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

export const GUARDS = ['electron/'];

const require = createRequire(import.meta.url);
// the scan reads main's own source only
const ELECTRON = fileURLToPath(new URL('../electron/', import.meta.url));
const { momoTool, NOT_MOMO, NOT_MOMO_FAMILIES, MOMO_TOOLS, CHAT_TOOLS } = require('../electron/momo/contract/toolIsolation.cjs');
const { trustClassOf, CLASSES: TRUST_CLASSES } = require('../electron/momo/toolTrust.cjs');

/** A stand-in for any dependency: every property and call gives another one. */
const any = (): any =>
  new Proxy(() => undefined, {
    get: (_t, k) => (k === 'then' ? undefined : k === Symbol.toPrimitive ? () => '' : any()),
    apply: () => any(),
  });

/** The files that register tools, and how each is booted here (the name of what it registers comes back). */
function collect() {
  const names = new Set<string>();
  const registered = new Set<string>();
  const add = (n: string) => names.add(n);
  // servesChat: the per-chat visibility MoMo's tools refuse to register without
  const registry = {
    register: (tool: any) => {
      add(tool.name);
      // A booted registrar may delegate to another module. Discover actual registering callers instead of appending paths.
      for (const frame of (new Error().stack ?? '').split('\n')) {
        const start = frame.indexOf(ELECTRON);
        if (start < 0) continue;
        const file = frame.slice(start).replace(/:\d+:\d+\)?$/, '');
        if (file.endsWith('.cjs')) registered.add(`electron/${path.relative(ELECTRON, file)}`);
      }
      return () => undefined;
    },
    setApprover: () => undefined,
    servesChat: () => true,
  };
  const boot = (file: string, run: (r: any) => void) => {
    run(registry);
    return file;
  };
  const specs = (file: string, list: any) => {
    for (const s of Array.isArray(list) ? list : Object.entries(list).map(([name, v]: any) => ({ name, ...v }))) add(s.name);
    return file;
  };
  const r = (p: string) => require(path.join(ELECTRON, p.replace(/^electron\//, '')));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-scope-'));
  const booted = [
    boot('electron/capabilities/tools/sessions.cjs', (g) =>
      r('electron/capabilities/tools/sessions.cjs').registerSessionTools(g, { orchestrator: any(), owner: any() }),
    ),
    boot('electron/capabilities/tools/sessionRead.cjs', (g) =>
      r('electron/capabilities/tools/sessionRead.cjs').registerSessionReadTools(g, { orchestrator: any(), owner: any(), host: any() }),
    ),
    boot('electron/capabilities/tools/sessionControl.cjs', (g) =>
      r('electron/capabilities/tools/sessionControl.cjs').registerSessionControlTools(g, {
        orchestrator: any(),
        owner: any(),
        host: any(),
      }),
    ),
    'electron/capabilities/tools/sessionKit.cjs', // registers the session tools above
    boot('electron/capabilities/contract/peerMessages.cjs', (g) =>
      r('electron/capabilities/contract/peerMessages.cjs').registerPeerTools(g, {
        service: any(),
        owner: any(),
        directory: any(),
        read: any(),
      }),
    ),
    boot('electron/capabilities/tools/chatList.cjs', (g) => r('electron/capabilities/tools/chatList.cjs').registerChatListTool(g, any())),
    boot('electron/capabilities/tools/sidebarTools.cjs', (g) =>
      r('electron/capabilities/tools/sidebarTools.cjs').registerSidebarTools(g, any()),
    ),
    boot('electron/capabilities/tools/settingsTools.cjs', (g) =>
      r('electron/capabilities/tools/settingsTools.cjs').registerSettingsTools(g, any()),
    ),
    boot('electron/capabilities/tools/connectorTools.cjs', (g) =>
      r('electron/capabilities/tools/connectorTools.cjs').registerConnectorTools(g, any()),
    ),
    boot('electron/capabilities/tools/mcpRegistry.cjs', (g) =>
      r('electron/capabilities/tools/mcpRegistry.cjs').registerMcpRegistryTool(g, any()),
    ),
    boot('electron/capabilities/tools/paneTools.cjs', (g) =>
      r('electron/capabilities/tools/paneTools.cjs').registerPaneTools(g, {
        owner: any(),
        viewedBy: any(),
        windows: any(),
        projectOf: any(),
        approveTerminal: any(),
        ipcMain: any(),
      }),
    ),
    boot('electron/capabilities/tools/directoryTools.cjs', (g) =>
      r('electron/capabilities/tools/directoryTools.cjs').registerDirectoryTools(g, {
        owner: any(),
        sessionFolders: any(),
        grant: any(),
        ask: any(),
        pickFolder: any(),
        git: any(),
      }),
    ),
    boot('electron/capabilities/tools/hostActionTools.cjs', (g) =>
      r('electron/capabilities/tools/hostActionTools.cjs').registerHostActionTools(g, {
        owner: any(),
        sessionFolders: any(),
        ask: any(),
        editors: any(),
        preferredEditor: any(),
        reveal: any(),
        fileManager: 'Finder',
        keepAwake: any(),
        idleMinutes: 10,
      }),
    ),
    boot('electron/capabilities/tools/worktreeTools.cjs', (g) =>
      r('electron/capabilities/tools/worktreeTools.cjs').registerWorktreeTools(g, {
        owner: any(),
        storage: any(),
        sessionFolders: any(),
        ask: any(),
        git: any(),
        worktreeInfo: any(),
      }),
    ),
    'electron/capabilities/tools/hostToolKit.cjs', // helpers of the three above
    'electron/capabilities/tools/sessionFolders.cjs', // helpers of the three above
    'electron/app/hostToolsWiring.cjs', // registers the three above, at run time
    boot('electron/capabilities/tools/windowTools.cjs', (g) =>
      r('electron/capabilities/tools/windowTools.cjs').registerWindowTools(g, {
        owner: any(),
        journal: any(),
        viewedBy: any(),
        windows: any(),
        createWindow: any(),
        ipcMain: any(),
      }),
    ),
    boot('electron/capabilities/tools/remoteControl.cjs', (g) =>
      r('electron/capabilities/tools/remoteControl.cjs').registerRemoteControlTool(g, {
        owner: any(),
        journal: any(),
        refOf: any(),
        claude: any(),
      }),
    ),
    boot('electron/capabilities/tools/scheduledTasks.cjs', (g) =>
      r('electron/capabilities/tools/scheduledTasks.cjs').registerScheduledTaskTools(g, any()),
    ),
    boot('electron/capabilities/tools/pluginSkills.cjs', (g) =>
      r('electron/capabilities/tools/pluginSkills.cjs').registerPluginSkillTools(g, any()),
    ),
    boot('electron/capabilities/tools/simulatorTools.cjs', (g) =>
      r('electron/capabilities/tools/simulatorTools.cjs').registerSimulatorTools(g, { owner: () => null, prefs: () => undefined }),
    ),
    boot('electron/capabilities/tools/designTools.cjs', (g) =>
      r('electron/capabilities/tools/designTools.cjs').registerDesignTools(g, any()),
    ),
    boot('electron/capabilities/routines/routineTools.cjs', (g) =>
      r('electron/capabilities/routines/routineTools.cjs').registerRoutineTools(g, any()),
    ),
    boot('electron/momo/memoryTools.cjs', (g) => r('electron/momo/memoryTools.cjs').registerMemoryTools(g, any())),
    boot('electron/momo/loopTools.cjs', (g) => r('electron/momo/loopTools.cjs').registerLoopTools(g, any())),
    boot('electron/momo/suggestionTools.cjs', (g) => r('electron/momo/suggestionTools.cjs').registerSuggestionTools(g, any())),
    boot('electron/momo/historyTools.cjs', (g) => r('electron/momo/historyTools.cjs').registerHistoryTools(g, any())),
    boot('electron/momo/sources/tools.cjs', (g) => r('electron/momo/sources/tools.cjs').registerSourceTools(g, any())),
    boot('electron/momo/sources/writeTools.cjs', (g) => r('electron/momo/sources/writeTools.cjs').registerWriteTools(g, any())),
    boot('electron/momo/outputsTools.cjs', (g) => r('electron/momo/outputsTools.cjs').registerOutputsTools(g, any())),
    boot('electron/momo/draftTools.cjs', (g) => r('electron/momo/draftTools.cjs').registerDraftTools(g, any())),
    boot('electron/momo/debugAction.cjs', (g) => r('electron/momo/debugAction.cjs').registerMomoDebugAction(g, any())),
    boot('electron/momo/routineTools.cjs', (g) => r('electron/momo/routineTools.cjs').registerRoutineTools(g, any())),
    // a coding-side MCP server's tools, re-offered under momo_mcp_* names only for servers the user allowed (none here):
    // their names are a family toolTrust classes as MoMo's own (tests/momoMcpProxy.test.ts)
    boot('electron/momo/mcp/proxy.cjs', (g) => {
      const { McpProxy } = r('electron/momo/mcp/proxy.cjs');
      new McpProxy({ catalog: async () => [], allowlist: any(), allowed: () => true, decide: null, audit: null }).attach({
        registry: g,
        isMomoChat: () => true,
        owner: () => null,
      });
    }),
    // the MCP gateway's tools, under names made from the server and its tools: a ready server with one tool
    boot('electron/gateway/offer.cjs', (g) => {
      const { EventEmitter } = require('node:events');
      const { GatewayOffer } = r('electron/gateway/offer.cjs');
      const { gatewayTools } = r('electron/gateway/tools.cjs');
      const server = { key: '["stdio","x"]', name: 'x' };
      const tools = gatewayTools(server, [{ name: 'run', inputSchema: { type: 'object', properties: {} } }]);
      const upstreams = Object.assign(new EventEmitter(), {
        running: new Map([[server.key, {}]]),
        get: () => ({ status: 'ready', epoch: 1, server, tools }),
      });
      new GatewayOffer({ upstreams, registry: g, ask: async () => null, owner: () => null, visible: () => false });
    }),
    boot('electron/capabilities/browser/chromeTools.cjs', (g) =>
      r('electron/capabilities/browser/chromeTools.cjs').registerChromeTools(g, any()),
    ),
    boot('electron/app/ipc/prMonitor.cjs', (g) =>
      r('electron/app/ipc/prMonitor.cjs').register(any(), {
        app: { getPath: () => tmp, once: () => undefined, on: () => undefined },
        live: { capabilities: g, controller: any() },
        run: any(),
        broadcastAll: any(),
        execWindows: any(),
        isFlagEnabled: () => true,
      }),
    ),
    'electron/app/ipc/prStack.cjs', // registered by prMonitor.cjs above
    'electron/capabilities/tools/designToolSpecs.cjs', // registered by designTools.cjs above
    specs('electron/capabilities/tools/computerSpecs.cjs', [
      ...r('electron/capabilities/tools/computerSpecs.cjs').SPECS,
      ...r('electron/capabilities/tools/computerSpecs.cjs').VISION_SPECS,
    ]),
    specs('electron/capabilities/tools/desktopSpecs.cjs', r('electron/capabilities/tools/desktopSpecs.cjs').SPECS),
    specs('electron/capabilities/tools/appScopedSpecs.cjs', r('electron/capabilities/tools/appScopedSpecs.cjs').SPECS),
    specs('electron/capabilities/tools/appScopedScript.cjs', r('electron/capabilities/tools/appScopedScript.cjs').SCRIPT_SPECS),
    specs('electron/capabilities/browser/hostToolSpecs.cjs', r('electron/capabilities/browser/hostToolSpecs.cjs').SPECS),
    // the deferred devtools group, merged into the browser_* tools (hostTools.cjs)
    specs('electron/capabilities/browser/devtools/tools.cjs', r('electron/capabilities/browser/devtools/tools.cjs').DEVTOOLS_SPECS),
    specs('electron/capabilities/browser/devPreview/tools.cjs', r('electron/capabilities/browser/devPreview/tools.cjs').SPECS),
    specs('electron/computerAccess/client.cjs', r('electron/computerAccess/client.cjs').SPECS),
    specs(
      'electron/capabilities/browser/tools.cjs',
      r('electron/capabilities/browser/tools.cjs').panelBrowserTools({ panel: any(), grants: any(), enabled: () => true }),
    ),
    specs('electron/capabilities/tools/debug.cjs', [r('electron/capabilities/tools/debug.cjs').echo]),
    // these register the lists above, at run time
    'electron/app/agentTools.cjs',
    'electron/app/browserTools.cjs',
    'electron/capabilities/browser/control.cjs',
    'electron/capabilities/browser/hostTools.cjs',
    'electron/capabilities/computerUse.cjs',
  ];
  fs.rmSync(tmp, { recursive: true, force: true });
  return { names, booted: [...booted, ...registered] };
}

/** Every file under electron/ that registers a tool in the registry (a register call given a tool, or a spec list). */
function registeringFiles(dir = '', out: string[] = []): string[] {
  for (const e of fs.readdirSync(path.join(ELECTRON, dir), { withFileTypes: true })) {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== 'chrome-extension') registeringFiles(rel, out);
    } else if (rel.endsWith('.cjs')) {
      const text = fs.readFileSync(path.join(ELECTRON, rel), 'utf8');
      if (/\b(?:registry|capabilities|o\.registry|this\.o\.registry)\??\.register\(/.test(text) || /^const SPECS = /m.test(text))
        out.push(`electron/${rel}`);
    }
  }
  return out;
}

const decided = (name: string) => momoTool(name) !== (NOT_MOMO.includes(name) || NOT_MOMO_FAMILIES.some((re: RegExp) => re.test(name)));

test('every tool the app registers is decided for MoMo: allowed or kept out, never both, never neither', () => {
  const { names } = collect();
  assert.ok(names.size > 100, `only ${names.size} tools found`);
  assert.deepEqual(
    [...names].filter((n) => !decided(n)).sort(),
    [],
    'decide each for MoMo chats: MOMO_TOOLS / MOMO_FAMILIES or NOT_MOMO in electron/momo/contract/toolIsolation.cjs',
  );
  // every name on the lists is a real tool
  assert.deepEqual(
    [...MOMO_TOOLS, ...NOT_MOMO].filter((n) => !names.has(n)),
    [],
  );
  // MoMo's own memory, the browser and computer use are in; every chat tool is out
  for (const n of [
    'momo_memory_search',
    'momo_routine_propose',
    'browser_navigate',
    'computer_click',
    'desktop_key',
    'show_pane',
    'wrap_up',
  ])
    assert.equal(momoTool(n), true, n);
  for (const n of [
    ...CHAT_TOOLS,
    'open_terminal_tab',
    'run_in_terminal',
    'read_terminal',
    'stop_terminal_tab',
    'design_check',
    'set_pr_monitor',
  ])
    assert.equal(momoTool(n), false, n);
});

test('every file that registers tools is booted here, so a new one is decided too', () => {
  const { booted } = collect();
  assert.deepEqual(
    registeringFiles().filter((f) => !booted.includes(f)),
    [],
  );
  // the scan sees each way a file registers tools
  assert.ok(registeringFiles().includes('electron/app/ipc/prMonitor.cjs'));
  assert.ok(registeringFiles().includes('electron/capabilities/tools/computerSpecs.cjs'));
});

test("#2283: every tool a MoMo chat may use has a trust class, so a new browser or computer-use tool can't skip MoMo's trust gate", () => {
  const { names } = collect();
  const allowed = [...names].filter((n) => momoTool(n));
  assert.deepEqual(
    allowed.filter((n) => trustClassOf(n) === null).sort(),
    [],
    'classify each in CLASSES in electron/momo/toolTrust.cjs: own, read, navigate or act',
  );
  // and every classified name is a real tool MoMo may use
  assert.deepEqual(
    Object.values(TRUST_CLASSES)
      .flat()
      .filter((n: any) => !names.has(n) || !momoTool(n)),
    [],
  );
  // what sends data out is never a read: navigation, typing, form fills, clicks, keys, uploads and scripts
  for (const n of ['browser_navigate', 'chrome_navigate', 'sage_browser_navigate', 'browser_tabs_create'])
    assert.equal(trustClassOf(n), 'navigate', n);
  // and what reads a page is a private read, which taints the chat
  for (const n of ['browser_get_page_text', 'browser_read_page', 'chrome_get_page_text', 'chrome_read_page', 'sage_browser_snapshot'])
    assert.equal(trustClassOf(n), 'page', n);
  for (const n of [
    'computer_type',
    'computer_click',
    'computer_key',
    'desktop_type',
    'desktop_key',
    'chrome_form_input',
    'browser_form_input',
    'sage_browser_type',
    'sage_browser_click',
    'browser_file_upload',
    'chrome_file_upload',
    'browser_javascript_exec',
    'chrome_javascript_tool',
    'browser_batch',
  ])
    assert.equal(trustClassOf(n), 'act', n);
});
