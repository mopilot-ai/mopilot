// The tools Sage gives agents: the registry, what each session sees, the channels to each harness, and computer use.
const path = require('node:path');
const os = require('node:os');
const { Registry, OperationLog } = require('../capabilities/contract/registry.cjs');
const { isolateChatTools } = require('../momo/contract/toolIsolation.cjs');
const { ToolSessions } = require('../capabilities/contract/session.cjs');
const { ToolSocket, preloadedFor } = require('../capabilities/mcp/socket.cjs');
const { mcpRuntime } = require('../capabilities/mcp/runtime.cjs');
const { ToolHttp } = require('../capabilities/httpMcp.cjs');
const { withTimeout } = require('../platform/timeout.cjs');
const { pluginDelivery, codexPluginMirror } = require('../plugins/service.cjs');
const { ToolVisibility, CLAUDE_IN_CHROME_HOST } = require('../capabilities/visibility.cjs');
const { NativeAvailability, probeNativeAvailability } = require('../capabilities/nativeAvailability.cjs');
const { CapabilityHealth } = require('../capabilities/capabilityHealth.cjs');
const { installedExtensionVersion } = require('../capabilities/browser/chromeMigration.cjs');
const { EXTENSION_URL } = require('../capabilities/browser/extension.cjs');
const { CodexToolInjection } = require('../capabilities/channels/codexConfig.cjs');
const { SessionMcp } = require('../capabilities/channels/sessionMcp.cjs');
const { codexServerRequests, rejectNativeCuaElicitation } = require('../capabilities/contract/serverRequests.cjs');
const { CodexBrowserUse } = require('../capabilities/browser/codexBrowserUse.cjs');
const { CodexSiteBlocks } = require('../capabilities/browser/codexSiteBlocks.cjs');
const { mainIabBackends } = require('../capabilities/browser/iabBackend.cjs');
const { mainChromeBackends, combineBackends, chromeBackendNote } = require('../capabilities/browser/chromeBackend.cjs');
const { codexChromeOff, cuaWithoutComputer } = require('../capabilities/channels/codexPluginChrome.cjs');
const { pluginCuaServer } = require('../capabilities/browser/iabBackend/environment.cjs');
const { chromeRelayFacts, extensionShipped, pairChromeExtension, answerChromeAsk, openChromeStore } = require('./chromeRelay.cjs');
const { userChromeOf } = require('../capabilities/contract/surfaceNote.cjs');
const { servedChrome } = require('../capabilities/browser/chromeControl.cjs');
const { chatgptExtensionInstances } = require('../capabilities/browser/codexChromePick.cjs');
const { pluginSiteConsent } = require('../capabilities/browser/pluginConsent.cjs');
const { inAppBrowserEnabled } = require('../capabilities/browser/hostTools.cjs');
const { setupComputerUse, agentLabel } = require('../capabilities/computerUse.cjs');
const { pickBackend: pickVisionBackend, MOPILOT_VENDOR } = require('../capabilities/vision/decide.cjs');
const { gatedBackend } = require('../capabilities/vision/index.cjs');
const { anthropicVision, providerVision, MOPILOT_VISION_MODEL } = require('../capabilities/vision/backend.cjs');
const acpQuirks = require('../harness/quirks/index.cjs');
const { noteIgnored, ignoring } = require('../ignored.cjs');
const { startupResource } = require('./startupResource.cjs');
const { stopOwnerOrChat, desktopElectron } = require('./computerAccess.cjs');
const { refusalText, modelNote } = require('../capabilities/contract/controlRefusals.cjs');
const { hostDesktopOptions } = require('../host/remoteDesktop.cjs');

/** A developer message in a Codex thread's model-visible history (thread/inject_items takes Responses API items). */
const developerItem = (text) => ({ type: 'message', role: 'developer', content: [{ type: 'input_text', text }] });

