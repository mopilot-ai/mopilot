// The ops commands: serve, status, login, update and install; each returns a process exit code.
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { createAcpRuntime } from './acp.mjs';
import { harnessList, reportedHarnesses } from './harnessList.mjs';
import { createSignedIn } from './signedIn.mjs';
import { createNoSignIn } from './noSignIn.mjs';
import { installElectronPorts } from './electronPorts.mjs';
import { createHostFs, hostFolders } from './hostFs.mjs';
import { auditFor, pairingAuditOf } from './auditWiring.mjs';
import { auditCommand } from './auditExport.mjs';
import { createHostDirs } from './hostDirs.mjs';
import { daemonInfo, dropAgentUnderDaemon, installUnit } from './install.mjs';
import { uninstallCommand } from './uninstallCommand.mjs';
import { loginShellPath, withDir } from './loginPath.mjs';
import { createPorts } from './ports.mjs';
import { createLogin } from './login.mjs';
import { createInstaller, hostPath } from './agentInstall.mjs';
import { createHostTools } from './tools.mjs';
import { createPairing } from './pairing.mjs';
import { homeGateFor } from './homeGate.mjs';
import { activeCli, createUpdater, hasUpdateKey, markHealthy, stageUpdate, updateFacts, updateKeysOf, writeUpdateKey } from './update.mjs';
import { createContinueWiring } from './continueWiring.mjs';
import { createHostBrowser } from './browserService.mjs';
import { createHostDesktop } from './desktopService.mjs';
import { createEpochStore } from './epochs.mjs';
import { createGuard } from './guard.mjs';
import { createLedger } from './ledger.mjs';
import { createHostImages } from './chatImages.mjs';
import { createProtocol } from './protocol.mjs';
import { createOwnerRules } from './ownerRules.mjs';
import { hostSchedulesFor } from './schedules.mjs';
import { scheduleRules } from '../../shared/schedule.mjs';
import rrule from 'rrule';
import { relayWithPush } from './pushWiring.mjs';
import { createMomoHidden, momoHomeFor, momoRunsFor } from './momoWiring.mjs';
import { enroll } from './relayEnroll.mjs';
import { enrollCommand } from './enrollCommand.mjs';
import { createClaudeFamily } from './claudeFamily.mjs';
import { createCredentialLeases } from './credentialLease.mjs';
import { createOwnCredentials } from './ownCredentials.mjs';
import { createOrgKeyHelper } from './orgKeyHelper.mjs';
import { createOpener } from './opener.mjs';
import { createRecovery } from './recovery.mjs';
import { createCodexFamily } from './codexFamily.mjs';
import { createHostCommands, codexSkills } from './hostCommands.mjs';
import { createHostSessions } from './sessions.mjs';
import { refuseWhenStopping } from './stopGate.mjs';
import { endTurnsAtStop } from './stopTurns.mjs';
import { askHost, callHost, startServer } from './server.mjs';
import { hostStatus, hostCapabilities, coreProblem } from './status.mjs';
import { createCloudIdle } from './cloudIdle.mjs';
import { loginCommand } from './cliLogin.mjs';
import { createGitSignInCheck, gitFailFastEnv, withGitSignIn } from './gitSignIn.mjs';
import { createLocalNetworkCheck } from './localNetwork.mjs';
import { createStartupCheck } from './startup.mjs';
import { DAEMON_PLIST } from '../../shared/host/launchDaemon.mjs';
const USAGE =
  'Usage: mopilot-host <serve|status|login <harness>|update|trust-update-key|install|uninstall|pair|enroll|audit export> [--data-dir <dir>]';
