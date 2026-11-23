// Adding a machine: the steps that install, start and check the Host over SSH, each reported with its output, rolled back (the unit uninstalled) when one fails, and safe to run again on the same machine.
const crypto = require('node:crypto');
const { userError } = require('../../shared/userError.mjs');
const { noteIgnored } = require('../ignored.cjs');
const { clock } = require('../platform/ports/clock.cjs');
const { fs } = require('../platform/ports/fs.cjs');
const { validSocketPath } = require('./hostReported.cjs');
const { computerNameOf, addressName } = require('../../shared/host/computerName.mjs');
const { createSshChannel } = require('./sshChannel.cjs');
const { changedHostKey } = require('./sshPrompt.cjs');
const { keySignIn } = require('./sshKey.cjs');
const { createSteps } = require('./installSteps.cjs');
const { setUpNode } = require('./installRuntime.cjs');
const {
  HOST_HOME,
  BUNDLE_BIN,
  HOST_RUN_NODE,
  HOST_CLI,
  startCommand,
  rollbackCommand,
  bundleCommands,
  LINGER_ON,
  LINGER_UNDO,
} = require('./installCommands.cjs');
const { isLocal, LOCAL_ID, LOCAL_NAME } = require('./localHost.cjs');
const { quote, turnOn } = require('./daemonInstall.cjs');
const { parseSshAddress, normalAddress } = require('../../shared/host/sshDestination.mjs');
const { coreBuildOf, coreProbeCommand, noCoreBuild, notAsked } = require('../../shared/host/coreBuild.mjs');

/** The Host needs this Node major version on the machine when it is installed from an npm package (host/package.json engines). */
const NODE_MAJOR = 22;
const STATUS_TRIES = 5;
const STATUS_WAIT_MS = 1000;

/** `user@host`, `host`, `host:port` (as `parseSshAddress` normalizes them) or a ssh_config alias: no whitespace, and never a leading dash that ssh would read as an option. @param {unknown} d */
const validDestination = (d) =>
  typeof d === 'string' && (isLocal(d) ? /^local:[A-Za-z0-9_][A-Za-z0-9_.%+-]*$/.test(d) : parseSshAddress(d)?.destination === d);

/** @param {string} s */

/** @typedef {{ id: string, label: string, state: 'running' | 'ok' | 'failed' | 'skipped', output: string, index?: number, total?: number, progress?: { done: number, total: number }, stalled?: boolean, notice?: string }} Step `index` of `total`: which of the six phases the step belongs to; `progress`: bytes of an upload; `stalled`: nothing moved for 30 s; `notice`: what MoPilot is about to do on its own */
/** @typedef {{ ok: boolean, id: string, destination: string, status: any, pairingCode?: string, steps: Step[], failedStep: string | null, error: string, rolledBack: boolean, cancelled?: boolean, publicKey?: string }} InstallResult `publicKey` this Mac's MoPilot key, when the machine takes keys only and none of this Mac's is authorized on it */

/** Why a command failed: a changed host key in words (ssh refused to connect; nothing was sent), else what it printed. @param {{ code: number, stdout: string, stderr: string }} r */
const failureText = (r) => {
  if (!changedHostKey(r.stderr)) return shown(r) || 'The command failed.';
  const now = /key sent by the remote host is\s+(SHA256:[A-Za-z0-9+/=]+)/.exec(r.stderr)?.[1];
  return `This machine's host key changed since you last connected. If it wasn't reinstalled, someone may be intercepting the connection, so MoPilot did not connect.${now ? `\nFingerprint now: ${now}` : ''}`;
};

/** The text a step shows: what the command printed, or why it failed. @param {{ code: number, stdout: string, stderr: string }} r */
const shown = (r) => [r.stdout.trim(), r.stderr.trim()].filter(Boolean).join('\n');

