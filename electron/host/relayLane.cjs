// The app's host lane on the relay (#2709): one outbound socket per install, on the account's relay token at `…/v1/ws?as=hostlink`, so
// the relay files it under its own id and it never replaces the phone lane's socket (electron/remote/runtime.cjs). It registers and
// revokes Host credentials, routes each Host pair's frames to its tunnel, and says which Hosts are online. A revoke is kept on disk
// and sent again on every open until the relay answers it, so "Remove machine" takes the credential away even while the relay is down.
const { RelayClient } = require('../remote/relayClient.cjs');
const { readStoreFile, writeAtomic } = require('../platform/fsutil.cjs');
const { noteIgnored } = require('../ignored.cjs');

/** How long an enrollment waits for the lane to open. */
const OPEN_MS = 15_000;

/** Why a machine can't be reached over the relay in a build that names none (no MoPilot service, no relay set up). */
const NO_RELAY = 'No relay is set up. Name one with the managed policy or MOPILOT_RELAY_URL.';

/** The address of the host lane for a relay's WebSocket URL. @param {string} url */
const laneUrl = (url) => `${url}${url.includes('?') ? '&' : '?'}as=hostlink`;

/**
 * @param {object} o
 * @param {() => string | null} o.url the relay's WebSocket URL (…/v1/ws); null when this build names none
 * @param {(force: boolean) => Promise<string | null>} o.getToken the account's relay token; null while signed out
 * @param {() => 'capacity' | 'account_limit' | 'disabled' | null} [o.refused] why the account service gave no token, when it refused one
 * @param {string} o.revokesFile where the revokes the relay has not answered yet are kept (Host ids only)
 * @param {(url: string, headers: Record<string, string>) => any} [o.createSocket]
 */
