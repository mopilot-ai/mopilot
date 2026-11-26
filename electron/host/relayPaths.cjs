// The relay path to the user's machines (#2709), as machines.cjs uses it: which machines are enrolled (kept sealed by safeStorage in
// host-relay.json: the relay pair, the pair root and the path mode, never the Host's credential, which only the Host keeps), the host
// lane, one relay tunnel per enrolled machine, and the tunnel pool that joins each machine's SSH tunnel and relay tunnel
// (pathTunnel.cjs). Enrolling mints the Host's relay id and secret, registers the secret's hash on the lane, hands the Host the
// credential and this app's key share over the paired connection (`host.relayEnroll`), and keeps the root both ends derive.
// Forgetting a machine revokes its credential on the relay (kept until the relay answers) and tells the Host when it can. A machine
// whose Host removed this Mac (its link answers only that, relayTombstone.mjs) has its pair revoked here and is marked removed (#5747).
const crypto = require('node:crypto');
const path = require('node:path');
const { readSecret, writeSecret } = require('../platform/secretFile.cjs');
const { mkdirPrivate } = require('../platform/privateFiles.cjs');
const { noteIgnored } = require('../ignored.cjs');
const { managedEndpoint } = require('../platform/managedPolicy.cjs');
const { endpoints } = require('../platform/mopilotEndpoints.cjs');
const { createRelayLane, NO_RELAY } = require('./relayLane.cjs');
const { createRelayTunnel } = require('./relayTunnel.cjs');
const { createPathTunnel } = require('./pathTunnel.cjs');
const { socketDirFor } = require('./sshTunnel.cjs');
// the app's crypto runs in Electron, whose OpenSSL has no ChaCha20-Poly1305: sodium's (electron/platform/sodiumPrimitives.cjs) is the one that seals there
const { createSodiumPrimitives } = require('../platform/sodiumPrimitives.cjs');
const { createCrypto } = require('../../shared/remote/crypto.mjs');
const { fromBase64, toBase64 } = require('../../shared/remote/envelope.mjs');

/** The app's id in every enrollment's root (host/src/relayLink.mjs APP_ID). */
const APP_ID = 'app';
const MODES = new Set(['auto', 'ssh', 'relay']);

/**
 * The relay this install uses: the managed policy's `endpoints.relay`, else MOPILOT_RELAY_URL for a self-hosted one, else
 * MoPilot's (the phone's relay, electron/remote/runtime.cjs); null in a build without the MoPilot service that names none.
 * @returns {string | null}
 */
const relayUrl = () => managedEndpoint('relay') || process.env.MOPILOT_RELAY_URL || endpoints?.RELAY_URL || null;

const b64url = (/** @type {number} */ n) => crypto.randomBytes(n).toString('base64url');

/** @typedef {{ hostId: string, pairId: string, relayUrl: string, root: string, lane?: string | null, rotate?: boolean }} Enrollment `lane`: the lane id that issued it; `rotate`: made by Add by command and not replaced yet */
/** @typedef {{ enrollments: Record<string, Enrollment>, modes: Record<string, string>, removed?: Record<string, number> }} Saved `removed`: the machines whose Host removed this Mac, and when */

/**
 * @param {object} o
 * @param {string} o.dir the user data dir
 * @param {() => string | null} o.url the relay's WebSocket URL; null when this build names none
 * @param {(force: boolean) => Promise<string | null>} [o.getToken] the account's relay token (null while signed out); by default the MoPilot sign-in's (`live.mopilot`)
 * @param {{ mopilot?: { relayToken(force?: boolean): Promise<string | null>, relayRefusal?: 'disabled' | null } } | undefined} [o.live] main's live services, read when a token is wanted
 * @param {import('../platform/secretFile.cjs').SafeStorage | null} o.safeStorage
 * @param {(url: string, headers: Record<string, string>) => any} [o.createSocket]
 * @param {import('../../shared/remote/crypto.mjs').Primitives} [o.prim]
 */
