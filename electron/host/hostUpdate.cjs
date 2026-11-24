// Updating a machine's Host from the app: the app signs a manifest for that Host (its name was kept at pairing) with the key the Host trusts, puts the archive and the manifest on the machine over ssh, and runs `mopilot-host update` there, which restarts the Host into it once idle.
const { fs } = require('../platform/ports/fs.cjs');
const { clock } = require('../platform/ports/clock.cjs');
const { noteIgnored } = require('../ignored.cjs');
const { userError } = require('../../shared/userError.mjs');
const { isJsonRecord } = require('../../shared/jsonRecord.mjs');
const { coreBuildOf, coreProbeCommand, noCoreBuild, notAsked } = require('../../shared/host/coreBuild.mjs');
const { HOST_CLI, HOST_RUN_NODE } = require('./install.cjs');
const { createKeyRotation } = require('./keyRotation.cjs');
const { UPDATE_DEFERRED, RESTART_UNCONFIRMED } = require('./updateStates.cjs');
const {
  READ_UPDATE_FLOOR,
  DEFERRED_EXIT,
  UNSUPPORTED_EXIT,
  RESTART_UNCONFIRMED_EXIT,
  readAutomaticFloor,
  stageAutomaticCommand,
} = require('./automaticUpdateCommands.cjs');

/** How long a signed manifest is good for: long enough to upload and run, short enough that a copy kept by anyone is useless soon. */
const VALID_MS = 60 * 60 * 1000;
const INCOMING = '$HOME/.mopilot-host/incoming';
/** How long the live status question may take. An automatic update requires a fresh answer. */
const STATUS_MS = 5000;
const deferUpdate = () => Object.assign(new Error('The Host is not ready for an automatic update.'), { code: UPDATE_DEFERRED });
const manualUpdateNeeded = () => new Error('This Host needs a manual update. Choose Try again on this machine’s row.');
const invalidatedUpdate = () =>
  Object.assign(new Error('The machine or signing key changed during the update. Check the machine and try again.'), {
    code: 'update_invalidated',
  });

/**
 * @param {object} o
 * @param {(destination: string, command: string, input?: Buffer) => Promise<{ code: number, stdout: string, stderr: string }>} o.channel one command on a machine, with bytes for its standard input (install.cjs createSshChannel)
 * @param {{ list: () => { id: string, address: string, socketPath?: string }[], hostKey: (id: string) => string }} o.registry
 * @param {(build: string) => { file: string, sha256: string, version: string } | Promise<{ file: string, sha256: string, version: string }>} o.bundle the Host tarball this app carries for a machine's core build (bundle.cjs)
 * @param {() => ReturnType<typeof import('./pairingClient.cjs').loadIdentity>} o.identity this install's key (pairingClient.cjs)
 * @param {(record: { id: string, address: string, socketPath?: string }) => Promise<{ close: () => void }>} o.session opens a fresh authenticated session, renewing the paired key before update eligibility is checked
 * @param {() => boolean} o.allowed access and service lifetime at every awaited boundary
 * @param {(record: any) => boolean} o.isCurrent whether a machine's Host is not behind this app's build (it then knows key changes); asked by `rotate`
 * @param {(record: any) => boolean} [o.isOlder] whether a live Host is strictly older than this app
 * @param {(record: any) => boolean} [o.isNewer] whether a machine's Host (a record with `hostBuild` and `hostAppVersion`) is newer than this app: a rotation would replace it with this app's older build, so it stops first
 * @param {(record: any) => Promise<any>} [o.status] what the Host says of itself now: the registry's record can be 30 s old and another Mac may have updated the Host since, so every update asks again before anything is sent (#4923)
 */