/**
 * @param {import('../main.cjs').AgentToolsDeps} deps what main.cjs passes in; `live` reads main's late-bound services
 */
function createAgentTools({
  app,
  ipcMain,
  BrowserWindow,
  screen,
  globalShortcut,
  clipboard,
  shell,
  claude,
  shellEnv,
  server,
  handle,
  API_BASE,
  uiPrefs,
  isFlagEnabled,
  setControlling,
  appWindows,
  live,
}) {
  const { broadcastAll, codexEmit, chatShown } = appWindows;
  // Claude in Chrome only where the user chose it in Settings → Browser: MoPilot's extension serves Claude Code too
  const claudeInChrome = () => isFlagEnabled('native.claude.chrome') && uiPrefs()?.claudeInChrome === true;
  /** The tools Sage gives agents; calls run here, once. @type {InstanceType<typeof Registry>} assigned at startup, before any window or IPC handler uses it */
  let capabilities;
  /** Who may call those tools: one random server name and token per harness session. */
  const toolSessions = new ToolSessions({ preloaded: preloadedFor(live) });
  /** Whether MoPilot's own surfaces can work, from real state (electron/capabilities/capabilityHealth.cjs). */
  /** @type {InstanceType<typeof CapabilityHealth>} assigned at startup, before any window or IPC handler uses it */
  let health;
  /** Which of those tools agent sessions are shown (electron/capabilities/visibility.cjs). */
  /** @type {InstanceType<typeof ToolVisibility>} assigned at startup, before any window or IPC handler uses it */
  let toolVisibility;
  /** What vendor-native browser and computer control this Mac can run (electron/capabilities/nativeAvailability.cjs). */
  /** @type {InstanceType<typeof NativeAvailability>} assigned at startup, before any window or IPC handler uses it */
  let nativeAvailability;
  /** Gives each Codex thread its sage-mcp; null when there's no sage-mcp to give. */
  /** @type {InstanceType<typeof CodexToolInjection> | null} */
  let codexTools = null;
  /** Their tool channel (sage-mcp in session/new); without sage-mcp no basic harness is admitted. */
  /** @type {InstanceType<typeof SessionMcp> | null} */
  let acpTools = null;
  /** Computer use: the helper, grants and Sage's own approval cards (electron/capabilities/computerUse.cjs). */
  /** @type {ReturnType<typeof setupComputerUse>} assigned at startup, before any window or IPC handler uses it */
  let computerUse;
  /** Codex Browser Use's blocks (browser/codexSiteBlocks.cjs), which MoPilot's own browser tools apply in every chat (#1319 G13). */
  /** @type {InstanceType<typeof CodexSiteBlocks> | null} assigned by openTools, before any browser tool runs */
  let codexSiteBlocks = null;
  /** The native Codex threads' backends for the user's Chrome over MoPilot's channel (assigned by openTools). */
  // Before openTools, no backend is available to a new Codex thread.
  /** @type {InstanceType<typeof import('../capabilities/browser/iabBackend.cjs').IabBackends> | null} */
  let codexChromeBackends = null;
  /** Codex's Browser plugin's site consent, kept as the chat's MoPilot site grant (browser/pluginConsent.cjs). */
  // a subagent thread's card is about its parent's chat
  const siteConsent = pluginSiteConsent({
    // the in-app browser's table: the plugin's consent is kept only for its own browser (D7)
    grants: () => live.browserGrants,
    chatOf: (id) => {
      const thread = codexTools?.chatThreadOf(id) ?? id;
      return live.controller?.chatOf(thread) ?? thread;
    },
    inApp: (id) => codexTools?.browserBackends?.has(id) === true,
  });

  /** At app ready, before the sessions open: the registry, which tools sessions see, and the channels that carry them. */
  /** @type {string | null} the socket sage-mcp connects to; null when there is no sage-mcp */
  let codexSocketPath = null;

  async function openTools(/** @type {AbortSignal} */ signal) {
    const transport = mcpRuntime({ packaged: app.isPackaged, which: shellEnv.which });
    capabilities = new Registry({
      log: new OperationLog({ file: path.join(app.getPath('userData'), 'capabilities', 'operations.jsonl'), writer: live.transcripts }),
    });
    // MoMo's chats neither see nor call the tools that reach other chats (electron/momo/contract/toolIsolation.cjs)
    isolateChatTools(capabilities, () => live.chats);
    // a chat on a Host without a surface is not offered its tools (electron/capabilities/contract/hostScope.cjs); until a chat has a remote owner, every tool
    capabilities.setHostScope((chatId) => live.hostCapabilitiesOf?.(chatId));
    // the one record Settings, the tool sets and the model's notes read for MoPilot's own surfaces
    health = new CapabilityHealth({
      isEnabled: isFlagEnabled,
      helper: () => computerUse?.helperFacts() ?? null,
      yourChrome: () => {
        const chosen = !!live.browserControl?.drivesUserChrome();
        return {
          chosen,
          active: live.browserControl?.active === 'chrome',
          extension: chosen ? installedExtensionVersion({ profileDir: live.browserPrefs?.profileDir }) : null,
          extensionUrl: EXTENSION_URL,
        };
      },
      // the user's Chrome for the native-shaped tools (B2): its switches, whether main set it up at startup, and
      // the Playwright Extension the relay needs or MoPilot's own extension's pairing and connection
      chromeRelay: () =>
        chromeRelayFacts({
          isFlagEnabled,
          setup: live.chromeRelay,
          installedVersion: () => installedExtensionVersion({ profileDir: live.browserPrefs?.profileDir }),
          extensionUrl: EXTENSION_URL,
        }),
      // Codex threads and ACP sessions get MoPilot's tools only through sage-mcp
      sageMcp: () => !!codexSocketPath,
      onChange: () => broadcastAll('availability:changed'),
    });
    // one tool set per job for every harness: browser_* replace sage_browser_* for the in-app browser, and
    // desktop_* replace computer_* (electron/capabilities/visibility.cjs); neither while the helper can't work here
    toolVisibility = new ToolVisibility({
      registry: capabilities,
      isEnabled: isFlagEnabled,
      chromeShipped: extensionShipped(),
      drivesUserChrome: () => !!live.browserControl?.drivesUserChrome(),
      computerUnavailable: () => {
        const c = health.computer();
        return c.state === 'unavailable' ? c.reason : null;
      },
    });
    capabilities.setHidden(
      (name) => toolVisibility.hides(name),
      (name) => toolVisibility.message(name),
    );
    // a native path counts only where its vendor runtime is on this Mac; otherwise MoPilot's own tools stay
    nativeAvailability = new NativeAvailability({
      // the Codex home MoPilot's app-server runs with, where its plugin looks for Codex Computer Use
      probe: () => probeNativeAvailability({ codexHome: shellEnv.childEnv().CODEX_HOME || path.join(os.homedir(), '.codex') }),
      live: () => ({
        codexNative: isFlagEnabled('native.codex.enabled'),
        // Codex chats get Codex Computer Use only when the user chose it in Settings → Computer use (#1381)
        codexNativeComputer: computerUse?.grants.codexNativeComputer() === true,
        claudeFlag: claudeInChrome(),
        claudeEligible: () => claude.nativeChromeFor(claude.identity.accounts()?.state.active),
        health: health.snapshot(),
        // which sessions MoPilot's own channel serves the user's Chrome to: their rows show it, not Your Chrome
        chromeServed: servedChrome(isFlagEnabled, { shipped: extensionShipped() }),
        codexChromeBackend: codexChromeBackends?.available() === true,
      }),
      onChange: () => broadcastAll('availability:changed'),
      // an update of Codex Computer Use waits while a loaded native thread may run the installed copy
      skyInUse: () => codexTools?.nativeComputerLoaded() === true,
    });
    // looked at again when the user comes back (they may have installed something meanwhile)
    app.on('browser-window-focus', () => nativeAvailability.refresh());
    ipcMain.handle('availability:status', (_e, refresh) => {
      if (refresh === true) nativeAvailability.refresh({ force: true });
      return nativeAvailability.status();
    });
    // Try again (a failed Codex Computer Use install) / Check again (its permissions)
    ipcMain.handle('availability:retry', () => nativeAvailability.retry());
    // Settings → Browser's Pair: MoPilot's own extension's pairing page, now (#1632)
    ipcMain.handle('availability:chromePair', () => pairChromeExtension(live.chromeRelay));
    // "Allow Chrome to connect?" answered (its dialog or Settings → Browser)
    ipcMain.handle('availability:chromeAllow', (_e, allow, name) => answerChromeAsk(live.chromeRelay, allow, name));
    // "Add to Chrome": the store page in the user's Chrome (Settings → Browser, the welcome page)
    ipcMain.handle('availability:chromeInstall', () =>
      openChromeStore({ profileDir: live.browserPrefs?.profileDir, external: (url) => shell.openExternal(url) }),
    );
    // Claude in Chrome's live connection per chat (electron/harness/claude/chromeLink.cjs): the chat's status strip
    // reads it from the session state (electron/app/sessions.cjs keeps it there), the Browser settings from claude:chromeLinks
    ipcMain.handle('claude:chromeLinks', (_e, refresh) => claude.chromeLinks(refresh === true));
    ipcMain.handle('claude:chromeReconnect', (_e, chatId) => claude.chromeReconnect(typeof chatId === 'string' && chatId ? chatId : null));
    ipcMain.handle('claude:chromeBrowsers', () => claude.chromeBrowsers());
    ipcMain.handle('claude:chromeSelect', (_e, id) => claude.chromeSelect(String(id)));
    // Codex Browser Use settings: $CODEX_HOME/browser/config.toml, limited by Codex's managed policy, which is
    // read only from a Codex that is already running (opening Settings doesn't start one)
    const browserUse = new CodexBrowserUse({
      home: () => shellEnv.childEnv().CODEX_HOME || path.join(os.homedir(), '.codex'),
      policy: async () => {
        if (!live.codex.init) return { requirementsKnown: false };
        const reads = [live.codex.request('configRequirements/read', {}), live.codex.request('config/read', { includeLayers: false })];
        const [req, cfg] = await withTimeout(Promise.all(reads), 5000, 'Timed out');
        return { requirements: req?.requirements ?? null, config: cfg?.config ?? null };
      },
    });
    // the policy last read is kept for the next run: Codex may not be running then (a Claude Code or ACP chat)
    const blocks = new CodexSiteBlocks({ browserUse, store: path.join(app.getPath('userData'), 'codex-browser-policy.json') });
    codexSiteBlocks = blocks;
    // Settings shows the blocks the browser tools apply in every chat, Codex running or not
    const shown = (/** @type {Promise<any>} */ p) => p.then((view) => blocks.shown(view));
    handle('browserUse:state', () => shown(browserUse.state()));
    handle('browserUse:setPreference', (name, value) => shown(browserUse.setPreference(String(name), value)));
    handle('browserUse:setRule', (resource, origin, decision) =>
      shown(browserUse.setRule(String(resource), String(origin), decision ?? null)),
    );
    handle('browserUse:forget', (origin) => shown(browserUse.forget(String(origin))));
    if (process.env.SAGE_DEBUG_TOOLS === '1') capabilities.register(require('../capabilities/tools/debug.cjs').echo);
    // ahead of the windows' cards: cua_repl asks the user only on a native thread (the vendor's plugin on);
    // managed and helper threads must not gain a second controller
    server.intercepts.add(
      rejectNativeCuaElicitation({
        isNativeThread: (id) => codexTools?.isNativeThread(id) === true,
        send: (m) => server.proc && server.send(m),
        notify: (_threadId, text) => codexEmit({ kind: 'toast', level: 'info', text }, 'any'),
      }),
    );
    // after accounts: this link answers every server request no one before it took
    server.intercepts.add(
      codexServerRequests({
        send: (m) => server.proc && server.send(m),
        registry: capabilities,
        // a sub-agent's request is charged to its parent's chat, as its sage-mcp calls are (codexConfig.cjs ownerOf)
        owner: (threadId) => ({ chatId: live.controller ? live.controller.requestChat(threadId) : threadId, segmentId: threadId }),
      }),
    );
    // sees the Browser plugin's site consent requests on their way to the windows' cards; never consumes one
    server.intercepts.add((m) => siteConsent.observe(m));
    // a Claude process started without its chat (an edit-message rewind) finds it from its session key
    claude.setChatOf((key) => live.controller?.chatOf(key) ?? key);
    // MoPilot's plugin store: every new Claude Code session loads its plugins (electron/plugins/delivery.cjs)
    claude.setPlugins(pluginDelivery());
    claude.setTools({
      registry: capabilities,
      sessions: toolSessions,
      enabled: () => isFlagEnabled('channel.claude.sdkMcp'),
      gatewayDenials: () => require('./gatewayManaged.cjs').gatewayDenials(live), // gateway's servers (claude/gatewayNative.cjs)
      // Claude in Chrome for subscription sessions (electron/harness/claude/index.cjs nativeChromeFor) when the user chose it and
      // Chrome has the Claude extension's native host; any other session gets MoPilot's Chrome tools
      nativeChrome: () => claudeInChrome() && nativeAvailability.claudeChromeReady(),
      // such a session already controls the user's Chrome: Your Chrome's browser tools would be a second controller
      hideTool: toolVisibility.forHost(CLAUDE_IN_CHROME_HOST),
      // whether sage_browser_* drive the user's Chrome, for the note on what the tools reach (capabilities/contract/surfaceNote.cjs)
      yourChrome: () => userChromeOf(live.browserControl),
    });
    // Keep MoPilot tools for every surface the vendor cannot serve; avoid a second controller for one it can.
    const hideOnNativeCodex = (surfaces) => toolVisibility.forHost({ nativeChrome: surfaces.chrome, nativeComputer: surfaces.computer });
    if (transport.available) {
      const toolSocket = new ToolSocket({ sessions: toolSessions, registry: capabilities });
      app.on('will-quit', () => toolSocket.close());
      const socketPath = (
        await startupResource(
          signal,
          () => toolSocket.listen(),
          () => toolSocket.close(),
        )
      )();
      codexSocketPath = socketPath;
      // listens only once a harness that takes no stdio MCP server (Copilot CLI) starts a session
      const toolHttp = new ToolHttp({ sessions: toolSessions, registry: capabilities });
      app.on('will-quit', () => toolHttp.close());
      acpTools = new SessionMcp({
        sessions: toolSessions,
        socket: toolSocket,
        http: toolHttp,
        command: transport.command,
        args: transport.args,
        enabled: () => isFlagEnabled('channel.acp.sessionMcp'),
      });
    }
    // Codex's Browser plugin drives the browser pane on a native thread: its "iab" backend, one socket per thread
    const iabBackends = mainIabBackends({ live, server, isFlagEnabled, shellEnv, browserEnabled: inAppBrowserEnabled });
    app.on('will-quit', () => iabBackends.exited());
    // and the user's Chrome through MoPilot's relay (B2), an "extension" backend per thread while its switch is on
    const chromeBackends = mainChromeBackends({ live, server, isFlagEnabled, shellEnv, shipped: extensionShipped() });
    app.on('will-quit', () => chromeBackends.exited());
    codexChromeBackends = chromeBackends;
    // the plugin's own cua_repl definition, which a thread's config can narrow (codexPluginChrome.cjs)
    const cuaServer = () => pluginCuaServer({ codexHome: shellEnv.childEnv().CODEX_HOME || path.join(os.homedir(), '.codex') });
    // the Codex adapter gives each thread it starts, forks or resumes its config (electron/harness/codex.cjs):
    // sage-mcp when it exists, and the vendor's computer-use plugin on a native thread, which needs no sage-mcp
    const injection = new CodexToolInjection({
      sessions: toolSessions,
      command: transport.command,
      args: transport.args,
      socketPath: codexSocketPath,
      harnessPid: (p) => server.pidFor(p),
      hasTools: () => !!codexSocketPath && capabilities.list().length > 0 && isFlagEnabled('channel.codex.threadConfigMcp'),
      // a sub-agent thread's calls are its parent chat's (requestChat follows the spawn link), so Stop there reaches them
      chatOf: (id) => live.controller?.requestChat(id) ?? id,
      disableUserNodeRepl: () => isFlagEnabled('codex.disableUserNodeRepl'),
      nativeEnabled: () => isFlagEnabled('native.codex.enabled'),
      nativeSurfaces: () => nativeAvailability.codexSurfaces(),
      nativeHideFor: hideOnNativeCodex,
      degradedNote: (surfaces, serverName) => nativeAvailability.degradedNote(surfaces, serverName),
      visibleTools: (chatId) => capabilities.list({ chatId }).map((t) => t.name),
      yourChrome: () => userChromeOf(live.browserControl),
      // read once per native thread load (its note): which ChatGPT extension backend is the user's Chrome
      chromeInstances: chatgptExtensionInstances,
      browserBackends: combineBackends(iabBackends, chromeBackends),
      // which browser in agent.browsers.list() is MoPilot's Chrome (step 0: get('chrome') can pick the vendor's)
      chromePending: (threadId) => chromeBackends.loading(threadId),
      chromeNote: (threadId) => (chromeBackends.serves(threadId) ? chromeBackendNote(threadId) : null),
      // a loaded thread's path is fixed until it unloads: its chat's controller plan reads it (session/controllerPlan.cjs)
      onLoaded: (threadId) => live.controllerPlans?.loaded(threadId),
      // the plugins MoPilot gave Codex are off in its helper threads, and in every thread with plugins.codex off
      pluginConfig: (o) => codexPluginMirror().threadConfig(o),
      // MoPilot's Chrome for Codex (#1319 G28): the plugin's Chrome left out, the chrome_* tools in its place
      chromeOff: () => codexChromeOff({ isEnabled: isFlagEnabled, shipped: extensionShipped(), server: cuaServer }),
      // a thread keeping the plugin's Chrome without its computer use (Codex Computer Use not chosen, or down, #1381)
      computerOff: () => cuaWithoutComputer(cuaServer()),
      defersMcpTools: () => live.codex?.negotiated?.flags?.['features.tool_search_always_defer_mcp_tools'] === true,
    });
    codexTools = injection;
    // each Codex thread (a chat's own, each sub-agent's) has its own turn token, a call's thread read from its turn
    // metadata (a sub-agent sharing its parent's session); Claude Code and ACP calls the chat's
    capabilities.setTurnThread((chatId, segmentId, meta) => injection.turnThreadOf(chatId, segmentId, meta));
    // it watches thread responses and thread/closed from the Codex adapter (codexConnection.cjs onServer), after an
    // answer's hook: never from the intercept chain, which reads a switch's new thread before the switch claims it
  }

  /** Computer use, before any harness session starts, so every session is given the tools. */
  function openComputerUse(flags) {
    computerUse = setupComputerUse({
      ipcMain,
      registry: live.routines.recording(capabilities, () => computerUse?.apps, 'desktop_'), // G4: startup opened routines first
      flags,
      chats: live.chats,
      controller: live.controller,
      sessions: live.sessions,
      userData: app.getPath('userData'),
      packaged: app.isPackaged,
      broadcast: broadcastAll,
      // a text-only model's screen is read by the chat provider's own vision model when the app can call it
      // (an Anthropic API key), else by a vision model on MoPilot credits
      vision: {
        backendFor: gatedBackend(
          () => isFlagEnabled('shared.visionFallback'),
          async (chatId) => {
            // e2e tests: a fake backend that answers without a network
            if (process.env.SAGE_VISION_FAKE) return JSON.parse(process.env.SAGE_VISION_FAKE);
            // without the chat's capabilities its provider is unknown, and the screen is read on MoPilot credits
            const caps = await live.capsService
              ?.get(chatId)
              .catch((error) => (noteIgnored("read a chat's capabilities to pick a vision model", error), null));
            const p = caps?.provider;
            return pickVisionBackend({
              provider: p?.id === 'anthropic' ? providerVision(p, claude.visionAuth()) : null,
              mopilot: { signedIn: !!live.mopilot?.gatewayKey(), model: MOPILOT_VISION_MODEL },
              chatVendor: p?.id === 'mopilot' ? MOPILOT_VENDOR : (p?.label ?? p?.id ?? null),
            });
          },
        ),
        read: (backend, req) => {
          if (process.env.SAGE_VISION_FAKE) return Promise.resolve(req.prompt.includes('Where is') ? '{"x": 0, "y": 0}' : 'A fake screen');
          if (backend.source !== 'provider')
            return anthropicVision({
              baseUrl: /** @type {string} */ (API_BASE), // offered only signed in, so never without the MoPilot service
              headers: () => ({ authorization: `Bearer ${live.mopilot.gatewayKey()}` }),
              model: backend.model,
            })(req);
          // the provider's own model, on the credentials the app holds for it (never on the MoPilot key)
          const auth = claude.visionAuth();
          if (!auth) return Promise.reject(new Error('no credentials for the provider vision model'));
          return anthropicVision({ baseUrl: auth.baseUrl, headers: () => auth.headers, model: backend.model })(req);
        },
      },
      remote: live.remoteOwners,
      ...hostDesktopOptions(live), // a Host chat uses its machine's desktop, never this Mac's
      stop: stopOwnerOrChat(live),
      // a paused chat's deferred card goes up when its turn ends while a window shows it, focused or not
      shown: chatShown,
      // the desktop_* tools: the "using your computer" overlay, Esc to stop, the clipboard, and hiding
      // MoPilot's windows while a chat holds the desktop
      electron: desktopElectron({ BrowserWindow, screen, globalShortcut, clipboard, app }),
      // the chat's model sizes its screenshots (high-resolution models take larger ones)
      prefs: uiPrefs,
      notify: (chatId, appName) => {
        const chat = live.codex?.chatName(chatId) || 'This chat';
        live.notifier?.notify('auth', chatId, {
          title: `"${chat}" needs your OK to control ${appName}. Goal paused.`,
          body: '',
          chatTitle: chat,
        });
      },
      // "<Agent> is using <App>" and "Done using <App>" (the Computer use notification switch)
      notifyKind: (kind, chatId, opts) => live.notifier?.notify(kind, chatId, opts),
      agentName: (chatId) => agentLabel(live.controller.ref(chatId).kind, (id) => acpQuirks.describe(id)?.label),
      chatName: (chatId) => live.codex?.chatName(chatId) || null,
      // the tray's Stop item; and no notification over the screen while a chat clicks on it (they wait until it lets go)
      onControlling: (chatId) => (setControlling(chatId), live.notifier?.hold(!!chatId)),
      // after a person's Esc or Stop click, and on a click on the pill's label, MoPilot comes to the front on the chat
      showChat: (chatId) => appWindows.commandMainWindow('open-chat', chatId).catch(ignoring('open the chat Esc stopped')),
      // Settings opens a permission's pane even when the helper can't start
      openExternal: (url) => shell.openExternal(url),
      // the helper's launch, exit and permissions feed the capability health record
      onHealth: () => health.changed(),
      // Codex Computer Use (Sky) on a native thread holds MoPilot's desktop lock while its turn runs
      nativeThread: (threadId) => codexTools?.isNativeThread(threadId) === true,
      requestChat: (threadId) => live.controller.requestChat(threadId),
      subagentThread: (threadId) => codexTools?.parents.parentOf(threadId) != null,
      onNativeBusy: (threadId, turnId, chatId, holderChat, blocked, refusal) => {
        // another chat of this app, or (null) another app or MoPilot profile holding the helper's lock; or an
        // app on MoPilot's no-go list (`blocked`: why; `refusal`: which app)
        /** @type {import('../capabilities/contract/controlRefusals.cjs').Refusal} */
        const r =
          blocked && refusal
            ? refusal
            : { reason: 'busy', holder: (holderChat && live.codex?.chatName(holderChat)) || null, chat: !!holderChat };
        // the line stays in the chat's transcript (#1724); the system notification reaches a user who is elsewhere
        live.computerUse?.refusals.note(chatId, r);
        live.notifier?.notify('computer', chatId, { title: 'Computer use stopped', body: refusalText(r) });
        // the native stop sends the plugin's Interrupt hook with it (CodexAdapter.interruptNative); the model is told why
        // after it, so its next turn answers another way instead of trying again
        live.codex
          ?.request('turn/interrupt', { threadId, turnId })
          .catch((error) => noteIgnored('stop a Codex Computer Use turn MoPilot refused', error))
          .then(() => live.codex?.request('thread/inject_items', { threadId, items: [developerItem(modelNote(r))] }))
          .catch((error) => noteIgnored('tell a Codex model why MoPilot stopped its computer use', error));
      },
      // Esc or Stop: the chat's own Stop reaches its current thread; a sub-agent thread holding the desktop is stopped here
      onNativeStop: (threadId, turnId) => {
        if (!codexTools?.parents.parentOf(threadId)) return;
        live.codex
          ?.request('turn/interrupt', { threadId, turnId })
          .catch((error) => noteIgnored("stop a Codex sub-agent's Computer Use turn on Esc", error));
      },
    });
    // Settings → Computer use: Codex Computer Use for Codex chats (default off, #1381). New chats follow it; the Codex
    // row says so at once, and turning it on installs Codex Computer Use when it is due (openTools set availability up)
    ipcMain.handle('computer:setCodexNativeComputer', (_e, on) => {
      const saved = computerUse.grants.setCodexNativeComputer(on === true);
      nativeAvailability.refresh({ force: true });
      nativeAvailability.onChange();
      return saved;
    });
  }

  return {
    openTools,
    openComputerUse,
    toolSessions,
    /** @returns {InstanceType<typeof Registry>} */
    get capabilities() {
      return capabilities;
    },
    /** The capability-health record (assigned in openTools); its readers are told when it changes. */
    get health() {
      return health;
    },
    /** @returns {InstanceType<typeof NativeAvailability>} */
    get nativeAvailability() {
      return nativeAvailability;
    },
    /** @returns {InstanceType<typeof CodexToolInjection> | null} */
    get codexTools() {
      return codexTools;
    },
    /** Which native Codex threads MoPilot serves the user's Chrome to (the sign-in hand-off's route reads it). */
    get codexChromeBackends() {
      return codexChromeBackends;
    },
    /** @returns {InstanceType<typeof CodexSiteBlocks> | null} */
    get codexSiteBlocks() {
      return codexSiteBlocks;
    },
    siteConsent,
    /** @returns {InstanceType<typeof SessionMcp> | null} */
    get acpTools() {
      return acpTools;
    },
    /** @returns {ReturnType<typeof setupComputerUse>} */
    get computerUse() {
      return computerUse;
    },
  };
}

module.exports = { createAgentTools };