/** @param {string[]} argv */
function parse(argv) {
  const rest = [...argv];
  let dataDir;
  const i = rest.indexOf('--data-dir');
  if (i >= 0) {
    dataDir = rest.splice(i, 2)[1];
    if (!dataDir || dataDir.startsWith('--')) return { command: 'usage', dataDir: undefined };
  }
  let methodId;
  const m = rest.indexOf('--method');
  if (m >= 0) {
    methodId = rest.splice(m, 2)[1];
    if (!methodId || methodId.startsWith('--')) return { command: 'usage', dataDir: undefined };
  }
  let manifest;
  const f = rest.indexOf('--manifest');
  if (f >= 0) {
    manifest = rest.splice(f, 2)[1];
    if (!manifest || manifest.startsWith('--')) return { command: 'usage', dataDir: undefined };
  }
  return { command: rest[0], dataDir, harness: rest[1], methodId, manifest };
}
/**
 * @param {string[]} argv
 * @param {{ out?: (line: string) => void, err?: (line: string) => void, env?: NodeJS.ProcessEnv, signals?: NodeJS.Process, home?: string, platform?: NodeJS.Platform, pollMs?: number, delegated?: string | false, spawnFn?: typeof spawn, fetchFn?: typeof fetch, updatePollMs?: number, stopService?: (command: { bin: string, args: string[] }) => void, stdin?: (NodeJS.ReadableStream & { isTTY?: boolean }) | null, joinRelay?: typeof enroll, coreProblemHere?: () => string | null, coreLoads?: (addon: string) => string, localNetwork?: () => Promise<import('./localNetwork.mjs').LocalNetwork>, startup?: () => Promise<import('./startup.mjs').Startup>, daemonPlist?: string, makeDesktop?: typeof createHostDesktop, momoOverrides?: { quirks?: (id: string) => any, ready?: (momo: any) => unknown } }} [io]
 * @returns {Promise<number>}
 */
