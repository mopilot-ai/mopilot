// Main's service for the user's remote machines: the registry, the installer and pairing joined to the tunnel pool, so the heartbeat, an install and a pairing run only while Host access is open, and the windows read one list.
const net = require('node:net');
const path = require('node:path');
const { hostAccess, onHostAccess } = require('./access.cjs');
const { createRegistry } = require('./registry.cjs');
const { createLinkWatch } = require('./linkWatch.cjs');
const { createHostStarter } = require('./startHost.cjs');
const started = require('./started.cjs');
const { createInstaller, createSshChannel } = require('./install.cjs');
const { createRuntimeCache } = require('./nodeRuntime.cjs');
const { bundleOnce, appHostBuild, appHostVersion } = require('./bundle.cjs');
const { isLocal, LOCAL_NOTE, createLocalChannel, routeChannel, localPool } = require('./localHost.cjs');
const { createTunnelPool } = require('./sshTunnel.cjs');
const { introduce, loadIdentity, pairWith, pinned, idOf } = require('./pairingClient.cjs');
const { createHostUpdater } = require('./hostUpdate.cjs');
const { createHostUninstaller } = require('./uninstallHost.cjs');
const { createUpdateStates } = require('./updateStates.cjs');
const { createAutoUpdate, triesFile } = require('./autoUpdate.cjs');
const ownershipReaders = require('./ownershipReaders.cjs');
const { openSession } = require('./hostSession.cjs');
const { createMachineAgents } = require('./machineAgents.cjs');
const { createPortForwards } = require('./portForward.cjs');
const { identityArgs } = require('./sshKey.cjs');
const { noteIgnored } = require('../ignored.cjs');
const { createWireHost } = require('./machineWire.cjs');
const { OwnershipStore, LOCAL_HOST_ID } = require('./ownership.cjs');
const { fileStamp } = require('../platform/fsutil.cjs');
const { capabilitiesOf } = require('../../shared/host/schema.mjs');
const { createMachineRelay } = require('./machineRelay.cjs');
const { createMachineBoot } = require('./machineBoot.cjs');
const { createRemoteHost } = require('./remote.cjs');
const { requestOverSocket } = require('./hostRequest.cjs');
const { createMachineCall, refusal } = require('./machineCall.cjs');
const { createSigninWait } = require('./signinWait.cjs');
const { createStartAtBoot } = require('./startAtBoot.cjs');
const { createMachineChatIndex } = require('./chatIndexWiring.cjs');
const { withCredentials, keyedHarnesses, NO_KEYS, NO_ORG } = require('./remoteCredentials.cjs');
const { signOutEverywhere } = require('./signOut.cjs');
const { withAppChatIds } = require('./chatIds.cjs');
const { agentsOf, installedIds } = require('../../shared/host/agentReadiness.mjs');
const { appChatId } = require('../../shared/host/chatIds.mjs');
const { userError } = require('../../shared/userError.mjs');

/**
 * The epoch the ownership side map holds for a chat; the file is read again each time, since another process may have moved the chat.
 * @param {string} dir the user data dir
 */
function epochReader(dir) {
  /** @type {InstanceType<typeof OwnershipStore> | null} */
  let owners = null;
  return (/** @type {string} */ chatId) => {
    owners ??= new OwnershipStore(path.join(dir, 'host-ownership.json'));
    owners.refresh();
    return owners.get(chatId).epoch;
  };
}

/**
 * Whether the app has a chat on a remote Host under this id (the ownership file). It is asked about for every event of a chat, so the file is read again only when its time or size change.
 * @param {string} dir
 */
function ownedReader(dir) {
  const file = path.join(dir, 'host-ownership.json');
  /** @type {InstanceType<typeof OwnershipStore> | null} */
  let owners = null;
  /** @type {string | null} */
  let seen = null;
  return (/** @type {string} */ chatId) => {
    owners ??= new OwnershipStore(file);
    const now = fileStamp(file);
    if (now !== seen) {
      owners.refresh();
      seen = now;
    }
    return owners.get(chatId).hostId !== LOCAL_HOST_ID;
  };
}