function createHostUpdater({ channel, registry, bundle, identity, isCurrent, isOlder, isNewer, status, session, allowed }) {
  /** @param {{ id: string, address: string, socketPath?: string }} record */
  async function liveStatus(record) {
    if (!status) return null;
    /** @type {any} */
    let timer;
    const said = await Promise.race([
      (async () => status(record))().catch((error) => noteIgnored('ask the Host for its status before an update', error)),
      new Promise((resolve) => (timer = clock.setTimeout(() => resolve(null), STATUS_MS))),
    ]).finally(() => clock.clearTimeout(timer));
    return isJsonRecord(said)
      ? {
          ...record,
          hostBuild: Object.hasOwn(said, 'build') ? said.build : '',
          hostAppVersion: Object.hasOwn(said, 'appVersion') ? said.appVersion : '',
          pendingUpdate: said.pendingUpdate,
          harnesses: said.harnesses,
        }
      : null;
  }

  /** @param {Awaited<ReturnType<typeof liveStatus>>} live @param {() => boolean} enabled */
  function checkAutomatic(live, enabled) {
    if (!live || !Array.isArray(live.harnesses) || live.pendingUpdate || !isOlder?.(live) || !enabled()) throw deferUpdate();
    return live;
  }

  /** @param {string} destination @param {string} command @param {Buffer | undefined} input @param {() => void} check */
  async function run(destination, command, input, check, automatic = false) {
    check();
    const r = await channel(destination, command, input);
    check();
    if (automatic && r.code === DEFERRED_EXIT) throw deferUpdate();
    if (automatic && r.code === UNSUPPORTED_EXIT) throw manualUpdateNeeded();
    if (automatic && r.code === RESTART_UNCONFIRMED_EXIT)
      throw Object.assign(
        new Error('The Host staged the update but its restart could not be confirmed. Choose Try again on this machine’s row.'),
        {
          code: RESTART_UNCONFIRMED,
        },
      );
    if (r.code !== 0) throw new Error([r.stdout.trim(), r.stderr.trim()].filter(Boolean).join('\n') || 'The command failed.');
    return r.stdout.trim();
  }
  const updater = {
    /**
     * Sends this app's Host build to a paired machine and asks it to restart into the build once idle. The machine takes it only because the app signed it for that Host: the manifest names the Host, expires in an hour and is newer than any before.
     * With `change` the manifest is a v3 one that names the app's current key and adds `nextKey` to what the Host trusts and/or drops the keys in `revoke` (key rotation, keyRotation.cjs): the same update, taken only when the Host accepts the key change too.
     * @param {string} id @param {{ nextKey?: string, revoke?: string[] }} [change]
     * @param {{ automaticEnabled?: () => boolean, ownsUpdate?: () => boolean }} [attempt] The app's live preference and per-machine update owner.
     * @returns {Promise<{ version: string, output: string }>}
     */
    async update(id, change, { automaticEnabled, ownsUpdate = () => true } = {}) {
      const record = registry.list().find((r) => r.id === id);
      if (!record) throw Object.assign(new Error('That machine is not in the list.'), { code: 'unknown_machine' });
      const hostId = registry.hostKey(id);
      const live = await liveStatus(record);
      if (!ownsUpdate()) throw invalidatedUpdate();
      if (automaticEnabled) checkAutomatic(live, automaticEnabled);
      else if (live && isNewer?.(live))
        throw Object.assign(new Error('Host is newer than this app. Update MoPilot.'), { code: 'host_newer' });
      if (!hostId) throw Object.assign(new Error('Pair this machine before updating it.'), { code: 'not_paired' });
      // a machine joined by command is reached only through the relay: there is no ssh to send the build over
      if (record.address.startsWith('relay:'))
        throw Object.assign(new Error('This machine has no ssh. Update its Host there: run the update command on it.'), {
          code: 'unsupported',
        });
      const keyId = identity().keyId;
      const address = record.address;
      const socketPath = record.socketPath;
      const check = () => {
        if (!allowed()) throw Object.assign(new Error('Host is not available for this account.'), { code: 'not_allowed' });
        const current = registry.list().find((r) => r.id === id);
        if (
          !current ||
          current.address !== address ||
          current.socketPath !== socketPath ||
          registry.hostKey(id) !== hostId ||
          identity().keyId !== keyId ||
          !ownsUpdate()
        )
          throw invalidatedUpdate();
      };
      try {
        check();
        const authenticated = await session(record);
        try {
          check();
        } finally {
          authenticated.close();
        }
        check();
        // nothing is sent to a machine with no build: its Host goes on running the version it has
        const asked = await channel(record.address, coreProbeCommand(HOST_RUN_NODE));
        check();
        if (asked.code !== 0) throw new Error(notAsked(asked.stderr));
        const build = coreBuildOf(asked.stdout);
        if (!build) throw new Error(noCoreBuild(asked.stdout));
        const built = await bundle(build);
        check();
        /** @type {ReturnType<typeof readAutomaticFloor>} */
        let floor = null;
        if (automaticEnabled) {
          const reply = await channel(record.address, READ_UPDATE_FLOOR);
          check();
          if (reply.code === UNSUPPORTED_EXIT) throw manualUpdateNeeded();
          if (reply.code !== 0 || !(floor = readAutomaticFloor(reply.stdout))) throw deferUpdate();
          const latest = await liveStatus(record);
          check();
          const confirmed = checkAutomatic(latest, automaticEnabled);
          if (confirmed.hostBuild !== floor.build || confirmed.hostAppVersion !== floor.appVersion) throw deferUpdate();
        }
        const name = automaticEnabled ? 'archive.tgz' : `host-${built.sha256.slice(0, 16)}.tgz`;
        const now = clock.now();
        const facts = {
          version: built.version,
          sha256: built.sha256,
          url: name,
          hostId,
          seq: floor ? floor.seq + 1 : now,
          notAfter: now + VALID_MS,
          ...(change ? { keyId: identity().keyId, ...change } : {}),
        };
        const manifest = Buffer.from(`${JSON.stringify({ ...facts, signature: identity().signManifest(facts) })}\n`);
        const bytes = fs.readFileSync(built.file);
        if (floor) {
          const output = await run(record.address, stageAutomaticCommand(manifest, floor), bytes, check, true);
          return { version: built.version, output };
        }
        await run(record.address, `mkdir -p "${INCOMING}" && cat > "${INCOMING}/${name}"`, bytes, check);
        await run(record.address, `cat > "${INCOMING}/manifest.json"`, manifest, check);
        // the files are removed whether or not the machine took them
        const output = await run(
          record.address,
          `${HOST_CLI} update --manifest "${INCOMING}/manifest.json"; s=$?; rm -f "${INCOMING}/${name}" "${INCOMING}/manifest.json"; exit $s`,
          undefined,
          check,
        );
        return { version: built.version, output };
      } catch (e) {
        check();
        throw Object.assign(new Error(userError(e)), { code: typeof e?.code === 'string' ? e.code : 'update_failed' });
      }
    },
  };
  const rotation = createKeyRotation({ registry, updater, identity, current: isCurrent, newer: isNewer });
  return { ...updater, rotate: rotation.rotate };
}

module.exports = { createHostUpdater, VALID_MS, STATUS_MS };