/** Whether ssh was refused by a machine that takes keys only: its list of accepted methods names neither a password nor keyboard-interactive. @param {string} text */
function keyOnly(text) {
  const methods = /Permission denied \(([^)]*)\)/.exec(text)?.[1];
  return methods !== undefined && !/password|keyboard-interactive/.test(methods);
}

/**
 * @param {object} o
 * @param {(destination: string, command: string, input?: Buffer, control?: { signal?: AbortSignal, onBytes?: (done: number, total: number) => void }) => Promise<{ code: number, stdout: string, stderr: string }>} o.channel one command on a machine, with bytes for its standard input, a signal that ends it and a listener for the bytes sent (createSshChannel, or a fake)
 * @param {{ add: (h: any) => unknown } | null} [o.registry] where a machine that is up is recorded
 * @param {((build: string) => { file: string, sha256: string, version: string, core?: string | null } | Promise<{ file: string, sha256: string, version: string, core?: string | null }>) | null} [o.bundle] the Host tarball to upload for a machine's core build (electron/host/bundle.cjs builds it)
 * @param {string} [o.packageSpec] an npm package to install on the machine instead of uploading the tarball (for a Host published somewhere)
 * @param {(() => string) | null} [o.updateKey] this app's public key (base64 SPKI): the machine keeps it as the key its updates are signed by, so it takes an update from this app only
 * @param {Parameters<typeof setUpNode>[0]['cache']} [o.runtime] this Mac's copy of the Node builds a Host runs on (nodeRuntime.cjs); without it the machine downloads Node itself
 * @param {{ probe: (destination: string, args: string[]) => Promise<{ code: number, stdout: string, stderr: string }>, ensure: () => Promise<{ file: string, pub: string }>, consent: (destination: string, file: string) => Promise<boolean>, revoke?: (destination: string, identity: string) => Promise<boolean> } | null} [o.keyAccess] makes a machine reachable without a password (sshKey.cjs); without it the step is skipped
 */