/**
 * @param {object} o
 * @param {string} o.dir the user data dir: the registry, the client key and the forwarded sockets live under it
 * @param {() => NodeJS.ProcessEnv} [o.env] the login-shell environment ssh runs in (electron/platform/env.cjs)
 * @param {(snapshot: ReturnType<ReturnType<typeof createMachines>['list']>) => void} [o.onChange] told on every change of the list
 * @param {(event: { destination: string, step: any }) => void} [o.onStep] told as each install step starts and ends
 * @param {() => boolean} [o.allowed] Host's closed-alpha gate (electron/host/access.cjs)
 * @param {(cb: (ok: boolean) => void) => unknown} [o.watch] follows the gate
 * @param {ReturnType<typeof createRegistry>} [o.registry] for tests
 * @param {ReturnType<typeof createInstaller>} [o.installer] for tests
 * @param {(destination: string, command: string, input?: Buffer) => Promise<{ code: number, stdout: string, stderr: string }>} [o.channel] one command on a machine for the default installer (for tests); defaults to the user's `ssh`
 * @param {string} [o.root] the app's own files, which the Host tarball is built from (default: this checkout or app)
 * @param {{ get: (t: any) => { acquire: () => { socketPath: string, ready: Promise<boolean>, release: () => void } }, closeAll?: () => void }} [o.pool] for tests
 * @param {(record: any, method: string, params?: object) => Promise<any>} [o.call] one request to a machine (for tests); defaults to the tunnel
 * @param {(socketPath: string) => import('node:net').Socket} [o.connect]
 * @param {(record: any, onEvent?: (event: Record<string, any>) => void) => Promise<{ call: (method: string, params?: object, opts?: { timeoutMs?: number }) => Promise<any>, close: () => void }>} [o.session] an authenticated connection to a machine (for tests); defaults to one through its tunnel
 * @param {(url: string) => unknown} [o.openExternal] opens a sign-in link in the Mac's browser (default: none, so a link is never opened by accident)
 * @param {(view: any) => void} [o.onSignin] told how each sign-in stands, at every change
 * @param {(view: any) => void} [o.onInstall] told how each agent install stands, at every change
 * @param {ReturnType<typeof createPortForwards>} [o.forwards] ports of a machine forwarded to this Mac (for tests); defaults to ssh -L
 * @param {() => boolean} [o.autoUpdateOn] the person's "Update automatically", read before each automatic Host update
 * @param {Parameters<typeof createInstaller>[0]['keyAccess']} [o.keyAccess] how a machine that took a password gets MoPilot's key (the app passes sshKey.cjs over real ssh); none skips that step, so a test never touches the real ~/.ssh
 * @param {(id: string, host: ReturnType<typeof createRemoteHost>) => (() => void) | void} [o.onRemoteHost] told when a connection to a machine is made; what it returns is called when that connection ends (the app's tools are offered through it)
 * @param {(id: string) => void} [o.onRemoteEnd] told when a machine's connection ends (the machine left, Host access closed, the app closed): what was built on it goes too
 * @param {(id: string) => void} [o.onRemoved] told after a machine's registry removal commits, whether it had a connection or not
 * @param {{ forHarness: (harness: string) => string | null, hasFor: (harness: string) => boolean }} [o.apiKeys] the user's model keys (apiKeys.cjs), lent to a machine with each message; default none
 * @param {{ lend: (host: any, harness: string) => Promise<boolean>, covers: (harness: string) => boolean }} [o.orgAccess] the organization's access (orgAccess/service.cjs), lent before a key; default none
 * @param {ReturnType<typeof import('./relayPaths.cjs').createRelayPaths> | null} [o.relay] the relay path to the machines (#2709); none: SSH only
 * @param {Partial<Parameters<typeof createMachineChatIndex>[0]>} [o.chats] `notify` and `onChange` of every machine's chat list (chatIndex.cjs)
 * @param {(view: any) => void} [o.onBoot] told how an Add by command stands (machineBoot.cjs), at every change @param {import('../platform/secretFile.cjs').SafeStorage | null} [o.safeStorage] seals this app's Host key
 */