export async function main(
  argv,
  {
    out = (l) => process.stdout.write(`${l}\n`),
    err = (l) => process.stderr.write(`${l}\n`),
    env = process.env,
    signals = process,
    pollMs = 1000,
    home,
    platform,
    delegated = false,
    spawnFn = spawn,
    fetchFn = fetch,
    updatePollMs,
    // the service is stopped with the system's own tool; a service that is not running is not an error
    stopService = ({ bin, args }) => void spawnSync(bin, args, { stdio: 'ignore' }),
    stdin = null,
    // joining the user's app through the relay (relayEnroll.mjs); a test brings its own
    joinRelay = enroll,
    // whether this Host may reach the local network (localNetwork.mjs), asked with each status; only a service launchd started is held to it
    localNetwork = createLocalNetworkCheck({ supervised: Boolean(env.MOPILOT_HOST_SUPERVISED) }),
    // whether this Host starts at boot (startup.mjs), asked with each status
    startup = createStartupCheck({ platform, env }),
    // where a Mac's system daemon plist would be (shared/host/launchDaemon.mjs); a test brings its own
    daemonPlist = DAEMON_PLIST,
    // the Host's own desktop (desktopService.mjs); a test brings its own
    makeDesktop = createHostDesktop,
    coreProblemHere = coreProblem,
    coreLoads,
    // what a test entry gives MoMo's home beyond the shipped Host's own: never read from the environment or a file; `ready(momo)` runs once the home is served
    momoOverrides = {},
  } = {},
) {
  const { command, dataDir, harness, methodId, manifest } = parse(argv);
  const ports = createPorts({ dataDir, env, print: err });
  const { paths } = ports;
  switch (command) {
    case 'serve': {
      // a version `update` staged runs in place of the code this process started from
      const active = delegated ? null : activeCli(paths.dataDir);
      if (active)
        return (await import(pathToFileURL(active.cli).href)).main(argv, {
          out,
          err,
          env,
          signals,
          delegated: active.version,
          spawnFn,
          updatePollMs,
        });
      // nothing here runs without the core: the service stops, and `status` and the app's install say why
      const problem = coreProblemHere();
      if (problem) {
        err(problem);
        return 1;
      }
      // listen for the stop signals first, so one that arrives during startup still runs the cleanup below
      /** @type {(why: 'signal' | 'restart') => void} */
      let stop = /** @type {any} */ (null);
      let stopping = false;
      const stopped = new Promise((resolve) => {
        stop = (/** @type {'signal' | 'restart'} */ why) => ((stopping = true), resolve(why));
        for (const sig of /** @type {const} */ (['SIGINT', 'SIGTERM'])) signals.once(sig, () => stop('signal'));
      });
      // an agent this Host installed is found, by every harness and the status, as soon as its install ends
      env.PATH = hostPath(env.PATH, paths.dataDir);
      const restorePorts = installElectronPorts(ports);
      // nothing the Host starts opens a page on this machine's screen: the opener records it for the app (./opener.mjs)
      const opener = createOpener({ dataDir: paths.dataDir });
      // every agent's git prompts for nothing and, with no sign-in, fails with one line saying so (./gitSignIn.mjs)
      const hostEnv = { ...opener.env(env), ...gitFailFastEnv(paths.dataDir, env, platform) };
      // every child the harnesses start is recorded, so a Host killed hard does not leave them running (the next one ends them)
      const recovery = createRecovery({ dataDir: paths.dataDir, report: err });
      const restoreProc = recovery.install();
      // started at boot by the system daemon: a user agent left from before would start a second Host at the next sign-in
      dropAgentUnderDaemon({ platform, home, env });
      const signedIn = createSignedIn(paths.dataDir);
      const noSignIn = createNoSignIn({ env: hostEnv, quirksOf: momoOverrides.quirks });
      const momoHidden = createMomoHidden();
      const audit = auditFor({ dataDir: paths.dataDir, report: err, policy: () => policy });
      audit.redactWith(momoHidden.redact);
      const tools = createHostTools({ intents: recovery.intents, audit });
      // the model keys and organization leases the app lends, in memory only (./credentialLease.mjs)
      const leases = createCredentialLeases(undefined, audit);
      // the chats scheduled runs start on the Host's own sign-in (./ownCredentials.mjs)
      const ownRuns = createOwnCredentials({
        leases,
        dataDir: paths.dataDir,
        status: harnessList.bind(null, { paths, env: hostEnv, signedIn, noSignIn }),
      });
      const runtime = createAcpRuntime({
        paths,
        env: hostEnv,
        signedIn,
        hostOptions: { tools: tools.mcp, ...(momoOverrides.quirks && { quirks: momoOverrides.quirks }) },
        leases,
      });
      // Claude Code asks for an organization lease's token through its key helper, over a socket in the Host's own folder (./orgKeyHelper.mjs)
      const orgKey = createOrgKeyHelper({ dir: path.dirname(paths.socketPath), leaseOf: leases.orgLease });
      const codex = createCodexFamily({ env: hostEnv, tools, leases, credentials: ownRuns.chatCredentials });
      const claude = createClaudeFamily({ tools, leases, orgKey, ownRuns });
      // the owner's rules and the spend counter exist before the chats do: a limit holds a chat's next waiting message (./ownerRules.mjs)
      const { policy, spend, attach, managedFile } = createOwnerRules({ dataDir: paths.dataDir, report: err, audit });
      const sessions = createHostSessions({
        paths,
        env: hostEnv,
        runtime,
        families: { claude, codex },
        ownRuns,
        report: err,
        log: err,
        ceiling: policy.ceiling,
      });
      attach({ sessions, leases });
      const gitSignInCheck = createGitSignInCheck();
      const login = createLogin({ runtime, signedIn, families: [codex, claude], env: hostEnv, opened: opener, gitSignInCheck });
      const installer = createInstaller({ dataDir: paths.dataDir, env: hostEnv });
      // the models an installed, signed-in Codex or Claude Code offers ride on its entry; a missing agent this Host can install says so (`installable`), so the app can offer them
      const harnesses = () => reportedHarnesses({ paths, env: hostEnv, signedIn, noSignIn, installer, codex, sessions, leases, ownRuns });
      const pairing = createPairing({
        configDir: paths.configDir,
        onSeen: (fingerprint) => updateKeysOf(paths.configDir).markSeen(fingerprint),
        audit: pairingAuditOf(audit),
      });
      const updater = createUpdater({
        dataDir: paths.dataDir,
        idle: () => runtime.idle() && sessions.idle() && login.idle() && installer.idle(),
        // the caller that asked is answered first: stopping at once would close its connection before the reply is written
        restart: () => setImmediate(() => stop('restart')),
        pollMs: updatePollMs,
      });
      const roots = policy.roots() ?? (env.MOPILOT_HOST_ROOTS ? env.MOPILOT_HOST_ROOTS.split(path.delimiter).filter(Boolean) : undefined);
      const hostFs = createHostFs({ roots, denied: hostFolders(paths) });
      const epochs = createEpochStore(path.join(paths.dataDir, 'epochs.json'), { report: err });
      const ledger = createLedger(path.join(paths.dataDir, 'ledger'), { report: err });
      // clone and worktree keys are kept in the ledger too, so a repeat after a restart gets the first request's answer
      const dirs = createHostDirs({ hostFs, ledger });
      const {
        continueHost,
        target,
        close: closeContinue,
      } = createContinueWiring({
        dataDir: paths.dataDir,
        runtime,
        hostFs,
        families: { chats: sessions.chatRuntime, harnesses },
        epochs,
        ledger,
        report: err,
      });
      const browser = createHostBrowser({ dataDir: paths.dataDir, env, epochs, intents: recovery.intents, hostFs });
      const desktop = makeDesktop({ dataDir: paths.dataDir, env, epochs, platform, intents: recovery.intents });
      const { relayLinks, approvalPush } = relayWithPush({ configDir: paths.configDir, socketPath: paths.socketPath, policy, report: err });
      managedFile.onChange((s) => audit.note({ kind: 'policy.changed', what: { generation: s.generation ?? 'none' } }));
      const hostId = pairing.hostId();
      const { ready: momoReady, ...momoParts } = momoOverrides;
      const momo = momoHomeFor({ paths, report: err, sessions, epochs, env, hidden: momoHidden, tools, harnesses, hostId }, momoParts);
      const homeGate = homeGateFor({ paths, pairing, sessions, epochs, policy, audit, report: err });
      const protocol = createProtocol({
        policy,
        audit,
        hostFs,
        spend,
        dataDir: paths.dataDir,
        report: err,
        images: createHostImages({ dir: path.join(paths.dataDir, 'images') }),
        knownClients: pairing.fingerprints,
        homeGate,
        journal: recovery.journal,
        runtime: refuseWhenStopping(sessions.chatRuntime, () => stopping),
        existingFolder: hostFs.existingDirectory,
        commands: createHostCommands({ claude: claude.catalog, codex: codexSkills(codex, hostEnv.HOME), report: err }),
        epochs,
        browser: browser.protocol,
        desktop: desktop.protocol,
        guard: createGuard({ epochs, ledger }),
        continueHost,
        capabilities: () => hostCapabilities({ browser: browser.available(), desktop: desktop.available() }),
        handoffs: target,
        status: async (params) =>
          withGitSignIn(
            hostStatus({
              policy: policy.status(),
              spend: spend.status(),
              cloud: cloudIdle.status(),
              push: approvalPush.state(),
              running: true,
              runningVersion: delegated || undefined,
              harnesses: await harnesses(),
              browser: browser.available(),
              desktop: desktop.available(),
              ...updateFacts(paths),
              localNetwork: await localNetwork(),
              startup: await startup(),
            }),
            params ?? {},
            gitSignInCheck,
          ),
        login,
        installer,
        tools: tools.relay,
        leases,
        ownRuns,
        relay: relayLinks,
        momo,
        ...approvalPush.options,
        notify: momoHidden.notify(approvalPush.options.notify, approvalPush.momoNotify(momo)),
      });
      attach({ protocol });
      // the scheduled tasks this Host fires itself, started through the protocol (./schedules.mjs)
      const schedules = hostSchedulesFor({
        dataDir: paths.dataDir,
        rules: scheduleRules(rrule.RRule),
        protocol,
        harnesses,
        state: sessions.state,
        report: err,
        audit,
      });
      protocol.keepSchedules(schedules);
      momoRunsFor(momo, { approvalPush, protocol, events: sessions.chatRuntime.host, state: sessions.state, harnesses, report: err });
      await momoReady?.(momo);
      // a cloud machine's Host stops its own machine when idle (the policy's `cloud` block, which only the app's document for one carries)
      const cloudIdle = createCloudIdle({
        dataDir: paths.dataDir,
        config: () => policy.effective().doc.cloud,
        busy: sessions.busy,
        nextScheduleAt: schedules.nextAt,
        flush: runtime.drain,
        report: err,
      });
      /** @type {Awaited<ReturnType<typeof startServer>>} */
      let server;
      try {
        server = await startServer({
          paths,
          runtime: momoHidden.guard(runtime),
          login,
          updater,
          pairing,
          homeGate,
          runningVersion: delegated || undefined,
          dirs,
          protocol,
          harnesses,
          updateKey: hasUpdateKey(paths.configDir),
          afterLock: () => recovery.run(protocol).then(() => homeGate.sweep(pairing.stillKnows, protocol)),
          onActivity: cloudIdle.touch,
        });
      } catch (e) {
        // another Host holds the data dir: nothing of this one stays installed
        updater.close();
        login.close();
        installer.close();
        closeContinue();
        sessions.close();
        runtime.close();
        tools.close();
        orgKey.close();
        await desktop.dispose();
        restoreProc();
        restorePorts();
        throw e;
      }
      out(`Host serving on ${paths.socketPath}`);
      // the desktop's readings start once this Host holds the data dir: a Host that was refused it starts no helper
      desktop.start();
      relayLinks.start();
      // due times are checked once the Host serves: a run's chat is there for an app to follow
      const stopSchedules = schedules.start();
      void momo.scheduler?.start();
      const stopCloudIdle = cloudIdle.start();
      // until a client is paired, each start prints a fresh one-time code (only its hash is kept)
      if (pairing.paired() === 0) out(`Pairing code: ${pairing.issueCode()}`);
      if (delegated) markHealthy(paths.dataDir);
      const why = await stopped;
      endTurnsAtStop({ journal: recovery.journal, protocol, report: err }); // running turns end as interrupted by this stop, then their children (./stopTurns.mjs)
      stopSchedules();
      momo.scheduler?.stop();
      stopCloudIdle();
      managedFile.stop();
      relayLinks.close();
      approvalPush.close();
      updater.close();
      login.close();
      installer.close();
      closeContinue();
      sessions.close();
      runtime.close();
      await runtime.drain();
      await recovery.children.endAll(); // a child that will not leave would keep this process alive minutes after the socket is gone
      tools.close();
      orgKey.close();
      browser.dispose();
      await desktop.dispose();
      await server.close();
      restoreProc();
      restorePorts();
      // the lock and socket are free: the staged version takes over in a new process
      // under a supervisor (the unit `install` writes) it restarts the Host itself; a second copy would only fight it for the lock
      if (why === 'restart' && !env.MOPILOT_HOST_SUPERVISED)
        spawnFn(process.execPath, [fileURLToPath(new URL('../bin/mopilot-host.mjs', import.meta.url)), ...argv], {
          detached: true,
          stdio: 'ignore',
        }).unref();
      return 0;
    }
    case 'status': {
      const live = await askHost(paths.socketPath, 'status');
      // the socket path is how a client reaches this Host through an SSH tunnel; the Host's own data dir decides it
      const offline = live
        ? null
        : hostStatus({
            running: false,
            harnesses: await harnessList({
              paths,
              env,
              signedIn: createSignedIn(paths.dataDir),
              noSignIn: createNoSignIn({ env, quirksOf: momoOverrides.quirks }),
            }),
            ...updateFacts(paths),
          });
      out(JSON.stringify({ ...(live ?? offline), socketPath: paths.socketPath }));
      return 0;
    }
    case 'login':
      return loginCommand({ paths, harness, methodId, out, err, signals, stdin, ports, pollMs, usage: USAGE });
    case 'update': {
      if (!manifest) {
        err('Usage: mopilot-host update --manifest <https url or file> [--data-dir <dir>]');
        return 1;
      }
      try {
        const keyStore = updateKeysOf(paths.configDir);
        const staged = await stageUpdate({
          source: manifest,
          dataDir: paths.dataDir,
          fetchFn,
          keys: keyStore.entries(),
          keyStore,
          hostId: createPairing({ configDir: paths.configDir }).hostId(),
          coreLoads,
        });
        out(staged.staged ? `Staged version ${staged.version}.` : `Version ${staged.version} was already here.`);
      } catch (e) {
        err(e instanceof Error ? e.message : String(e));
        return 1;
      }
      const asked = await callHost(paths.socketPath, 'update');
      if (!asked) out('No Host is running; the new version starts with the next `serve`.');
      else if (asked.result?.state === 'restarting') out('The Host is idle and restarts now.');
      else out('The Host restarts into it as soon as it is idle.');
      return 0;
    }
    case 'trust-update-key': {
      // the public key (PEM) on standard input becomes the key that signs this Host's updates: the app gives it at install
      try {
        if (!stdin) throw new Error('Give the public key (PEM) on standard input.');
        const chunks = [];
        for await (const chunk of stdin) chunks.push(Buffer.from(chunk));
        writeUpdateKey(paths.configDir, Buffer.concat(chunks).toString('utf8'));
      } catch (e) {
        err(e instanceof Error ? e.message : String(e));
        return 1;
      }
      out('Update key kept.');
      return 0;
    }
    case 'install': {
      // the service gets the login shell's PATH (agents in Homebrew, nvm, ~/.local/bin) and the Node the Host runs on, which nothing else may have on PATH
      const unitEnv = { ...env, PATH: withDir(loginShellPath({ env }), path.dirname(process.execPath)) };
      const binPath = fileURLToPath(new URL('../bin/mopilot-host.mjs', import.meta.url));
      // what a Mac's daemon needs to start this Host at boot (shared/host/launchDaemon.mjs); the app renders the plist from it
      if (argv.includes('--print-daemon')) {
        out(JSON.stringify(daemonInfo({ home, env: unitEnv, nodePath: process.execPath, binPath, dataDir: paths.dataDir })));
        return 0;
      }
      const { file, start, daemon } = installUnit({
        daemonPlist,
        home,
        env: unitEnv,
        platform,
        nodePath: process.execPath,
        binPath,
        dataDir: paths.dataDir,
      });
      out(daemon ? `Starts at boot from ${file}\nRestart it with: ${start}` : `Wrote ${file}\nStart it with: ${start}`);
      return 0;
    }
    case 'pair': {
      out(`Pairing code: ${createPairing({ configDir: paths.configDir }).issueCode()}`);
      return 0;
    }
    case 'audit':
      return auditCommand({ dataDir: paths.dataDir, argv, out, err });
    case 'enroll':
      return enrollCommand({ paths, stdin, joinRelay, out, err });
    case 'uninstall':
      return uninstallCommand({
        argv,
        unit: {
          home,
          env,
          platform,
          nodePath: process.execPath,
          binPath: fileURLToPath(new URL('../bin/mopilot-host.mjs', import.meta.url)),
          dataDir: paths.dataDir,
        },
        configDir: paths.configDir,
        platform,
        daemonPlist,
        stopService,
        out,
        err,
      });
    default:
      err(USAGE);
      return 1;
  }
}
