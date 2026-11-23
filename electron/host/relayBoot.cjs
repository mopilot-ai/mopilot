// Add by command in the app (#2709): one boot at a time. Start mints the Host's relay id, credential and pair, a boot id and a
// one-time code, registers them on the host lane and gives the command to show. While it waits, the lane's boot requests are
// answered here: the install script (bootScript.cjs) and the app's own Host bundle, streamed through the relay. The machine's
// enroll hello (sealed under the code: shared/host/relayEnroll.mjs) says who it is; the card shows that with the address the
// relay saw, and the user allows or denies. Allow answers with this app's keys and keeps the pair root (relayPaths.adopt); deny,
// a newer start or the clock running out revokes the credential and the boot. The code is never logged or written anywhere.
const crypto = require('node:crypto');
const { fs } = require('../platform/ports/fs.cjs');
const { clock } = require('../platform/ports/clock.cjs');
const { noteIgnored } = require('../ignored.cjs');
const { bootCommand, bootScript } = require('./bootScript.cjs');
const { NO_RELAY } = require('./relayLane.cjs');
const { createNodePrimitives } = require('../../shared/remote/nodePrimitives.mjs');
const { createCrypto } = require('../../shared/remote/crypto.mjs');
const { fromBase64, toBase64 } = require('../../shared/remote/envelope.mjs');
const { enrollKeys, openEnroll, sealEnroll } = require('../../shared/host/relayEnroll.mjs');
const { CORE_BUILDS } = require('../../shared/host/coreBuild.mjs');

/** How long a command can be run. */
const BOOT_MS = 15 * 60_000;
/** How long a machine that fetched the command may go without asking for anything or saying hello before the card gives up on it (a Node download is the longest silence). */
const STALL_MS = 5 * 60_000;
/** A boot download's bytes per message: under the relay's message cap once in base64. */
const CHUNK = 192 * 1024;
const APP_ID = 'app';
/** What a boot holds before it has a route and a listener, and after Allow (its route stays). @type {() => void} */
const NOOP = () => undefined;
/** A 32-byte public key in base64. */
const KEY = /^[A-Za-z0-9+/]{43}=$/;
const b64url = (/** @type {number} */ n) => crypto.randomBytes(n).toString('base64url');
/**
 * The boot host a relay names in `host.boot`'s answer, when it is a plain https origin (DNS labels, a port): else null, and the
 * relay's own address is used. A URL may carry `;`, `$( )` or backticks in its host, and the command is run by a shell before
 * any hash is checked, so nothing else is taken (the command quotes it as well).
 * @param {unknown} v
 */
const bootOrigin = (v) => (typeof v === 'string' && PLAIN_ORIGIN.test(v) ? v : null);
const PLAIN_ORIGIN = /^https:\/\/[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+(:\d{1,5})?$/;
/** Why a command could not be made, for the card. @param {unknown} error */
const startFailure = (error) =>
  /** @type {any} */ (error)?.code === 'boot_quota'
    ? 'You have made as many commands as one account may in a day. Try again tomorrow, or add the machine over SSH.'
    : 'MoPilot could not reach its relay. Check the connection and try again.';
/** What the machine says about itself, cut to what a card can show. @param {unknown} v */
const shortText = (v) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 80) : '');
/** What the card says when the machine ran the command and went quiet: its script prints the reason on its own terminal only. */
const STALLED =
  'The machine started the command but did not finish joining. Check its terminal for the line that starts with “MoPilot:”, then try again.';
/**
 * What the card says for each reason the script reports before it exits (bootScript.cjs `fail <code>`), worded here and never taken
 * from the machine: the card shows the real cause and what to do, and Try again makes a new command.
 * @type {Record<string, string>}
 */
const REPORTED = {
  usage: 'The machine ran only part of the command. Copy the whole command and run it again.',
  tar: 'The machine has no tar. Install it there, then try again.',
  sha: 'The machine has neither sha256sum nor shasum. Install one there, then try again.',
  os: 'MoPilot runs on macOS and Linux (64-bit Intel or ARM), and this machine is neither.',
  no_build: 'MoPilot has no Host build for this machine.',
  node_download: 'The machine could not download Node. Check its connection, then try again.',
  node_run: 'The Node MoPilot brings does not run on this machine.',
  download: 'The machine could not download the Host from MoPilot. Keep MoPilot open on your Mac, then try again.',
  checksum: 'The Host the machine downloaded did not match its checksum. Try again.',
  unpack: 'The machine could not unpack the Host. Check its free disk space, then try again.',
};
/** What the card says when this app could not send the machine its Host. @param {unknown} error */
const sendFailure = (error) =>
  `MoPilot could not send the Host to the machine (${shortText(/** @type {any} */ (error)?.message).replace(/\.$/, '') || 'unknown reason'}).`;

