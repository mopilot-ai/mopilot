// IPC for Host: whether Host exists for this account (the closed-alpha gate), and the user's remote machines: the list, adding one (install, pair), pairing by a pasted code, signing in to an agent on one, and removing; all of it refused while Host is not allowed.
const os = require('node:os');
const path = require('node:path');
const { retirementRoutes, machineRetirement } = require('../../host/retirementRoutes.cjs');
const { registerHostPicture } = require('../hostPicture.cjs');
const { hostAccess, onHostAccess } = require('../../host/access.cjs');
const { registerLocalHost } = require('../../host/localHost.cjs');
const { macDefaultOf } = require('../../host/remotePicks.cjs');
const { createMachines, chatCapabilities, hostOwnership } = require('../../host/machines.cjs');
const { createHostFolders } = require('../../host/folders.cjs');
const { createGitSignInRead } = require('../../host/gitSignInRead.cjs');
const { registerHostSignin } = require('./hostSignin.cjs');
const { createToolRelay, hostToolsFor } = require('../../host/toolRelay.cjs');
const { desktopAnnounce } = require('../../host/desktopAnnounce.cjs');
const { createSshChannel, createSshProbe } = require('../../host/sshChannel.cjs');
const { ensureKey, revokeKey, identityArgs } = require('../../host/sshKey.cjs');
const { createAskpass } = require('../../host/sshAskpass.cjs');
const { registerHostAdd } = require('./hostAdd.cjs');
const { createConnectPrompts } = require('../../host/connectPrompts.cjs');
const { discover, reachable } = require('../../host/discovery.cjs');
const { verifyDescendant } = require('../../capabilities/browser/iabBackend/environment.cjs');
const { OwnershipStore } = require('../../host/ownership.cjs');
const { createContinueAssembly } = require('../../host/continueAssembly.cjs');
const { CONTINUE_CODES } = require('../../../shared/host/continue.mjs');
const { CARRY_CODES } = require('../../../shared/host/codeCarry.mjs');
const { CODE_CODES } = require('../../../shared/host/codeTransfer.mjs');
const { remoteChatsFor, remoteSendFor, devApprovalMs, laneOf, keepAgent, kindOfChat } = require('../../host/wiring.cjs');
const { queueItem } = require('../../session/queueItem.cjs');
const { attachMomoHome } = require('../../momo/homeService.cjs');
const { sayHello } = require('../../host/helloFirst.cjs');
const { createMachineChatStart } = require('../../host/machineChatStart.cjs');
const { machineSideChat } = require('../../host/machineSideChat.cjs');
const { sideChatUuid } = require('../../../shared/host/sideChats.mjs');
const { holdMove, planHandler, releasePlan } = require('../../host/moveSettle.cjs');
const { noteIgnored } = require('../../ignored.cjs');
const { hostKeyStore, registerHostApiKeys } = require('./hostApiKeys.cjs');
const { carryOf } = require('../../host/carryInput.cjs');
const { registerOwnerPolicy } = require('./hostOwnerPolicy.cjs');
const { registerHostFolders } = require('./hostFolders.cjs');
const { registerOrgAccess } = require('./hostOrgAccess.cjs');
const { registerHostCloud } = require('./hostCloud.cjs');
const { createRelayPaths, relayUrl } = require('../../host/relayPaths.cjs');
const { createHostPhone, phonePlan } = require('../hostPhone.cjs');
const { ProjectsStore } = require('../../platform/projects.cjs');
const NONE = Object.freeze({ machines: [], resolved: true });
// refusals the window shows as they are: not worth a line in the ignored-error log
const OWN = new Set([
  'not_allowed',
  // the key file can't be read (electron/routing/providerKeys.cjs)
  'unreadable',
  // Keep running after restart (electron/host/startAtBoot.cjs): the person's own refusals, said in the sheet
  'wrong_password',
  'not_admin',
  'busy',
  'unknown_machine',
  'bad_port',
  'forward_failed',
  'invalid',
  'outside_roots',
  'directory_missing',
  'not_a_directory',
  'invalid_path',
  'clone_failed',
  'worktree_failed',
  'unsupported',
  ...Object.values(CONTINUE_CODES),
  ...Object.values(CARRY_CODES),
  ...Object.values(CODE_CODES),
]);
const text = (/** @type {unknown} */ v) => (typeof v === 'string' && v ? v : null);
/**
 * @param {{ handle: (channel: string, fn: (event: unknown, ...args: any[]) => unknown) => void }} ipcMain
 * @param {{ live?: any, readState?: () => { prefs?: { lastNewChatHost?: {id: string} | null, permission?: string, autoUpdate?: boolean } }, execWindows?: Set<any>, viewedBy?: any, app: { getPath: (n: string) => string, isPackaged?: boolean, once?: (event: string, fn: () => void) => unknown }, shell: { openExternal: (url: string) => Promise<void> }, shellEnv: { childEnv: () => NodeJS.ProcessEnv }, broadcastAll: (channel: string, ...args: any[]) => void }} [deps]
 * @param {{ probePort?: typeof reachable, find?: typeof discover, create?: typeof createMachines, allowed?: () => boolean, createFolders?: typeof createHostFolders, makeRemoteChats?: typeof remoteChatsFor, makeRemoteSend?: typeof remoteSendFor, safeStorage?: any, makeAskpass?: typeof createAskpass, localOn?: () => boolean }} [o] for tests; safeStorage: encrypts the user's API keys (default Electron's)
 */