function createRelayPaths({
  dir,
  url,
  live,
  getToken = async (force) => (await live?.mopilot?.relayToken(force)) ?? null,
  safeStorage,
  createSocket,
  prim = createSodiumPrimitives(),
}) {
  const file = path.join(dir, 'host-relay.json');
  const c = createCrypto(prim);
  const lane = createRelayLane({
    url,
    getToken,
    // a switched-off account's lane waits like a refused one instead of asking again every few seconds
    refused: () => live?.mopilot?.relayRefusal ?? null,
    revokesFile: path.join(dir, 'host-relay-revokes.json'),
    createSocket,
  });
  /** @type {Map<string, ReturnType<typeof createRelayTunnel>>} */
  const tunnels = new Map();
  /** @type {Set<{ sync(): void }>} */
  const paths = new Set();
  /** @type {Saved | null} */
  let cache = null;

  /** @returns {Saved} */
  function load() {
    if (cache) return cache;
    try {
      const raw = readSecret(file, safeStorage);
      const saved = raw ? JSON.parse(raw.value) : null;
      cache = { enrollments: saved?.enrollments ?? {}, modes: saved?.modes ?? {}, removed: saved?.removed ?? {} };
    } catch (error) {
      // unreadable (another key, a broken file): no relay path, and nothing is written over it until a change
      noteIgnored('read the machines’ relay paths', error);
      cache = { enrollments: {}, modes: {} };
    }
    return cache;
  }
  /** @param {Saved} next */
  function save(next) {
    mkdirPrivate(dir);
    writeSecret(file, JSON.stringify(next), safeStorage, 'the machines’ relay paths');
    cache = next;
    for (const p of paths) p.sync();
  }

  /** The relay tunnel of a machine, made on first use. @param {string} destination @param {string} socketDir */
  function tunnelOf(destination, socketDir) {
    const e = load().enrollments[destination];
    if (!e) return null;
    let t = tunnels.get(destination);
    // a tunnel is the machine's only while its pair is the one on record: a re-enrollment, a rotation or a repair gives a new pair,
    // and the tunnel of the old one (its pair id and root) goes rather than being used for the new
    if (t && t.pairId !== e.pairId) {
      t.dispose();
      t = undefined;
    }
    if (!t) {
      const name = `r-${crypto.createHash('sha256').update(destination).digest('hex').slice(0, 16)}.sock`;
      // a socket path is short (about 100 bytes): a long data folder keeps them in the temp dir, as the SSH tunnels do
      const folder = socketDirFor(socketDir);
      mkdirPrivate(folder);
      t = createRelayTunnel({
        lane,
        enrollment: { pairId: e.pairId, root: fromBase64(e.root) },
        localSocket: path.join(folder, name),
        prim,
      });
      tunnels.set(destination, t);
    }
    return t;
  }

  /**
   * What the relay still holds, read on every open of the lane: an enrollment of this lane whose pair is gone (the device was revoked,
   * the relay lost it) is dropped here so the machine is enrolled again, and one another account's or device's lane issued is put on
   * that lane's revoke list (this lane cannot revoke it) and dropped too.
   */
  lane.onPairs((held) => {
    const s = load();
    const keep = Object.entries(s.enrollments).filter(([, e]) => {
      if (e.lane && e.lane !== lane.device) return void lane.revoke(e.hostId, e.lane);
      return held.includes(e.pairId);
    });
    if (keep.length === Object.keys(s.enrollments).length) return;
    for (const [d] of Object.entries(s.enrollments)) if (!keep.some(([k]) => k === d)) dropTunnel(d);
    save({ ...s, enrollments: Object.fromEntries(keep) });
  });
  // a pair the relay removed while the lane was up goes the same way
  lane.onRemoved((pair) => {
    const s = load();
    const gone = Object.entries(s.enrollments).find(([, e]) => e.pairId === pair);
    if (!gone) return;
    const { [gone[0]]: _x, ...enrollments } = s.enrollments;
    dropTunnel(gone[0]);
    save({ ...s, enrollments });
  });
  /** @param {string} destination */
  function dropTunnel(destination) {
    tunnels.get(destination)?.dispose();
    tunnels.delete(destination);
  }

  const kept = () => Object.keys(load().enrollments).length > 0 || lane.pendingRevokes().length > 0;
  // a lane with nothing to carry is not opened
  if (kept()) lane.start();

  return {
    lane,
    /** The relay's WebSocket URL this app uses. */
    url,
    /** Whether a machine has a relay path. @param {string} destination */
    enrolled: (destination) => !!load().enrollments[destination],
    /** @param {string} destination @returns {'auto' | 'ssh' | 'relay'} */
    modeOf: (destination) => /** @type {'auto' | 'ssh' | 'relay'} */ (modeOf(destination)),
    /** Pins a machine to a path, or back to `auto`. @param {string} destination @param {unknown} mode */
    setMode(destination, mode) {
      if (typeof mode !== 'string' || !MODES.has(mode)) throw new Error('Pick auto, ssh or relay.');
      const s = load();
      save({ ...s, modes: { ...s.modes, [destination]: mode } });
    },
    /**
     * The tunnel pool machines.cjs uses: each machine's SSH tunnel from `ssh`, joined with its relay tunnel when it has one.
     * @param {{ get: (t: any) => any, closeAll?: () => void }} ssh @param {string} socketDir
     */
    pool(ssh, socketDir) {
      /** @type {Map<string, ReturnType<typeof createPathTunnel>>} */
      const joined = new Map();
      return {
        /** @param {{ destination: string, remoteSocket: string, sshArgs?: string[] }} target */
        get(target) {
          const sshTunnel = ssh.get(target);
          let t = joined.get(target.destination);
          if (!t || /** @type {any} */ (t).ssh !== sshTunnel) {
            const made = createPathTunnel({
              ssh: sshTunnel,
              relay: () => tunnelOf(target.destination, socketDir),
              mode: () => /** @type {any} */ (modeOf(target.destination)),
            });
            t = Object.assign(made, { ssh: sshTunnel });
            joined.set(target.destination, t);
            paths.add(t);
          }
          return t;
        },
        closeAll() {
          for (const t of joined.values()) t.close();
          for (const t of tunnels.values()) t.close();
          ssh.closeAll?.();
        },
      };
    },
    /** How a machine is reached now, for its row: the mode, the path in use and the relay's round trip. @param {string} destination @param {any} [tunnel] its pooled tunnel, when one is made */
    view: (destination, tunnel) => ({
      mode: modeOf(destination),
      relay: !!load().enrollments[destination],
      path: tunnel?.path ?? null,
      latencyMs: tunnel?.latencyMs ?? null,
    }),
    /**
     * Gives a machine a relay path: its credential on the relay, then on the Host (over `call`, the paired connection), then the root here.
     * Resolves null when `wanted` says the machine went meanwhile (nothing is kept, on either end).
     * @param {string} destination @param {(method: string, params?: object) => Promise<any>} call @param {() => boolean} [wanted]
     */
    async enroll(destination, call, wanted = () => true) {
      const relayUrl = url();
      if (!relayUrl) throw new Error(NO_RELAY);
      const hostId = `h_${b64url(16)}`;
      const pairId = `p_${b64url(12)}`;
      const secret = b64url(32);
      await lane.whenOpen();
      // on the revoke list from before the relay has it until it is kept here: a crash or a removal in between leaves nothing behind
      lane.intend(hostId);
      await lane.register({ host: hostId, pair: pairId, hash: crypto.createHash('sha256').update(secret).digest('hex') });
      const sk = prim.randomBytes(32);
      const ephSk = prim.randomBytes(32);
      let answer;
      try {
        answer = await call('host.relayEnroll', {
          relayUrl,
          hostId,
          secret,
          pairId,
          appPub: toBase64(prim.x25519Base(sk)),
          appEphPub: toBase64(prim.x25519Base(ephSk)),
        });
      } catch (error) {
        // the Host did not take it: the credential the relay holds for it goes
        await lane.revoke(hostId);
        throw error;
      }
      const root = c.deriveRoot(sk, fromBase64(answer.hostPub), ephSk, fromBase64(answer.hostEphPub), APP_ID, hostId, pairId);
      // the machine was removed (or replaced) while this ran: its new credential goes again
      if (!wanted()) {
        await lane.revoke(hostId);
        await call('host.relayForget', { hostId }).catch((e) => noteIgnored('tell a machine its relay path is gone', e));
        return null;
      }
      const s = load();
      const old = s.enrollments[destination];
      try {
        save({
          ...s,
          enrollments: { ...s.enrollments, [destination]: { hostId, pairId, relayUrl, root: toBase64(root), lane: lane.device } },
        });
      } catch (error) {
        // a root this app cannot keep is a path nobody can use: both ends let go of it
        await lane.revoke(hostId);
        await call('host.relayForget', { hostId }).catch((e) => noteIgnored('tell a machine its relay path is gone', e));
        throw error;
      }
      lane.settle(hostId);
      // a machine enrolled again keeps one credential on the relay, and its Host lets go of the old one
      if (old) {
        await lane.revoke(old.hostId);
        await call('host.relayForget', { hostId: old.hostId }).catch((e) => noteIgnored('tell a machine its old relay path is gone', e));
      }
      return { hostId };
    },
    /**
     * Keeps a relay path made elsewhere (Add by command, relayBoot.cjs): the pair root both ends already derived.
     * @param {string} destination @param {{ hostId: string, pairId: string, relayUrl: string, root: string }} e
     * @param {{ rotate?: boolean }} [opts] `rotate: false` for a credential that never travelled in a script (pairing by code seals it in the run)
     */
    adopt(destination, e, { rotate = true } = {}) {
      const s = load();
      // its credential travelled in an install script: it is replaced (`needsRotation`) as soon as the machine answers
      save({ ...s, enrollments: { ...s.enrollments, [destination]: { ...e, lane: lane.device, rotate } } });
    },
    /** Whether a machine's credential still is the one its install script carried. @param {string} destination */
    needsRotation: (destination) => load().enrollments[destination]?.rotate === true,
    /**
     * Takes a machine's relay path away: the relay forgets its credential (kept until it answers), and the Host is told when `call` reaches it.
     * @param {string} destination @param {((method: string, params?: object) => Promise<any>) | null} [call]
     */
    async forget(destination, call = null) {
      const s = load();
      const e = s.enrollments[destination];
      const { [destination]: _was, ...removed } = s.removed ?? {};
      if (!e) {
        // a machine removed by its Host has no pair left: the mark goes with it
        if (_was !== undefined) save({ ...s, removed });
        return false;
      }
      const { [destination]: _gone, ...enrollments } = s.enrollments;
      const { [destination]: _mode, ...modes } = s.modes;
      dropTunnel(destination);
      save({ enrollments, modes, removed });
      await lane.revoke(e.hostId);
      if (call)
        await call('host.relayForget', { hostId: e.hostId }).catch((error) => noteIgnored('tell a machine its relay path is gone', error));
      return true;
    },
    /**
     * The machine's Host removed this Mac (its link answered `linkRemoved`): the pair is this app's, so its credential is revoked here (kept
     * until the relay answers), the tunnel stops dialling, and the machine stays marked removed until it is removed here too.
     * @param {string} destination
     */
    async peerRemoved(destination) {
      const s = load();
      const e = s.enrollments[destination];
      if (!e) return false;
      const { [destination]: _gone, ...enrollments } = s.enrollments;
      dropTunnel(destination);
      save({ ...s, enrollments, removed: { ...s.removed, [destination]: Date.now() } });
      await lane.revoke(e.hostId);
      return true;
    },
    /** Whether a machine's Host removed this Mac. @param {string} destination */
    removedByPeer: (destination) => load().removed?.[destination] !== undefined,
    dispose() {
      for (const t of tunnels.values()) t.dispose();
      tunnels.clear();
      lane.stop();
    },
  };
  /** @param {string} destination */
  function modeOf(destination) {
    // a machine added by command has no SSH address: the relay is its one path
    if (destination.startsWith('relay:')) return 'relay';
    const m = load().modes[destination];
    return MODES.has(m) ? m : 'auto';
  }
}

module.exports = { createRelayPaths, relayUrl, APP_ID };