function createInstaller({
  channel,
  registry = null,
  bundle = null,
  packageSpec = '',
  updateKey = null,
  runtime = null,
  keyAccess = null,
}) {
  /** One install per machine at a time: a second request for it joins the run in flight. @type {Map<string, { steps: Step[], listeners: Set<(s: Step) => void>, done: Promise<InstallResult>, abort: AbortController, cancelled: boolean, timer: any }>} */
  const runs = new Map();

  /**
   * @param {string} destination @param {{ steps: Step[], listeners: Set<(s: Step) => void>, abort: AbortController, cancelled: boolean, timer: any }} entry
   * @param {{ daemonPassword?: string }} opts `daemonPassword`: a Mac's administrator password, to start the Host as the system daemon (Keep running after restart) instead of the user's agent, which a Mac nobody is signed in on refuses
   * @returns {Promise<InstallResult>}
   */
  async function run(destination, entry, { daemonPassword } = {}) {
    const { steps } = entry;
    const id = isLocal(destination) ? LOCAL_ID : `ssh:${destination}`;
    const { begin, end, active, control, cancelled, rollback } = createSteps(entry);
    /** Run one command as one step; returns its result, or null when it failed. @param {string} stepId @param {string} label @param {string} command @param {(r: any) => string} [check] a reason this output still fails the step @param {(r: any) => string} [display] what the card shows when it passes @param {Buffer} [input] bytes for the command's standard input */
    const runStep = async (stepId, label, command, check = () => '', display = shown, input = undefined) => {
      const step = begin(stepId, label);
      let r;
      try {
        r = cancelled()
          ? { code: -1, stdout: '', stderr: 'Cancelled.' }
          : await channel(destination, command, input, control(input && step));
      } catch (e) {
        r = { code: -1, stdout: '', stderr: /** @type {Error} */ (e).message };
      }
      const bad = r.code === 0 ? check(r) : failureText(r);
      end(step, bad ? 'failed' : 'ok', bad || display(r));
      return bad ? null : r;
    };
    /** @param {string} failedStep @param {string} error @param {boolean} rolledBack @returns {InstallResult} */
    const failure = (failedStep, error, rolledBack) => ({
      ok: false,
      id,
      destination,
      status: null,
      steps,
      failedStep,
      error,
      rolledBack,
      ...(entry.cancelled && { cancelled: true }),
    });

    /** The tarball to upload, built and read here: a step of its own, since a build can fail before any ssh. @returns {Promise<{ sha256: string, version: string, bytes: Buffer } | null>} */
    const prepareBundle = async () => {
      const step = begin('prepare', 'Prepare the Host');
      try {
        if (!bundle) throw new Error('This app has no Host package to upload.');
        // asked of the Node just set up, the one that will load the addon; nothing of the machine's Host has changed yet
        const asked = await tryRun(coreProbeCommand(HOST_RUN_NODE));
        if (asked.code !== 0) throw new Error(notAsked(failureText(asked)));
        const build = coreBuildOf(asked.stdout);
        if (!build) throw new Error(noCoreBuild(asked.stdout));
        const { file, sha256, version, core } = await bundle(build);
        const bytes = fs.readFileSync(file);
        // the archive on disk is the one its manifest names
        if (crypto.createHash('sha256').update(bytes).digest('hex') !== sha256)
          throw new Error('The Host package on this Mac does not match its checksum.');
        end(step, 'ok', `Host ${version} for ${core}`);
        return { sha256, version, bytes };
      } catch (e) {
        end(step, 'failed', userError(e));
        return null;
      }
    };

    /** One command whose failure to run is a result, for a step made of several. @param {string} command @param {Buffer} [input] */
    const tryRun = async (command, input) => {
      if (cancelled()) return { code: -1, stdout: '', stderr: 'Cancelled.' };
      try {
        return await channel(destination, command, input, control(input ? active() : undefined));
      } catch (e) {
        return { code: -1, stdout: '', stderr: /** @type {Error} */ (e).message };
      }
    };
    /** The Node step for an uploaded Host, as one step line. @param {string} uname @returns {Promise<boolean>} */
    const setUpNodeStep = async (uname) => {
      const step = begin('node', 'Set up Node');
      const out = await setUpNode({ uname, cache: runtime, run: tryRun });
      end(step, out.ok ? 'ok' : 'failed', out.output);
      return out.ok;
    };

    const reached = await runStep('connect', 'Connect', 'uname -sm', (r) =>
      /^(Linux|Darwin)\s/.test(r.stdout.trim())
        ? ''
        : `${r.stdout.trim() || 'Unknown system'}: only Linux and macOS machines are supported.`,
    );
    if (!reached) {
      const refused = failure('connect', /** @type {Step} */ (steps[0]).output, false);
      // a machine that only takes keys: the card shows this Mac's public key to authorize on it. The key is made on this Mac only (nothing is added to any machine), and the card says where it is; adding it to a machine is the person's own paste
      if (keyOnly(refused.error) && keyAccess)
        refused.publicKey = await keyAccess.ensure().then(
          (k) => k.pub,
          () => undefined,
        );
      return refused;
    }
    const os = reached.stdout.trim().split(/\s/)[0];
    // the tunnel and heartbeat reconnect with nobody there to type a password: a machine that took one gets MoPilot's key now, before anything is installed
    let identity = '';
    if (keyAccess && !isLocal(destination)) {
      const step = begin('key', 'Set up key sign-in');
      const out = await keySignIn({
        run: tryRun,
        probe: (args) => keyAccess.probe(destination, args),
        ensure: keyAccess.ensure,
        // nothing is made or added until the person says yes, in the card
        consent: (file) => keyAccess.consent(destination, file),
      });
      end(step, out.ok ? 'ok' : 'failed', out.output);
      if (!out.ok) return failure('key', out.output, false);
      identity = out.identity;
    }
    // the Host runs from the uploaded tarball's `current`, or, with an npm package named, from the machine's PATH
    const uploading = !packageSpec;
    const cli = uploading ? HOST_CLI : 'mopilot-host';

    // a Host already there stays when this run fails: it is not ours to remove. Its files say so, not whether it answers: a Host
    // installed before the app brought its own Node cannot be run until that Node is there
    const isThere = (/** @type {{ stdout: string }} */ r) => /^installed$/m.test(r.stdout);
    const before = await runStep(
      'detect',
      'Look for an existing Host',
      uploading
        ? `if test -f "${BUNDLE_BIN}"; then echo installed; ${cli} status 2>&1 || true; fi`
        : `if command -v mopilot-host >/dev/null; then echo installed; ${cli} status 2>&1 || true; fi`,
      () => '',
      (r) => (isThere(r) ? 'A Host is already installed; it stays if this fails.' : 'No Host on this machine yet.'),
    );
    const existed = Boolean(before && isThere(before));

    /** What this run put on the machine, for the rollback to take off again. @type {{ sha: string, made: boolean, prev: string } | null} */
    let placed = null;
    /** Whether this run made the Host root's daemon. */
    let daemonOn = false;
    let daemonMayExist = false;
    /** @param {string} stepId */
    const fail = async (stepId) => {
      rollback(); // what is undone now must not be stopped by the cancel that asked for it
      const error = /** @type {Step} */ (steps.find((s) => s.id === stepId)).output;
      // before anything was written to the machine's services, there is nothing to undo; a file that arrived but did not verify is removed
      if (['node', 'package', 'prepare', 'upload', 'verify', 'unpack'].includes(stepId)) {
        if (placed === null && uploading && ['upload', 'verify'].includes(stepId) && pending)
          await quiet(`rm -f "${bundleCommands(pending).file}"`);
        return failure(stepId, error, false);
      }
      // a Host now running, or perhaps running, as root's daemon stays as it is: only an administrator can take that off, and its files must survive
      if (daemonOn || daemonMayExist) return failure(stepId, error, false);
      if (existed) {
        // the Host that was here runs again on the version it had: `current` and the service moved with this run
        if (!placed?.prev) return failure(stepId, error, false);
        const back = await runStep(
          'rollback',
          'Put the Host back',
          `${bundleCommands(placed.sha).undo(placed.made, placed.prev)}; ${startCommand(os)}`,
        );
        return failure(stepId, error, back !== null);
      }
      const undone = await runStep(
        'rollback',
        'Undo the install',
        rollbackCommand(os, cli, placed ? bundleCommands(placed.sha).undo(placed.made, placed.prev) : ''),
      );
      return failure(stepId, error, undone !== null);
    };
    /** The sha of a tarball whose upload started, until it is unpacked. @type {string} */
    let pending = '';
    /** A command whose result is not shown. @param {string} command */
    const quiet = async (command) => {
      try {
        await channel(destination, command);
      } catch (e) {
        // the install already failed; this only tidies
        noteIgnored('tidy a failed install', e);
      }
    };

    // the uploaded Host brings its own Node, so nothing has to be installed on the machine or be on its ssh PATH first
    const node = uploading
      ? await setUpNodeStep(reached.stdout)
      : await runStep('node', 'Check Node', 'node --version', (r) => {
          const major = Number(/^v(\d+)\./.exec(r.stdout.trim())?.[1]);
          return major >= NODE_MAJOR
            ? ''
            : `Node ${NODE_MAJOR} or newer is needed on the machine (found ${r.stdout.trim() || 'none'}). Install it from https://nodejs.org and add the machine again.`;
        });
    if (!node) return fail('node');
    if (!uploading) {
      if (!(await runStep('package', 'Install the Host package', `npm install -g ${quote(packageSpec)}`))) return fail('package');
    } else {
      const ready = await prepareBundle();
      if (!ready) return fail('prepare');
      const cmd = bundleCommands(ready.sha256);
      pending = ready.sha256;
      if (
        !(await runStep(
          'upload',
          'Upload the Host',
          cmd.upload,
          () => '',
          () => `${ready.version}, ${Math.ceil(ready.bytes.length / 1024)} KB`,
          ready.bytes,
        ))
      )
        return fail('upload');
      if (
        !(await runStep(
          'verify',
          'Check the upload',
          cmd.verify,
          (r) => (r.stdout.trim() === ready.sha256 ? '' : 'The upload does not match its checksum.'),
          () => `SHA-256 ${ready.sha256.substring(0, 12)}…`,
        ))
      )
        return fail('verify');
      const unpacked = await runStep(
        'unpack',
        'Unpack the Host',
        cmd.unpack,
        (r) => (/made=(yes|no) prev=/.test(r.stdout) ? '' : 'The Host could not be unpacked.'),
        () => `${HOST_HOME.replace('$HOME', '~')}/current`,
      );
      if (!unpacked) return fail('unpack');
      // the step passed only because this matched
      const m = /** @type {RegExpExecArray} */ (/made=(yes|no) prev=(.*)/.exec(unpacked.stdout));
      placed = { sha: ready.sha256, made: m[1] === 'yes', prev: m[2].trim() };
      pending = '';
    }
    if (!(await runStep('unit', 'Write the service unit', `${cli} install`))) return fail('unit');
    if (updateKey) {
      const pem = crypto
        .createPublicKey({ key: Buffer.from(updateKey(), 'base64'), format: 'der', type: 'spki' })
        .export({ type: 'spki', format: 'pem' });
      if (
        !(await runStep(
          'trust',
          'Trust this app for updates',
          `${cli} trust-update-key`,
          () => '',
          () => 'Updates are taken from this app only.',
          Buffer.from(pem),
        ))
      )
        return fail('trust');
    }
    if (daemonPassword && os === 'Darwin') {
      // the root step and the agent's removal (daemonInstall.cjs); loading the daemon starts the Host on the files just installed
      const step = begin('daemon', 'Keep running after restart');
      try {
        await turnOn(tryRun, cli, daemonPassword);
        daemonOn = true;
        end(step, 'ok', 'Starts before anyone signs in.');
      } catch (e) {
        daemonMayExist = Boolean(/** @type {{ daemonMayExist?: boolean }} */ (e).daemonMayExist);
        end(step, 'failed', userError(e));
        return fail('daemon');
      }
    }
    if (daemonOn) {
      // restarting it would only make the status check below land in launchd's 5 s relaunch gap ("not running yet", seen in the VM)
      const step = begin('start', 'Start the Host');
      end(step, 'ok', 'Started by the system daemon.');
    } else if (!(await runStep('start', 'Start the Host', startCommand(os)))) return fail('start');
    if (os === 'Linux') {
      // a machine that will not let the Host linger still runs it while someone is signed in: said, never a failed install
      const step = begin('linger', 'Keep running after sign-out');
      const r = await tryRun(LINGER_ON);
      const said = r.stdout.trim();
      if (said === 'already' || said === 'turned-on') end(step, 'ok', 'Starts with the machine, before anyone signs in.');
      else end(step, 'skipped', 'Stops when you sign out. To fix, run on the machine: sudo loginctl enable-linger $USER');
    }

    /** @type {any} */
    let status = null;
    for (let i = 0; i < STATUS_TRIES && !status; i++) {
      if (i > 0) await new Promise((resolve) => clock.setTimeout(resolve, STATUS_WAIT_MS));
      // each try is its own step line only when it is the last
      const earlier = steps.filter((s) => s.id !== 'status');
      steps.splice(0, steps.length, ...earlier);
      const r = await runStep('status', 'Check the Host answers', `${cli} status`, (res) => {
        try {
          const parsed = JSON.parse(res.stdout);
          if (parsed?.core?.problem) return parsed.core.problem;
          if (!(parsed && parsed.running === true && Array.isArray(parsed.harnesses))) return 'The Host is installed but not running yet.';
          return validSocketPath(parsed.socketPath) ? '' : 'The Host did not say where it listens.';
        } catch {
          return 'The Host sent a status this app cannot read.';
        }
      });
      if (r) status = JSON.parse(r.stdout);
    }
    if (!status) return fail('status');

    // the code is a secret: the card shows that one was issued, and only the result carries it, for the caller to pair with at once
    const paired = await runStep(
      'pair',
      'Get a pairing code',
      `${cli} pair`,
      (r) => (/Pairing code: ([A-Z0-9-]+)/.test(r.stdout) ? '' : 'The Host printed no pairing code.'),
      () => 'A one-time pairing code was issued.',
    );
    if (!paired) return fail('pair');
    const pairingCode = /** @type {RegExpExecArray} */ (/Pairing code: ([A-Z0-9-]+)/.exec(paired.stdout))[1];

    if (registry) {
      registry.add({
        id,
        // this Mac keeps its own name; any other machine is named for the computer its Host just reported, and for the address typed only when an older Host says none (#4930)
        name: isLocal(destination) ? LOCAL_NAME : computerNameOf(status.computerName) || addressName(destination),
        ...(isLocal(destination) && { renamed: true }),
        address: destination,
        socketPath: status.socketPath,
        capabilities: status.capabilities,
        harnesses: status.harnesses,
        identity,
        startup: status.startup,
        platform: status.platform,
      });
    }
    return { ok: true, id, destination, status, pairingCode, steps, failedStep: null, error: '', rolledBack: false };
  }

  return {
    /** Stop the add under way for `destination` and undo what it made; false when none is running. @param {string} destination */
    cancel(destination) {
      const running = runs.get(normalAddress(destination));
      if (!running || running.cancelled) return false;
      running.cancelled = true;
      running.abort.abort();
      return true;
    },
    /**
     * Install and start the Host on `destination`; resolves with the whole outcome and never rejects for a failed step.
     * @param {string} destination
     * @param {(step: Step) => void} [onStep] called as each step starts and ends (the steps so far are replayed to a request that joins a run)
     * @param {{ daemonPassword?: string }} [opts] see `run`; a request that joins a run in flight runs it as that one was asked
     * @returns {Promise<InstallResult>}
     */
    install(destination, onStep = () => undefined, opts = {}) {
      if (typeof destination === 'string') destination = normalAddress(destination); // `host:2222` and `ssh://user@host:2222` are one machine with one id
      if (!validDestination(destination)) {
        return Promise.resolve({
          ok: false,
          id: '',
          destination: String(destination),
          status: null,
          steps: [],
          failedStep: 'connect',
          error: 'Enter a machine as user@host.',
          rolledBack: false,
        });
      }
      const running = runs.get(destination);
      if (running) {
        for (const s of running.steps) onStep({ ...s });
        running.listeners.add(onStep);
        return running.done;
      }
      /** @type {Step[]} */
      const steps = [];
      const listeners = new Set([onStep]);
      const entry = {
        steps,
        listeners,
        done: /** @type {Promise<InstallResult>} */ (/** @type {unknown} */ (null)),
        abort: new AbortController(),
        cancelled: false,
        timer: /** @type {any} */ (null),
      };
      entry.done = run(destination, entry, opts).finally(() => {
        clock.clearTimeout(entry.timer);
        runs.delete(destination);
      });
      runs.set(destination, entry);
      return entry.done;
    },
  };
}

module.exports = {
  createInstaller,
  createSshChannel,
  validDestination,
  bundleCommands,
  startCommand,
  BUNDLE_BIN,
  HOST_CLI,
  HOST_RUN_NODE,
  HOST_HOME,
  quote,
  LINGER_ON,
  LINGER_UNDO,
};