function register(
  ipcMain,
  deps,
  {
    find = discover,
    probePort = reachable,
    create = createMachines,
    allowed = hostAccess,
    createFolders = createHostFolders,
    makeRemoteSend = remoteSendFor,
    makeRemoteChats = remoteChatsFor,
    safeStorage,
    makeAskpass = createAskpass,
    localOn = () => require('../../platform/flags.cjs').isEnabled('host.local'),
  } = {},
) {
  ipcMain.handle('host:access', () => allowed());
  /** Paired phones hear when the machines, what their agents run with, or Host's gate change (electron/remote/service.cjs). */
  const phoneChanged = () => void deps?.live?.chromePanel?.service?.onMachinesChanged?.();
  // the user's model keys for their machines (ipc/hostApiKeys.cjs), read when a message goes out or a window asks
  const keys = hostKeyStore({
    userData: () => /** @type {NonNullable<typeof deps>} */ (deps).app.getPath('userData'),
    safeStorage,
    changed: () => void (allowed() && keysChanged()),
  });
  const apiKeys = { forHarness: (/** @type {string} */ h) => keys().forHarness(h), hasFor: (/** @type {string} */ h) => keys().hasFor(h) };
  let /** @type {ReturnType<typeof createMachines> | null} */ machines = null;
  let /** @type {(() => void) | null} */ stopHome = null;
  let /** @type {ReturnType<typeof createContinueAssembly> | null} */ continuing = null;
  // the continue service is made on the first continue, or when a machine answers (a chat may have been continued without it): only once the gate is open
  const continueService = () => {
    const d = /** @type {NonNullable<typeof deps>} */ (deps);
    return (continuing ??= createContinueAssembly({
      dir: d.app.getPath('userData'),
      live: d.live,
      machines: service,
      lostCheck: hostCloud.lostCheck,
      kept: (chatId, harness) => keepAgent(d, chatId, harness),
      report: (problem) => noteIgnored('continue a chat on another host', new Error(problem)),
    }));
  };
  /** What each machine's status was at the last snapshot: a machine that turns online is told what was continued without it. @type {Map<string, string>} */
  const seen = new Map();
  /** @param {{ machines: { id: string, status: string }[] }} snapshot */
  const returned = (snapshot) => {
    for (const m of snapshot.machines) {
      const was = seen.get(m.id);
      seen.set(m.id, m.status);
      if (m.status === 'offline' || was === m.status || !deps?.live?.switchRunner) continue;
      const id = m.id;
      // after the machines service has been returned to its first caller: this runs inside its own change callback
      queueMicrotask(() =>
        continueService()
          .hostReturned(id)
          .catch((e) => noteIgnored('tell a returning host what was continued without it', e)),
      );
    }
  };
  // ssh's questions while a machine is added (host key, password) are asked in the windows; the askpass socket and shared connections live in the user's private temp folder, short enough for a socket path
  const prompts = createConnectPrompts({ broadcast: (e) => deps?.broadcastAll('host:prompt', e) });
  const sshDir = path.join(os.tmpdir(), `mopilot-ssh-${process.getuid?.() ?? 0}`);
  let /** @type {ReturnType<typeof createAskpass> | null} */ askpass = null;
  // made when a window first asks, which it does only once the gate is open: no registry, heartbeat or ssh exists before that
  const wakeMachine = (/** @type {string} */ id) => hostCloud.wake(id); // the cloud service is made below: a chat's send and MoMo's home (over the machines, absent unless allowed and `momo.home` is on) wake through it
  const service = () => {
    const d = /** @type {NonNullable<typeof deps>} */ (deps);
    const env = () => d.shellEnv.childEnv();
    const first = !machines;
    const made = (machines ??= create({
      dir: d.app.getPath('userData'),
      env,
      autoUpdateOn: () => d.readState?.()?.prefs?.autoUpdate !== false,
      // a machine that took a password gets MoPilot's key (~/.ssh/mopilot_ed25519) while it is added
      keyAccess: {
        probe: createSshProbe({ env }),
        ensure: ensureKey,
        consent: require('../../host/keyConsent.cjs').keyConsent(prompts.ask),
        // signed in with the key it takes off, since the machine's record is already gone
        revoke: (destination, identity) =>
          revokeKey({ identity, run: (command) => createSshChannel({ env, sshArgs: identityArgs(identity) })(destination, command) }),
      },
      channel: createSshChannel({
        // a machine that signs in with MoPilot's key uses it for every command (an update, a sign-in), not only the tunnel
        argsFor: (destination) => service().sshArgsFor(destination),
        env,
        askpass: (askpass ??= makeAskpass({
          dir: sshDir,
          ask: prompts.ask,
          verifyPeer: (socket, root) => verifyDescendant({ socket, root }),
        })),
        controlDir: sshDir,
      }),
      onChange: (snapshot) => {
        d.broadcastAll('host:machines', snapshot);
        phoneChanged();
        // a machine that is no longer in the list takes its computer-use approvals with it (never while Host access is off or the list is not read yet: it is empty then)
        if (allowed() && snapshot.resolved) d.live?.computerUse?.hostDesktop?.approvals.sweep(new Set(snapshot.machines.map((m) => m.id)));
        returned(snapshot);
        // a machine that came back: what waited for it goes, and its chats catch up
        remote()
          ?.resume()
          .catch((error) => noteIgnored('send the messages kept for a machine', error));
        chats.followAll();
      },
      onStep: (e) => d.broadcastAll('host:installStep', e),
      apiKeys,
      // the organization's lease goes before a key (registered below, once `handle` exists; read only when a message goes out)
      orgAccess: { lend: (host, harness) => orgAccess.lend(host, harness), covers: (harness) => orgAccess.covers(harness) },
      // machines reachable from any network: through the relay, on the account's relay token (electron/host/relayPaths.cjs)
      relay: createRelayPaths({
        dir: d.app.getPath('userData'),
        url: relayUrl,
        live: d.live,
        safeStorage: safeStorage ?? require('electron').safeStorage,
      }),
      // a sign-in link is the machine's output: signin.cjs lets only a plain https page through
      openExternal: (url) => d.shell.openExternal(url),
      onSignin: (view) => d.broadcastAll('host:signin', view),
      onBoot: (view) => d.broadcastAll('host:boot', view),
      onInstall: (view) => d.broadcastAll('host:agentInstall', view),
      safeStorage: safeStorage ?? require('electron').safeStorage,
      // connection loss retires machine tabs. Registry removal retires the saved device choice.
      ...machineRetirement(d),
      // a harness on the machine calls the app's browser tools through the relay (electron/host/toolRelay.cjs); it ends with the connection
      onRemoteHost: (id, host) => {
        void ownerPolicy.push(id, host);
        const registry = d.live?.capabilities;
        // the desktop's tools are announced only while this machine says it has a desktop, and again when that changes (desktopAnnounce.cjs)
        /** @type {ReturnType<typeof desktopAnnounce>} */
        const desktop = desktopAnnounce({
          has: () => service().row(id)?.capabilities?.desktop === true,
          resync: () => relay?.resync(),
        });
        const relay =
          registry &&
          createToolRelay({
            host,
            registry,
            include: hostToolsFor(desktop.announced),
            // a call is served only for a chat that runs on this machine (the ownership file), never for one of this Mac's own
            owns: (chatId) => d.live?.hostOwnership?.get(chatId).hostId === id,
            report: noteIgnored,
          });
        const unwatch = service().onRowChange(desktop.onRow);
        return () => {
          unwatch?.();
          desktop.dispose();
          relay?.dispose();
        };
      },
    }));
    if (first)
      stopHome = attachMomoHome(made, d, {
        hello: sayHello,
        wake: wakeMachine,
        safeStorage: safeStorage ?? require('electron').safeStorage,
      });
    return made;
  };
  // the tool registry asks which surfaces a chat's owner Host has (electron/capabilities/contract/hostScope.cjs)
  if (deps?.live) deps.live.hostCapabilitiesOf = chatCapabilities({ dir: deps.app.getPath('userData'), allowed, machines: service });
  const activeSideChats = new Map();
  const canFollow = (/** @type {string} */ chatId) => !sideChatUuid(chatId) || activeSideChats.has(chatId);
  // messages to a chat on a machine: main's session handlers ask for this each time (null while Host is off)
  const remote = makeRemoteSend({
    dir: deps ? deps.app.getPath('userData') : '',
    allowed,
    machines: service,
    state: () => deps?.live.controller.state,
    tray: queueItem,
    kindOf: (chatId) => kindOfChat(deps?.live, chatId),
    permissionOf: (chatId) => deps?.live.chats?.get(chatId)?.meta?.config?.hostPermission,
    userDefaultOf: macDefaultOf(deps?.readState),
    selectionOf: (chatId) => deps?.live.chats?.get(chatId)?.meta?.config?.hostSelection,
    paused: (chatId) => deps?.live.notifier?.notify('approval', chatId, { title: 'Run paused: no one answered its approvals', body: '' }),
    approvalMs: devApprovalMs(process.env, deps?.app.isPackaged !== false),
    wake: wakeMachine,
    // a chat continued back to this Mac: what was kept for the machine goes to the controller
    localSend: (chatId, item) => deps?.live.host.send(chatId, item, { waitForDelivery: true }),
    // a message to a chat on a machine that came back goes once the chat listens there again
    subscribed: (chatId) => chats.get()?.subscribed(chatId),
    canSend: canFollow,
    checkFolder: (hostId, folder) => foldersService().list(hostId, { path: folder }),
    report: (error) => noteIgnored('keep the messages for a machine', error),
  });
  if (deps?.live) deps.live.remoteSend = remote;
  // the chats that run on a machine: what they say reaches the transcript and the windows as if they ran here
  const chats = makeRemoteChats({
    dir: deps ? deps.app.getPath('userData') : '',
    allowed,
    machines: service,
    acpHost: () => deps?.live?.acpHost,
    state: () => deps?.live?.controller?.state,
    sender: () => remote(),
    canFollow,
    report: noteIgnored.bind(null, 'follow or retire a machine chat'),
    ...laneOf(ipcMain, allowed, deps), // what a chat waits for and the agent it runs on, as its Host says
    safeStorage: () => safeStorage ?? require('electron').safeStorage,
  });
  const retireHostSideChats = (/** @type {number} */ waitMs = 0) => {
    activeSideChats.clear();
    return chats.retireSideChats(waitMs);
  };
  if (deps?.live) Object.assign(deps.live, { remoteChats: chats.get, remoteForget: chats.forget, retireHostSideChats });
  // quitting ends what Host started: the ssh tunnels would otherwise outlive the app (they are its children), and the connections and the outbox with them
  deps?.app.once?.('will-quit', () => {
    void retireHostSideChats();
    chats.get()?.dispose();
    remote()?.dispose();
    local.dispose();
    stopHome?.();
    machines?.dispose();
    orgAccess.dispose();
    askpass?.close();
  });
  // the browser tabs of every Host (electron/app/hostTabsWiring.cjs): which Host runs a chat, and a machine's connected Host for its browser
  if (deps?.live) {
    deps.live.hostOwnership = hostOwnership({ dir: deps.app.getPath('userData'), allowed });
    deps.live.connectedHostFor = (/** @type {string} */ id) => service().connectedHost(id);
    deps.live.hostNameOf = (/** @type {string} */ id) => service().row(id)?.name ?? null;
  }
  ipcMain.handle('host:machines', () => (allowed() ? service().list() : NONE));
  /** @type {ReturnType<typeof createHostFolders> | null} */
  let folders = null;
  // made on the first folder request, which comes only once the gate is open
  const foldersService = () => {
    const d = /** @type {NonNullable<typeof deps>} */ (deps);
    return (folders ??= createFolders({
      open: (id, onEvent) => service().session(id, onEvent),
      store: new OwnershipStore(path.join(d.app.getPath('userData'), 'host-ownership.json')),
      onProgress: (p) => d.broadcastAll('host:cloneProgress', p),
      allowed,
      watch: onHostAccess,
    }));
  };
  // errors come back as values, so the window sees the message and its code (the bridge's call() rethrows them)
  const handle = (
    /** @type {string} */ channel,
    /** @type {(this: { sender?: any }, ...args: any[]) => unknown} */ fn,
    available = allowed,
  ) =>
    ipcMain.handle(channel, async (/** @type {any} */ _e, ...args) => {
      try {
        if (!available()) throw Object.assign(new Error('Host is not available for this account.'), { code: 'not_allowed' });
        return { value: await fn.apply({ sender: _e?.sender }, args) };
      } catch (err) {
        const e = /** @type {any} */ (err);
        if (!OWN.has(e?.code) && e?.name !== 'SchemaError') noteIgnored(`run ${channel}`, e);
        return { error: { message: String(e?.message ?? 'Something went wrong.'), ...(e?.code ? { code: e.code } : {}) } };
      }
    });
  const ownerPolicy = registerOwnerPolicy({ handle, userData: () => /** @type {any} */ (deps).app.getPath('userData'), service });
  const orgAccess = registerOrgAccess({
    handle,
    userData: () => /** @type {NonNullable<typeof deps>} */ (deps).app.getPath('userData'),
    // read when the service is first made: registering with the gate closed loads nothing of Electron's
    safeStorage: () => safeStorage ?? require('electron').safeStorage,
    // the IdP's sign-in page, in the system browser
    openExternal: (url) => /** @type {NonNullable<typeof deps>} */ (deps).shell.openExternal(url),
    broadcast: (channel, payload) => {
      deps?.broadcastAll(channel, payload);
      // what each machine's agents are ready for changes with it
      if (machines) deps?.broadcastAll('host:machines', machines.list());
      phoneChanged();
    },
    remote: () => remote(),
  });
  registerHostAdd({ handle, service, prompts });
  const local = registerLocalHost({ handle, service, enabled: localOn, deps, allowed });
  handle('host:answerPrompt', (id, answer) => prompts.answer(id, answer));
  // `reachable`: whether a machine's ssh answers yet (a Mac whose Remote Login was off), which the card asks while it waits; `discover`, the Add machine picker, only when it opens: ssh config, Bonjour and Tailscale peers
  handle('host:reachable', (destination) => probePort({ destination: String(destination ?? '') }));
  handle('host:discover', () =>
    find({
      machines: service()
        .list()
        .machines.map((m) => ({ address: String(m.id).replace(/^ssh:/, '') })),
    }),
  );
  handle('host:pair', (id, code) => service().pair(String(id ?? ''), code));
  handle('host:update', (id) => service().updateHost(String(id ?? '')));
  // whether git can sign in to github.com on a machine, read now from its Host when the window asks (never polled)
  const gitSignIn = createGitSignInRead({ open: (/** @type {string} */ id) => service().session(id) });
  handle('host:gitSignIn', (id) => gitSignIn(String(id ?? '')));
  handle('host:forwardPort', (id, port) => service().forwardPort(String(id ?? ''), port));
  handle('host:setPath', (id, mode) => service().setPath(String(id ?? ''), mode));
  // Add by command (electron/host/machineBoot.cjs): the command to show, and the user's answer to the machine that ran it
  handle('host:bootStart', (retryJoin) => service().boot.start(retryJoin === true));
  handle('host:bootView', () => service().boot.view());
  handle('host:bootAllow', () => service().boot.allow());
  handle('host:bootDeny', () => service().boot.deny());
  registerHostFolders({ handle, folders: foldersService, app: deps?.app, machine: (id) => service().row(id) });
  handle('host:bindFolder', (chatId, q) => foldersService().bind(String(chatId ?? ''), q ?? {}));
  // a new chat for a machine: the folder is recorded with its Host, the chat is listed, and its first message (sent next) starts it there
  const machineChats = createMachineChatStart({
    row: (id) => service().row(id),
    apiKeys,
    orgAccess,
    bind: (chatId, at) => foldersService().bind(chatId, at),
    // no outbox (Host access ended meanwhile): the chat is refused rather than bound with no first message to start it
    begin: (chatId, start) => {
      const sender = remote();
      if (!sender) throw Object.assign(new Error('Host is not available for this account.'), { code: 'not_allowed' });
      sender.begin(chatId, start);
    },
    follow: (chatId) => chats.get()?.follow(chatId),
  });
  handle('host:startChat', async (q) => {
    const { chatId } = await machineChats.start({
      chatId: text(q?.chatId) ?? '',
      hostId: text(q?.hostId) ?? '',
      folder: text(q?.folder) ?? '',
      harness: text(q?.harness) ?? '',
      projectId: text(q?.projectId),
      scope: q?.scope,
    });
    return { chatId };
  });
  const openSideChat = machineSideChat({
    ownerOf: chats.sideChatOwner,
    kindOf: (chatId) => kindOfChat(deps?.live, chatId),
    row: (id) => service().row(id),
    start: machineChats.start,
    active: activeSideChats,
    retire: chats.retireSideChats,
    live: () => deps?.live,
  });
  // The shared side-chat action asks main before choosing a local adapter. Local parents still work with Host off.
  handle(
    'host:openSideChat',
    function (chatId, restoring) {
      return allowed() ? openSideChat(chatId, restoring, this.sender?.id) : null;
    },
    () => true,
  );
  // a scheduled run on a machine (electron/platform/automationRun.cjs) starts its chat the same way, and sends its message through the outbox
  if (deps?.live)
    deps.live.machineChats = {
      ...machineChats,
      allowed,
      /** @param {string} hostId @param {string} harness */
      readiness: (hostId, harness) =>
        allowed()
          ? machineChats.readiness(hostId, harness)
          : { ok: false, error: Object.assign(new Error('Host is not available for this account.'), { code: 'not_allowed' }) },
      /** @param {{ chatId: string, hostId: string, folder: string, harness: string, projectId?: string | null }} q */
      start: (q, o) => {
        if (!allowed()) throw Object.assign(new Error('Host is not available for this account.'), { code: 'not_allowed' });
        return machineChats.start(q, o);
      },
      /** @param {string} chatId @param {any} item */
      send: (chatId, item) => remote()?.send(chatId, item, null) ?? null,
      nameOf: (/** @type {string} */ id) => service().row(id)?.name ?? null,
      // a machine that fires its own scheduled tasks (electron/host/hostSchedules.cjs): its Host, its row, and a run's chat it started taken in like one started here
      hostFor: (/** @type {string} */ id) => (allowed() ? service().hostFor(id) : null),
      rowOf: (/** @type {string} */ id) => (allowed() ? service().row(id) : null),
      onRows: (/** @type {() => void} */ fn) => service().onRowChange(fn),
      /** @param {string} chatId @param {{ hostId: string, folder: string }} at */
      adopt: async (chatId, at) => {
        foldersService().bind(chatId, at);
        await chats.get()?.follow(chatId);
      },
    };
  // what a paired phone may do with the machines (app/hostPhone.cjs): the same services, the same refusals
  if (deps?.live)
    deps.live.hostPhone = createHostPhone({
      allowed,
      watch: onHostAccess,
      machines: service,
      folders: foldersService,
      machineChats,
      // a phone's start replies once the first message is kept; the machine is told in the background
      enqueue: (chatId, item, gate) => remote()?.enqueue(chatId, item, null, gate) ?? null,
      // the phone's permission pick is the chat's mode before its first message goes, so that message carries it to the machine
      setMode: (chatId, mode) => deps?.live.controller.state.patch(chatId, { permission: mode }),
      announce: (e) => deps.live.announceRunChat?.(e),
      // the window's own call goes through `handle`, which refuses without the gate; a phone's is refused the same way
      move: async (req) => {
        if (!allowed()) throw Object.assign(new Error('Host is not available for this account.'), { code: 'not_allowed' });
        return continueChat(req);
      },
      plan: async (req) => phonePlan(await codePlanOf(req), Boolean(deps?.live?.switchRunner)),
      ownership: deps.live.hostOwnership,
      orgCovers: (harness) => orgAccess.covers(harness),
      agents: service,
      changed: phoneChanged,
      projects: () => new ProjectsStore(path.join(deps.app.getPath('userData'), 'projects.json')).list().projects,
    });
  if (deps?.live) require('./hostPhoneDirect.cjs').registerPhoneDirect({ deps, handle, service, allowed, changed: phoneChanged });
  // a key changes what each machine's agents are ready for: the windows get the list again
  const keysChanged = () => {
    /** @type {NonNullable<typeof deps>} */ (deps).broadcastAll('host:machines', service().list());
    phoneChanged();
  };
  registerHostApiKeys({ handle, keys });
  // the app's keys go first, so no message lends one while the machines are told
  handle('host:signOutEverywhere', async () => {
    // told once, below, after the organization sign-in has ended too
    keys.quietly(() => keys().removeAll());
    // the organization sign-in ends here and at its IdP, and every machine takes back this identity's leases (named before it is forgotten)
    const identity = orgAccess.identity();
    await orgAccess.signOut().catch((e) => noteIgnored('sign out of the organization', e));
    keysChanged();
    return service().signOutEverywhere(identity);
  });
  handle('host:rename', (id, name) => service().rename(String(id ?? ''), String(name ?? '')));
  // the administrator password goes straight to the machine's sudo (electron/host/startAtBoot.cjs) and is not kept here
  handle('host:setStartAtBoot', (id, on, password) =>
    service().setStartAtBoot(String(id ?? ''), on === true, typeof password === 'string' ? password : ''),
  );
  handle('host:startAtBootCommand', (id) => service().startAtBootCommand(String(id ?? '')));
  handle('host:rotateKey', () => service().rotateKey());
  handle('host:removePlan', (id) => service().removePlan(String(id ?? '')));
  // the administrator password goes straight to the machine's sudo and is not kept (electron/host/uninstallHost.cjs)
  handle('host:uninstall', (id, password) => service().uninstallHost(String(id ?? ''), typeof password === 'string' ? password : ''));
  registerHostPicture(handle, () => deps?.live, service);
  retirementRoutes({ handle, chats, machines: service, allowed, deps });
  // which chats run where (host:owner, host:remoteChats) and the cloud machines (electron/host/cloudService.cjs); every cloud call is refused while `host.cloud` is off
  const hostCloud = registerHostCloud({ handle, ipcMain, service, deps: () => deps, allowed, safeStorage: () => safeStorage });
  const nameOf = (/** @type {string} */ id) => service().row?.(id)?.name ?? null;
  /** Switch host, for the window's dialog and a phone's chat.move: main's machine (electron/host/continue.cjs) once the remote channel is wired. @param {any} req */
  const continueChat = async (req) => {
    const chatId = text(req?.chatId);
    const targetHostId = text(req?.targetHostId);
    const cwd = text(req?.cwd);
    const move = holdMove({ chatId: chatId ?? '', remote, to: nameOf(targetHostId ?? '') });
    try {
      if (!chatId || !targetHostId || !cwd) throw Object.assign(new Error('Pick a host and a folder.'), { code: 'invalid' });
      const run = deps?.live?.hostContinue ?? (deps?.live?.switchRunner ? (/** @type {any} */ r) => continueService().run(r) : null);
      if (!run) throw Object.assign(new Error("Switching host isn't available yet."), { code: 'unsupported' });
      const out = await run({ chatId, targetHostId, cwd, lostHostConfirmed: req.lostHostConfirmed === true, carry: carryOf(req.carry) });
      // the chat moved: the tabs it left behind start their countdown (electron/capabilities/browser/tabsByHost.cjs)
      deps?.live?.hostTabs?.noticeAll();
      return out;
    } finally {
      await move.end();
    }
  };
  handle('host:continue', continueChat);
  handle('host:planRelease', (chatId) => releasePlan(text(chatId) ?? ''));
  // what the folder picked on the machine holds compared with the chat's repository, and what carrying its uncommitted changes would send: the dialog shows it before the user confirms
  /** What carrying the chat's changes to the folder would send, for the dialog and a phone's chat.move. @param {any} req */
  const codePlanOf = (req) => {
    const chatId = text(req?.chatId);
    const targetHostId = text(req?.targetHostId);
    const cwd = text(req?.cwd);
    if (!chatId || !targetHostId || !cwd) throw Object.assign(new Error('Pick a host and a folder.'), { code: 'invalid' });
    const plan = deps?.live?.hostCodePlan ?? (deps?.live?.switchRunner ? (/** @type {any} */ r) => continueService().codePlan(r) : null);
    return plan ? plan({ chatId, targetHostId, cwd }) : null;
  };
  handle('host:codePlan', planHandler({ remote, nameOf, plan: codePlanOf }));
  registerHostSignin({ handle, service });
  handle('host:chatSwitch', (chatId, pick) => require('../../host/remoteSwitch.cjs').switchChat(deps?.live, chatId, pick)); // the Host holds the pick until the chat's next message
  handle('host:chatGoal', (chatId, what) => require('../../host/remoteGoal.cjs').goalChat(deps?.live, chatId, what)); // the goal bar's action, run by the chat's agent on its machine
}

module.exports = { register };