/** The https address the relay serves boots on, from its WebSocket URL. @param {string} wsUrl */
const httpBase = (wsUrl) => {
  const u = new URL(wsUrl);
  return `${u.protocol === 'ws:' ? 'http:' : 'https:'}//${u.host}`;
};

/**
 * @typedef {{ state: 'idle' | 'waiting' | 'asking' | 'joined' | 'denied' | 'expired' | 'failed', command: string, expiresAt: number,
 *   machine: { name: string, os: string, arch: string, user: string, ip: string } | null, error: string }} BootView
 */

/**
 * @param {object} o
 * @param {ReturnType<typeof import('./relayLane.cjs').createRelayLane>} o.lane
 * @param {{ adopt: (destination: string, e: { hostId: string, pairId: string, relayUrl: string, root: string }) => void }} o.paths
 * @param {() => string | null} o.url the relay's WebSocket URL; null when this build names none
 * @param {(build: string) => { file: string, sha256: string, version: string } | Promise<{ file: string, sha256: string, version: string }>} o.bundle the app's Host bundle for a core build (bundle.cjs)
 * @param {() => string | null} [o.updateKeyPem] the key the Host takes updates from
 * @param {(view: BootView) => void} [o.onChange]
 * @param {import('../../shared/remote/crypto.mjs').Primitives} [o.prim]
 */