function createMachines({
  dir,
  env = () => process.env,
  onChange = () => undefined,
  onStep = () => undefined,
  allowed = hostAccess,
  watch = onHostAccess,
  registry: givenRegistry,
  installer: givenInstaller,
  channel: givenChannel = createSshChannel({ env }),
  root = path.join(__dirname, '..', '..'),
  pool: givenPool,
  call: givenCall,
  connect = (p) => net.connect(p),
  session: givenSession,
  openExternal = () => undefined,
  onSignin = () => undefined,
  onInstall = () => undefined,
  forwards = createPortForwards({ env }),
  keyAccess = null,
  autoUpdateOn = () => true,
  onRemoteHost,
  onRemoteEnd,
  onRemoved,
  apiKeys = NO_KEYS,
  orgAccess = NO_ORG,
  relay = null,
  onBoot = () => undefined,
  chats = {},
  safeStorage = null,
}) {
  // this Mac's own background Host (localHost.cjs) is reached by local commands and its socket directly; every other machine as before
  const channel = routeChannel(givenChannel, createLocalChannel({ env }));
  const sshPool = localPool(givenPool ?? createTunnelPool({ dir: path.join(dir, 'host-tunnels'), env, allowed, watch }));
  // with a relay, each machine's tunnel is its SSH tunnel joined with its relay tunnel (pathTunnel.cjs)
  const pool = relay ? relay.pool(sshPool, path.join(dir, 'host-tunnels')) : sshPool;
  const targetOf = (/** @type {any} */ r) => ({ destination: r.address, remoteSocket: r.socketPath, sshArgs: identityArgs(r.identity) });
  const machineCall = createMachineCall({ pool, targetOf, relay, connect });
  const { lease } = machineCall;
  const call = givenCall ?? machineCall.call;
  const links = createLinkWatch({ onChange: () => onChange(list()), onUp: () => void registry.check() });
  const registry =
    givenRegistry ??
    createRegistry({
      file: path.join(dir, 'host-registry.json'),
      status: (record) => call(record, 'status'),
      report: (error) => noteIgnored('keep the Host registry', error),
      explain: createSigninWait({ env }),
      linkDropped: links.droppedAt,
    });
  const bundle = bundleOnce({ root, outDir: path.join(dir, 'host-bundle') });
  const runtime = createRuntimeCache({ dir: path.join(dir, 'host-runtime') });
  let disposed = false;
  /** @type {ReturnType<typeof loadIdentity> | null} */
  let identity = null;
  const key = () => (identity ??= loadIdentity(path.join(dir, 'host-client-key.json'), safeStorage));
  const installer = givenInstaller ?? createInstaller({ channel, registry, bundle, updateKey: () => key().publicKey, runtime, keyAccess }); // the machine takes updates from this app
  const updates = createUpdateStates({ appBuild: () => appHostBuild(root), appVersion: () => appHostVersion(root) });
  const updateOptions = { channel, registry, bundle, identity: key, ...updates.forUpdater, status: (r) => call(r, 'status') };
  const updater = createHostUpdater({ ...updateOptions, session: openPaired, allowed: () => !disposed && allowed() });
  const startAtBoot = createStartAtBoot({ registry, env });
  const starter = createHostStarter({ registry, channel });
  const uninstaller = createHostUninstaller({ registry, channel, call: (record, method) => call(record, method) });
  const keyFor = (/** @type {string} */ id) =>
    pinned(key(), registry.list().find((r) => r.id === id)?.hostKey ?? null, (hostKey) => {
      try {
        registry.pin(id, hostKey);
      } catch (error) {
        noteIgnored('keep the name of a machine’s Host', error);
      }
    });
  /** The list the windows draw: each machine's dot, name and one-line reason, and whether every one has answered once. */
  function list() {
    const rows = registry.list().map((r) => {
      // what each agent is ready for (a signed-out one never hides the machine; the user's key or the organization's lease also runs chats there, so the machine is ready, not waiting on a sign-in)
      const agents = agentsOf(keyedHarnesses(r.harnesses, apiKeys, orgAccess), r.name);
      const covered = r.status === 'needs-setup' && agents.some((a) => a.state === 'ready');
      return {
        id: r.id,
        name: r.name,
        rawName: r.rawName,
        status: /** @type {'online' | 'offline' | 'attention'} */ (
          covered ? 'online' : r.status === 'needs-setup' ? 'attention' : r.status
        ),
        note: (!covered && r.reason) || (isLocal(r.address) ? LOCAL_NOTE : `${viaRelay.note(r)} · ${installedIds(r.harnesses)}`),
        ...viaRelay.row(r),
        agents,
        ...(r.hostKey && { repositoryScope: r.hostKey }),
        // the missing agents the machine's Host can install itself (an older Host lists none), while the machine answers
        installable: r.status === 'offline' ? [] : r.harnesses.filter((h) => !h.detected && h.installable === true).map((h) => h.id),
        capabilities: capabilitiesOf(r.capabilities),
        lastSeen: r.lastHeartbeat, // "Offline · seen 2 h ago"
        ...(r.linkDroppedAt !== null && { linkDroppedAt: r.linkDroppedAt }), // a missed ask short of offline: "Reconnecting…"
        localNetwork: r.status === 'offline' ? 'unknown' : r.localNetwork, // what its Host last said, while it answers; with waitingForLogin: an offline machine nobody is signed in on
        waitingForLogin: r.waitingForLogin,
        ...(r.hostStopped && { hostStopped: true }), // ssh answers, the Host does not
        // where it is reached and the app version that built its Host, for the Details dialog
        address: isLocal(r.address) || r.address.startsWith('relay:') ? '' : r.address,
        hostVersion: r.hostAppVersion,
        startsAtBoot: r.startup.atBoot, // what the Host last said of starting at boot (Keep running after restart), FileVault and its system
        ...(r.cloud && { cloud: r.cloud, cloudState: r.status === 'offline' ? null : r.cloudState }),
        fileVault: r.startup.fileVault,
        ...(r.status !== 'offline' && r.pushSkipped > 0 && { pushSkipped: r.pushSkipped }), // waiting cards its Host found no phone for
        platform: r.platform,
        ...autoUpdate.decorate(r, updates.rowFor(r.id, r.hostBuild, r.lastHeartbeat !== null, r.hostAppVersion)), // the Host older than this app's, an update under way, waiting or failed
      };
    });
    return {
      machines: allowed() ? rows : [],
      resolved: registry.resolved(),
      ...(registry.membershipIncomplete?.() && { registryUnreadable: true }),
    };
  }
  // an older Host reached over ssh is brought up to this app's build by itself (autoUpdate.cjs); never while the keys are being rotated
  let buildId = '';
  const autoUpdate = createAutoUpdate({
    registry,
    rows: () => list().machines,
    allowed,
    on: autoUpdateOn,
    appBuild: () => (buildId ||= appHostBuild(root)),
    update: (id) => service.updateHost(id, true),
    store: triesFile(path.join(dir, 'host-auto-update.json')),
  });
  const offChange = registry.onChange(() => {
    autoUpdate.consider();
    onChange(list());
  });
  // the relay path (#2709): each machine's row says how it is reached, and a machine reached over SSH is given a relay path once
  const viaRelay = createMachineRelay({ relay, registry, pool, targetOf, allowed, openPaired, onChange: () => onChange(list()) });
  // Add by command (machineBoot.cjs): a machine the Mac cannot SSH to joins through the relay
  const boot = createMachineBoot({ relay, registry, bundle, updateKey: () => key().publicKey, pair, openPaired, onView: onBoot });
  /** One connection per machine, made when a chat first sends to it or a sign-in first asks; `detach` undoes what onRemoteHost set up on it. @type {Map<string, { address: string, socketPath: string, host: ReturnType<typeof createRemoteHost>, detach?: (() => void) | void }>} */
  const hosts = new Map();
  const epochOf = epochReader(dir);
  const known = ownedReader(dir);
  /** The remote Host of a machine in the list (null for one that is not, or has no socket on record), connected on first use by the caller. @param {string} id */
  function hostFor(id) {
    const record = registry.list().find((r) => r.id === id);
    if (!record || !record.socketPath || disposed || !allowed()) return null;
    const open = hosts.get(id);
    if (open?.address === record.address && open.socketPath === record.socketPath) return withAppChatIds(open.host, known);
    // another machine answers to this id now: the old connection goes back to its tunnel
    dropHosts(id);
    const tunnel = pool.get(targetOf(record));
    // every chat request carries the epoch the ownership file holds, and every connection proves the app's key first (a Host serves a paired client only)
    // the connection speaks the Host's chat ids; the ownership file and everything else here use the app's (shared/host/chatIds.mjs)
    const remote = createRemoteHost({
      id,
      tunnel: /** @type {any} */ (tunnel),
      connect,
      identity: () => keyFor(id),
      epochOf: (hostChat) => epochOf(typeof hostChat === 'string' && known(appChatId(hostChat)) ? appChatId(hostChat) : hostChat),
    });
    // a message carries the user's key for its agent on the control channel first (remoteCredentials.cjs)
    const host = withCredentials(remote, apiKeys, orgAccess);
    const seen = withAppChatIds(host, known);
    hosts.set(id, { address: record.address, socketPath: record.socketPath, host, detach: wireHost(id, seen) });
    return seen;
  }
  const wireHost = createWireHost(onRemoteHost, links.watch); // what the app sets up on a new connection, and the drop time it feeds the row (machineWire.cjs)
  /** Connections end with the machine, with the gate and with the service. With the gate and the service so do the forwarded ports (with a machine they go in `remove`; a connection beginning or replaced is not their end). @param {string} [only] */
  function dropHosts(only) {
    if (!only) forwards.dispose();
    for (const id of only ? [only] : [...hosts.keys()]) {
      const open = hosts.get(id);
      open?.detach?.();
      open?.host.dispose();
      hosts.delete(id);
      if (open) onRemoteEnd?.(id);
    }
  }

  const refuseUnlessAllowed = () => {
    if (!allowed()) throw refusal('Host is not available for this account.', 'not_allowed');
  };
  // signing in to and installing the agents on a machine
  const agents = createMachineAgents({ registry, hostFor: (id) => hostFor(id), openExternal, onSignin, onInstall, refuseUnlessAllowed });
  /** Heartbeats run while Host access is open, and stop when it is lost. */
  const follow = (/** @type {boolean} */ ok) => {
    if (disposed) return;
    if (ok) registry.start();
    else {
      registry.stop();
      // without access nothing of Host runs
      agents.dispose();
      dropHosts();
    }
    onChange(list());
  };
  watch(follow);
  if (allowed()) registry.start();

  /** An authenticated connection to a paired machine through its tunnel, held until it is closed. @param {any} record @param {(event: Record<string, any>) => void} [onEvent] */
  async function openPaired(record, onEvent) {
    if (givenSession) return givenSession(record, onEvent);
    const held = await lease(record);
    try {
      const opened = await openSession({
        socketPath: held.socketPath,
        identity: keyFor(record.id),
        onEvent,
        connect,
        report: (e) => noteIgnored('hand a Host event to its listener', e),
      }).then((session) => introduce(record.id, session));
      let released = false;
      return {
        call: opened.call,
        close: () => {
          opened.close();
          if (!released) held.release();
          released = true;
        },
      };
    } catch (e) {
      held.release();
      throw e;
    }
  }

  /** Register this app with a machine using the code its Host printed. @param {string} id @param {unknown} code */
  async function pair(id, code) {
    refuseUnlessAllowed();
    const record = registry.list().find((r) => r.id === id);
    if (!record) throw refusal('That machine is not in the list.', 'unknown_machine');
    const paired = await pairWith((method, params) => call(record, method, params), key(), code);
    registry.pin(id, paired.hostId); // the machine's Host is known by this name from now on
    dropHosts(id); // a standing connection made before this holds the Host's "unknown client" answer: the next use agrees and proves the key again
    updates.forget(id);
    await registry.check();
    // a machine paired over SSH gets its relay path now, so it is reachable from any network later
    await viaRelay.enroll(id);
  }
  const chatIndex = createMachineChatIndex({ registry, openPaired, allowed: () => !disposed && allowed(), ...chats });
  onChange = chatIndex.wrap(onChange);
  const service = {
    list,
    chatIndex: () => chatIndex.snapshot(),
    /** The Host build this app carries: what a machine's Host must run to serve MoMo's home. */
    appBuild: () => (buildId ||= appHostBuild(root)),
    /** Every machine takes back the user's key and `orgIdentity`'s leases and signs Claude Code and Codex out; each one's result, then the list is read again. @param {string | null} [orgIdentity] */
    signOutEverywhere: async (orgIdentity = null) => {
      const results = await signOutEverywhere({ machines: registry.list(), hostFor, orgIdentity });
      await registry.check();
      return results;
    },
    /** What the machine declared it can do for a chat; a machine not in the list can do nothing. @param {string} id */
    capabilities: (id) => capabilitiesOf(registry.list().find((r) => r.id === id)?.capabilities),
    hostFor,
    selfFingerprint: () => idOf(key().publicKey),
    /** A paired connection to a machine for one exchange (a phone's introduction, P2); the caller closes it. @param {string} id */
    pairedFor(id) {
      refuseUnlessAllowed();
      const record = registry.list().find((r) => r.id === id);
      if (!record) throw refusal('That machine is not in the list.', 'unknown_machine');
      return openPaired(record);
    },
    /**
     * This Mac's loopback port that reaches a port of the machine (a dev server the agent started there), for the Mac's own browser.
     * @param {string} id @param {unknown} port
     */
    forwardPort(id, port) {
      refuseUnlessAllowed();
      const record = registry.list().find((r) => r.id === id);
      if (!record) throw refusal('That machine is not in the list.', 'unknown_machine');
      if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) throw refusal('That is not a port.', 'bad_port');
      return forwards.forward({ machine: id, destination: record.address, sshArgs: identityArgs(record.identity), remotePort: port });
    },
    /**
     * A machine's remote Host for its browser if it is connected now, else null, and the connection is begun for the next ask (the tabs
     * of a Host are made inside a tool call that must not wait).
     * @param {string} id
     */
    connectedHost(id) {
      refuseUnlessAllowed();
      const host = hostFor(id);
      if (!host) return null;
      if (host.state() === 'online') return host;
      host.connect().catch((error) => noteIgnored('connect to a machine for its browser', error));
      return null;
    },
    /** How the app reaches a machine: `auto`, or pinned to `ssh` or `relay` (machineRelay.cjs). @param {string} id @param {unknown} mode */
    setPath(id, mode) {
      refuseUnlessAllowed();
      viaRelay.setMode(id, mode);
      onChange(list());
    },
    /** The registry's row for a machine (its status), undefined when it is not in the list. @param {string} id */
    row: (id) => registry.list().find((r) => r.id === id),
    /** The ssh options the machine at `address` signs in with (its MoPilot key), for a command run over ssh; none for a machine not in the list. @param {string} address */
    sshArgsFor: (address) => identityArgs(registry.list().find((r) => r.address === address)?.identity),
    /** Told on every change of the registry's rows (a heartbeat, a status); returns the way to stop. @param {() => void} fn */
    onRowChange: (fn) => registry.onChange(fn),
    /**
     * Install the Host on `destination`, pair with it and check it answers. The result says which step failed and whether the app is paired; a machine that installed but did not pair stays in the list for the code to be pasted.
     * @param {string} destination
     * @param {{ daemonPassword?: string }} [opts] a Mac's administrator password, to start the Host at boot (install.cjs)
     * @returns {Promise<{ ok: boolean, paired: boolean, error: string, id: string, steps: any[], rolledBack?: boolean, publicKey?: string }>}
     */
    async add(destination, opts = {}) {
      refuseUnlessAllowed();
      const out = await installer.install(destination, (step) => onStep({ destination, step }), opts);
      if (!out.ok) return { ...out, paired: false }; // with its rolledBack and publicKey, for the card (shared/host/installFailure.mjs)
      try {
        await pair(out.id, out.pairingCode);
        return { ok: true, paired: true, error: '', id: out.id, steps: out.steps };
      } catch (e) {
        // the Host is installed and listed; the user can paste the code it prints
        return { ok: true, paired: false, error: userError(e), id: out.id, steps: out.steps };
      }
    },
    cancelAdd: (destination) => installer.cancel(destination),
    pair,
    check: async () => (refuseUnlessAllowed(), registry.check()), // ask every machine now: a row's Check again
    startHost: (id) => (refuseUnlessAllowed(), starter(id)), // the machine answers over ssh and its Host does not: start it there
    /** Sends this app's signed Host build and asks for an idle restart. Automatic updates recheck live status and the opt-in before uploading. @param {string} id */
    async updateHost(id, automatic = false) {
      refuseUnlessAllowed();
      updates.refuseNewer(registry.list().find((r) => r.id === id));
      return updates.run(
        id,
        (ownsUpdate) => updater.update(id, undefined, { ownsUpdate, automaticEnabled: automatic ? autoUpdate.enabled : undefined }),
        () => onChange(list()),
      );
    },
    /**
     * An authenticated connection to a paired machine, for a run of requests and the events it sends meanwhile; the tunnel is held until the session is closed.
     * @param {string} id @param {(event: Record<string, any>) => void} [onEvent]
     */
    async session(id, onEvent) {
      refuseUnlessAllowed();
      const record = registry.list().find((r) => r.id === id);
      if (!record) throw refusal('That machine is not in the list.', 'unknown_machine');
      return openPaired(record, onEvent);
    },
    boot,
    ...agents.actions,
    /** The name the machine is shown by, here and on every surface. @param {string} id @param {string} name */
    rename(id, name) {
      refuseUnlessAllowed();
      registry.rename(id, name);
    },
    /** Keep running after restart (startAtBoot.cjs): on or off with the machine's administrator password, or the command to run there. @param {string} id @param {boolean} on @param {string} password */
    setStartAtBoot: (id, on, password) => (refuseUnlessAllowed(), startAtBoot.set(id, on, password)),
    /** @param {string} id */
    startAtBootCommand: (id) => (refuseUnlessAllowed(), startAtBoot.command(id)),
    rotateKey: () => (refuseUnlessAllowed(), autoUpdate.whileHeld(() => updater.rotate())),
    removePlan: (id) => (refuseUnlessAllowed(), uninstaller.plan(id)),
    uninstallHost: (id, password) => (refuseUnlessAllowed(), uninstaller.uninstall(id, password)),
    /** @param {string} id */
    remove(id) {
      refuseUnlessAllowed();
      // before the record goes: the machine is asked to stop its sign-ins and installs through its record, and its connection ends once it was told
      const stopped = agents.forget(id);
      // a machine that signed in with MoPilot's key loses it with its record (best effort: an unreachable machine keeps the line)
      const record = registry.list().find((r) => r.id === id);
      if (record?.identity && keyAccess?.revoke)
        keyAccess.revoke(record.address, record.identity).catch((error) => noteIgnored('take MoPilot’s key off a removed machine', error));
      const open = hosts.get(id);
      // its relay credential goes (kept until the relay answers), and the Host is told while its connection is up
      if (record) viaRelay.forget(record, open?.host);
      hosts.delete(id); // a machine added again under this id gets a connection of its own
      forwards.closeMachine(id);
      updates.forget(id);
      autoUpdate.forget(id);
      registry.remove(id);
      onRemoved?.(id);
      const end = () => {
        if (!open) return;
        open.detach?.();
        open.host.dispose();
        onRemoteEnd?.(id);
      };
      if (!stopped) return end();
      void stopped.then(end);
    },
    dispose() {
      disposed = true;
      chatIndex.dispose();
      dropHosts();
      offChange();
      boot.dispose();
      autoUpdate.dispose();
      viaRelay.dispose();
      agents.dispose();
      registry.dispose();
      pool.closeAll?.(); // a lease the heartbeat or a pairing still holds would keep its ssh alive past the app
      started.stopAll(); // and so would a Bonjour browse, an install step or ssh-keygen still running
    },
  };
  return service;
}

module.exports = { createMachines, epochReader, requestOverSocket, ...ownershipReaders };