function createRelayLane({ url, getToken, refused, revokesFile, createSocket }) {
  const relay = new RelayClient({
    url: () => {
      const base = url();
      return base && laneUrl(base);
    },
    getToken,
    refused,
    createSocket,
  });
  /** @type {Map<string, { onFrame: (f: any) => void, onPeer: (online: boolean, ip?: string) => void }>} */
  const routes = new Map();
  /** @type {Map<string, boolean>} */
  const peers = new Map();
  /** @type {Set<() => void>} */
  const watchers = new Set();
  const changed = () => {
    for (const fn of [...watchers]) fn();
  };
  /** @param {string} pair @param {boolean} online @param {string} [ip] where the Host connected from, when the relay says */
  const setPeer = (pair, online, ip) => {
    peers.set(pair, online);
    routes.get(pair)?.onPeer(online, ip);
    changed();
  };

  /** This install's id on the lane, from the relay's hello (`<device>~h`); null until the lane first opened. @type {string | null} */
  let device = null;
  /** @type {Set<(pairs: string[]) => void>} */
  const pairWatchers = new Set();
  /** @type {Set<(pair: string) => void>} */
  const removedWatchers = new Set();
  /** @type {Set<(request: { boot: string, req: string, what: string, ip: string, build?: string, code?: string }) => void>} */
  const bootWatchers = new Set();

  /** The revokes not answered yet, each with the lane that issued its credential (null: any; a file of an earlier build). @returns {{ host: string, lane: string | null }[]} */
  const pending = () => {
    const kept = readStoreFile(revokesFile, 'the relay revokes').data;
    if (!Array.isArray(kept?.hosts)) return [];
    return kept.hosts
      .map((/** @type {any} */ h) => (typeof h === 'string' ? { host: h, lane: null } : h))
      .filter((/** @type {any} */ h) => typeof h?.host === 'string' && (h.lane === null || typeof h.lane === 'string'));
  };
  const keep = (/** @type {{ host: string, lane: string | null }[]} */ hosts) =>
    writeAtomic(revokesFile, JSON.stringify({ hosts }), undefined, 0o600);
  const without = (/** @type {string} */ host) => keep(pending().filter((h) => h.host !== host));
  /** @param {string} host @param {string | null} lane */
  const add = (host, lane) => {
    if (!pending().some((h) => h.host === host)) keep([...pending(), { host, lane }]);
  };

  /** Sends the revokes this lane may make (its own credentials); one the relay refuses now waits for the next open, the rest still go. */
  async function flush() {
    for (const h of pending()) {
      // another account's or device's credential is revoked by that lane when it is back
      if (h.lane !== null && h.lane !== device) continue;
      try {
        await relay.request({ t: 'host.revoke', host: h.host });
        without(h.host);
      } catch (error) {
        noteIgnored('revoke a machine’s relay credential', error);
      }
    }
  }

  relay.on('open', (/** @type {{ pairs: any[], device: string | null }} */ hello) => {
    device = hello.device ?? device;
    const pairs = hello.pairs.filter((p) => typeof p?.pair === 'string');
    for (const p of pairs) setPeer(p.pair, p.peerOnline === true);
    for (const fn of [...pairWatchers]) fn(pairs.map((p) => p.pair));
    void flush();
  });
  relay.on('frame', (/** @type {any} */ f) => routes.get(f.pair)?.onFrame(f));
  relay.on('event', (/** @type {any} */ e) => {
    if (e?.ev === 'boot.request' && typeof e.req === 'string') for (const fn of [...bootWatchers]) fn(e);
    if (e?.ev === 'peer' && typeof e.pair === 'string') setPeer(e.pair, e.online === true, typeof e.ip === 'string' ? e.ip : undefined);
    if (e?.ev === 'pair.removed' && typeof e.pair === 'string') {
      setPeer(e.pair, false);
      for (const fn of [...removedWatchers]) fn(e.pair);
    }
  });
  relay.on('error', (/** @type {any} */ e) => {
    if (e?.code === 'peer_offline' && typeof e.pair === 'string') setPeer(e.pair, false);
  });
  relay.on('state', (/** @type {string} */ s) => {
    if (s === 'open') return changed();
    // the lane is down: no Host is reachable through it until it is back
    for (const pair of [...peers.keys()]) setPeer(pair, false);
    changed();
  });

  return {
    /** Opens the lane (and keeps it open); calling it again does nothing. */
    start: () => relay.start(),
    stop: () => relay.stop(),
    get state() {
      return relay.state;
    },
    /** Whether the Host of a pair is connected to the relay now. @param {string} pair */
    peerOnline: (pair) => relay.state === 'open' && peers.get(pair) === true,
    /** Told on every change of the lane or a Host's presence; returns the way to stop. @param {() => void} fn */
    onChange(fn) {
      watchers.add(fn);
      return () => void watchers.delete(fn);
    },
    /** A pair's frames and presence go to `route` until the returned function is called. @param {string} pair @param {{ onFrame: (f: any) => void, onPeer: (online: boolean, ip?: string) => void }} route */
    route(pair, route) {
      routes.set(pair, route);
      return () => {
        if (routes.get(pair) === route) routes.delete(pair);
      };
    },
    /** A live frame for a Host: sent now or not at all (a stale byte stream is worse than none). @param {any} frame */
    send: (frame) => relay.state === 'open' && relay.sendFrame(frame) === 'sent',
    /** Opens the lane and resolves once it is open; rejects when it is not open in `ms` (signed out, the relay down). @param {number} [ms] */
    whenOpen(ms = OPEN_MS) {
      relay.start();
      if (relay.state === 'open') return Promise.resolve();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => (off(), reject(new Error('The relay could not be reached.'))), ms);
        const off = relay.on('state', (/** @type {string} */ s) => {
          if (s !== 'open') return;
          clearTimeout(timer);
          off();
          resolve(undefined);
        });
      });
    },
    /** @param {{ host: string, pair: string, hash: string }} h */
    register: (h) => relay.request({ t: 'host.register', ...h }),
    /** This install's id on the lane (null until it first opened). */
    get device() {
      return device;
    },
    /** Told the relay's pairs of this lane on every open: what the relay still holds. @param {(pairs: string[]) => void} fn */
    onPairs(fn) {
      pairWatchers.add(fn);
      return () => void pairWatchers.delete(fn);
    },
    /** Told each download a boot id's page asks of this app (Add by command, relayBoot.cjs). @param {(request: { boot: string, req: string, what: string, ip: string, build?: string, code?: string }) => void} fn */
    onBoot(fn) {
      bootWatchers.add(fn);
      return () => void bootWatchers.delete(fn);
    },
    /** A message nothing answers (a download's bytes): false when the lane is down. @param {object} m */
    notify: (m) => relay.send(m),
    /** A request the relay answers ok or refuses (host.boot, host.unboot). @param {{ t: string, [k: string]: unknown }} m */
    request: (m) => relay.request(m),
    /** Told when the relay removed one of this lane's pairs (a revoke, the device revoked on mopilot.ai). @param {(pair: string) => void} fn */
    onRemoved(fn) {
      removedWatchers.add(fn);
      return () => void removedWatchers.delete(fn);
    },
    /**
     * Takes a Host's credential away: kept until the relay answers (by the lane that issued it: `lane`, this one by default).
     * @param {string} host @param {string | null} [lane]
     */
    revoke(host, lane = device) {
      add(host, lane);
      if (relay.state === 'open') return flush();
      relay.start();
      return Promise.resolve();
    },
    /** Keeps a credential about to be issued on the revoke list, so a crash or a removal before it is kept never leaves it on the relay. @param {string} host */
    intend: (host) => add(host, device),
    /** The credential issued under `intend` is kept now: it leaves the revoke list. @param {string} host */
    settle: (host) => without(host),
    /** The Host ids still waiting for the relay to revoke them. */
    pendingRevokes: () => pending().map((h) => h.host),
  };
}

module.exports = { createRelayLane, laneUrl, NO_RELAY };