function createRelayBoot({
  lane,
  paths,
  url,
  bundle,
  updateKeyPem = () => null,
  onChange = () => undefined,
  prim = createNodePrimitives(),
}) {
  const c = createCrypto(prim);
  /** @type {BootView} */
  let view = { state: 'idle', command: '', expiresAt: 0, machine: null, error: '' };
  /** The boot under way (with its secrets, never in the view). @type {any} */
  let cur = null;
  /** Bumped by every start, Deny and close: a start that finds it moved on was overtaken. */
  let starts = 0;
  const set = (/** @type {Partial<BootView>} */ change) => {
    view = { ...view, ...change };
    try {
      onChange(view);
    } catch (error) {
      noteIgnored('tell the windows how a command stands', error);
    }
  };

  /** Lets go of the boot: its route, timer and listener; `revoke` also takes its credential and boot id off the relay. @param {boolean} revoke */
  function release(revoke) {
    const b = cur;
    cur = null;
    if (!b) return;
    clock.clearTimeout(b.timer);
    clock.clearTimeout(b.stall);
    b.offRoute();
    b.offBoot();
    lane.request({ t: 'host.unboot', boot: b.bootId }).catch((e) => noteIgnored('end a command on the relay', e));
    if (revoke) lane.revoke(b.hostId).catch((e) => noteIgnored('revoke a command’s credential', e));
  }

  /** Answers one boot download: the script or the bundle, in chunks. @param {any} b @param {{ req: string, what: string, ip: string, build?: string }} r */
  async function serve(b, r) {
    watch(b);
    const send = (/** @type {Buffer} */ bytes, /** @type {boolean} */ end) =>
      lane.notify({ t: 'boot.data', req: r.req, data: bytes.toString('base64'), ...(end ? { end: true } : {}) });
    try {
      let bytes;
      if (r.what === 'script') {
        b.scriptIp = shortText(r.ip);
        bytes = b.script;
      } else {
        if (!CORE_BUILDS.includes(/** @type {string} */ (r.build))) throw new Error(`There is no Host build ${r.build}.`);
        const built = await bundle(/** @type {string} */ (r.build));
        bytes = fs.readFileSync(built.file);
        if (crypto.createHash('sha256').update(bytes).digest('hex') !== built.sha256)
          throw new Error('The Host package does not match its checksum.');
      }
      for (let o = 0; o < bytes.length; o += CHUNK) send(bytes.subarray(o, o + CHUNK), o + CHUNK >= bytes.length);
    } catch (error) {
      noteIgnored('send a machine its installer', error);
      lane.notify({ t: 'boot.data', req: r.req, failed: true });
      // the machine's script ends there with its own line; the card says why and offers a new command
      if (cur === b) {
        release(true);
        set({ state: 'failed', command: '', machine: null, error: sendFailure(error) });
      }
    }
  }

  /** The script said why it stopped, before the machine joined: the card says so now rather than waiting out the silence. @param {any} b @param {string | undefined} code */
  function reported(b, code) {
    // after hello the machine is asking to join (a later stop is the join's, machineBoot.cjs), and a code this app does not word says nothing
    if (cur !== b || view.state !== 'waiting' || !code || !Object.hasOwn(REPORTED, code)) return;
    release(true);
    set({ state: 'failed', command: '', machine: null, error: REPORTED[code] });
  }

  /** The machine asked for something: it is running the command, so a long silence after this is a failure the card names. @param {any} b */
  function watch(b) {
    clock.clearTimeout(b.stall);
    b.stall = clock.setTimeout(() => {
      if (view.state !== 'waiting') return; // a later request after the machine said hello leaves its card alone
      release(true);
      set({ state: 'failed', command: '', machine: null, error: STALLED });
    }, STALL_MS);
  }

  /** The machine's enroll hello: who it says it is, for the card. @param {any} b @param {any} f */
  function hello(b, f) {
    const h = f.dir === 'p2m' ? openEnroll(prim, b.keys.p2m, f) : null;
    if (!h || !KEY.test(String(h.hostPub)) || !KEY.test(String(h.hostEphPub))) return;
    // the first hello is the one the card shows and Allow answers; a later one (another machine with the same command) is ignored,
    // and the same one again (the machine reconnected before it heard the answer) gets the same answer again
    if (b.hello) {
      if (b.answer && h.hostPub === b.hello.hostPub && h.hostEphPub === b.hello.hostEphPub) lane.send(b.answer);
      return;
    }
    b.hello = h;
    clock.clearTimeout(b.stall);
    set({
      state: 'asking',
      machine: {
        name: shortText(h.name),
        os: shortText(h.os),
        arch: shortText(h.arch),
        user: shortText(h.user),
        ip: b.peerIp || b.scriptIp || '',
      },
    });
  }

  return {
    get view() {
      return view;
    },
    /** A new command (any earlier one is ended and its credential revoked). @returns {Promise<BootView>} */
    async start() {
      release(true);
      const gen = ++starts;
      const relayUrl = url();
      // a build without the MoPilot service names no relay of its own (electron/host/relayPaths.cjs relayUrl)
      if (!relayUrl) {
        set({ state: 'failed', command: '', expiresAt: 0, machine: null, error: NO_RELAY });
        return view;
      }
      const b = {
        bootId: `b_${b64url(16)}`,
        hostId: `h_${b64url(16)}`,
        pairId: `p_${b64url(12)}`,
        secret: b64url(32),
        code: b64url(16),
        relayUrl,
        sk: prim.randomBytes(32),
        ephSk: prim.randomBytes(32),
        scriptIp: '',
        script: Buffer.alloc(0),
        peerIp: '',
        hello: /** @type {any} */ (null),
        answer: /** @type {any} */ (null),
        timer: /** @type {any} */ (null),
        stall: /** @type {any} */ (null),
        offRoute: NOOP,
        offBoot: NOOP,
        keys: /** @type {any} */ (null),
      };
      b.keys = enrollKeys(c, b.code, b.pairId);
      set({ state: 'waiting', command: '', expiresAt: 0, machine: null, error: '' });
      /** where the command fetches its script and bundles: the relay's boot host when it names one, else the relay itself */
      let base = httpBase(relayUrl);
      let registered = false;
      try {
        /** @type {Record<string, string>} */
        const bundles = {};
        for (const build of CORE_BUILDS) bundles[build] = (await bundle(build)).sha256;
        await lane.whenOpen();
        lane.intend(b.hostId);
        await lane.register({ host: b.hostId, pair: b.pairId, hash: crypto.createHash('sha256').update(b.secret).digest('hex') });
        const ok = await lane.request({ t: 'host.boot', boot: b.bootId, host: b.hostId });
        registered = true;
        base = bootOrigin(ok?.base) ?? base;
        // the script is made now: the command carries its hash, so the far machine runs no other
        b.script = Buffer.from(
          bootScript({
            bundleUrl: `${base}/v1/boot/${b.bootId}/bundle`,
            bundles,
            enrollment: { relayUrl, hostId: b.hostId, secret: b.secret, pairId: b.pairId },
            updateKeyPem: updateKeyPem(),
            reportUrl: `${base}/v1/boot/${b.bootId}/report`,
          }),
        );
      } catch (error) {
        if (registered) lane.request({ t: 'host.unboot', boot: b.bootId }).catch((e) => noteIgnored('end a command on the relay', e));
        await lane.revoke(b.hostId);
        set({ state: 'failed', error: startFailure(error) });
        noteIgnored('start a command for a machine', error);
        return view;
      }
      // a newer start, a Deny or the app closing while this one was registering: it is not shown, and its credential goes
      if (gen !== starts) {
        lane.request({ t: 'host.unboot', boot: b.bootId }).catch((e) => noteIgnored('end a command on the relay', e));
        await lane.revoke(b.hostId);
        return view;
      }
      cur = b;
      b.offRoute = lane.route(b.pairId, {
        onFrame: (f) => hello(b, f),
        // the relay says where the machine connected from: shown on the card before Allow
        onPeer: (online, ip) => {
          if (online && ip) b.peerIp = shortText(ip);
        },
      });
      b.offBoot = lane.onBoot((r) => {
        if (r.boot !== b.bootId || cur !== b) return;
        if (r.what === 'report') reported(b, r.code);
        else void serve(b, r);
      });
      const expiresAt = clock.now() + BOOT_MS;
      // release() clears this timer, so it fires only for the boot still under way
      b.timer = clock.setTimeout(() => {
        release(true);
        set({ state: 'expired', machine: null });
      }, BOOT_MS);
      const scriptSha256 = crypto.createHash('sha256').update(b.script).digest('hex');
      set({ command: bootCommand({ scriptUrl: `${base}/v1/boot/${b.bootId}`, scriptSha256, code: b.code }), expiresAt });
      return view;
    },
    /**
     * The user allowed the machine: it gets this app's keys, and the pair root is kept. Resolves what the machine said about itself,
     * for its record, and the pairing code it sent.
     * @returns {{ destination: string, name: string, socketPath: string, hostKey: string, pairingCode: string, hostId: string }}
     */
    allow() {
      const b = cur;
      if (!b || view.state !== 'asking') throw Object.assign(new Error('No machine is waiting to join.'), { code: 'no_boot' });
      const h = b.hello;
      const root = c.deriveRoot(b.sk, fromBase64(String(h.hostPub)), b.ephSk, fromBase64(String(h.hostEphPub)), APP_ID, b.hostId, b.pairId);
      const answer = sealEnroll(prim, b.keys.m2p, b.pairId, 'm2p', {
        v: 1,
        allow: true,
        appPub: toBase64(prim.x25519Base(b.sk)),
        appEphPub: toBase64(prim.x25519Base(b.ephSk)),
      });
      const destination = `relay:${b.hostId}`;
      paths.adopt(destination, { hostId: b.hostId, pairId: b.pairId, relayUrl: b.relayUrl, root: toBase64(root) });
      lane.settle(b.hostId);
      b.answer = answer;
      lane.send(answer);
      // the route stays until the machine's tunnel takes the pair over (lane.route replaces it), so a machine that missed the answer hears it again
      b.offRoute = NOOP;
      release(false);
      set({ state: 'joined' });
      return {
        destination,
        name: shortText(h.name) || 'Machine',
        socketPath: String(h.socketPath ?? ''),
        hostKey: String(h.hostKey ?? ''),
        pairingCode: String(h.pairingCode ?? ''),
        hostId: b.hostId,
      };
    },
    /** The user did not allow it (or did not run it): the machine is told, and its credential and the command end. */
    deny() {
      starts++;
      const b = cur;
      if (b?.hello) lane.send(sealEnroll(prim, b.keys.m2p, b.pairId, 'm2p', { v: 1, allow: false }));
      release(true);
      // also while a start is still registering: it sees it was overtaken and ends itself
      if (b || view.state === 'waiting') set({ state: 'denied', machine: null, command: '' });
    },
    /** The app is closing: the boot ends here without reaching the relay (its id stays on the revoke list, sent on the next start). */
    dispose() {
      starts++;
      const b = cur;
      cur = null;
      if (!b) return;
      clock.clearTimeout(b.timer);
      clock.clearTimeout(b.stall);
      b.offRoute();
      b.offBoot();
    },
  };
}

module.exports = { createRelayBoot, httpBase, BOOT_MS, STALL_MS };
