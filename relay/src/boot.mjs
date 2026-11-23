// Add by command (#2709): the relay serves a machine's install script and Host bundle only as a live proxy to the user's own app.
// The app's host lane registers a boot id (`host.boot`, at most PENDING per account, 15 minutes); `GET /v1/boot/<id>` and
// `GET /v1/boot/<id>/bundle/<build>` (bare `/bundle` from an app of before builds) are then asked of that lane (`boot.request`), which answers in `boot.data` messages streamed into
// the HTTP response. Nothing is stored: a boot lives in this process's memory, its bytes pass through, and the script is served
// once and the bundle at most BUNDLE_TIMES. The script URL always answers a shell script, so `curl -fsSL … | sh` prints a
// one-line reason (the app is offline, the command expired) instead of curl's bare HTTP error.
// Those bytes are chosen by whoever registered the boot, so (finding H-2, docs/host-threat-model.md) a relay given BOOT_ORIGIN serves
// boots only on that host, never on its own, and tells the app where in `host.boot`'s answer; an account may start a bounded number
// of boots a day; and each download is logged with its account, boot, size and how it ended.
import { randomBytes } from 'node:crypto';
import { clientAddress } from './address.mjs';

/** @typedef {import('./hub.mjs').Hub} Hub */
/** @typedef {import('./connection.mjs').Conn} Conn */

export const BOOT_ID = /^b_[A-Za-z0-9_-]{22,64}$/;
const HOST_ID = /^h_[A-Za-z0-9_-]{16,64}$/;
/** The machine's build is the app's to judge: the relay only carries the name, which is short and plain. */
const PATH = /^\/v1\/boot\/(b_[A-Za-z0-9_-]{22,64})(\/bundle(?:\/([a-z0-9-]{1,32}))?)?$/;
/** The script's own report of why it stopped (`GET /v1/boot/<id>/report/<code>`): a short code the app words for its card, forwarded and never stored. */
const REPORT = /^\/v1\/boot\/(b_[A-Za-z0-9_-]{22,64})\/report\/([a-z_]{1,24})$/;
/** Reports one boot passes on: the script sends one, so a few cover a retry and no more. */
export const REPORT_TIMES = 3;
/** Boots one account may have waiting. */
export const PENDING = 5;
/** Boots one account may start in a day, by default (`BOOTS_PER_DAY`). */
export const PER_DAY = 20;
const DAY_MS = 24 * 3600_000;
export const BOOT_MS = 15 * 60_000;
export const BUNDLE_TIMES = 3;
/** The most a response may carry: a script, and a bundle. */
export const MAX_SCRIPT = 128 * 1024;
export const MAX_BUNDLE = 64 * 1024 * 1024;
/** The most a response may have waiting unsent for a slow downloader. */
export const MAX_UNSENT = 8 * 1024 * 1024;
/** How long the app may take to start answering. */
export const FIRST_BYTE_MS = 20_000;

export const SAY = Object.freeze({
  offline: 'Open MoPilot on your Mac and try again.',
  gone: 'This command expired or was already used. In MoPilot, open Add machine › Add by command for a new one.',
  silent: 'MoPilot on your Mac did not answer. Keep it open and try again.',
  failed: 'MoPilot on your Mac could not send the installer. Try again from Add machine › Add by command.',
  moved: 'This command is from an older MoPilot. Update MoPilot on your Mac, then open Add machine › Add by command for a new one.',
});
/** What a boot answers carries: never shown as a page, and never sniffed as one. */
const SAFE = { 'x-content-type-options': 'nosniff', 'content-security-policy': 'sandbox', 'cache-control': 'no-store' };

/** A script that only says why and stops: what `curl … | sh` runs when there is nothing to install. @param {string} text */
export const sayScript = (text) => `#!/bin/sh\necho 'MoPilot: ${text.replace(/'/g, `'\\''`)}' >&2\nexit 1\n`;

/** The host of an origin (`https://boot.example`), or null. @param {string | null} origin */
const hostOf = (origin) => (origin ? new URL(origin).host : null);

/**
 * The boots of this relay process.
 * @param {{ now: () => number, origin?: string | null, perDay?: number, log?: (event: string, data: object) => void }} o `origin`:
 * where boots are served (config.bootOrigin), none: on any host this relay answers
 */
export function createBoots({ now, origin = null, perDay = PER_DAY, log = () => undefined }) {
  const bootHost = hostOf(origin);
  /** @type {Map<string, { userId: string, laneId: string, hostId: string, expires: number, script: number, bundle: number, report: number }>} */
  const boots = new Map();
  /** When each account started its boots of the last day. @type {Map<string, number[]>} */
  const started = new Map();
  /** HTTP responses waiting on a lane's answer. @type {Map<string, { res: import('node:http').ServerResponse, laneId: string, bytes: number, max: number, started: boolean, timer: any, what: string, boot: string }>} */
  const waiting = new Map();
  /**
   * One line per download (`boot_serve`): the lane that registered the boot (its device id names the account, as `connect` lines
   * do), which boot (its first characters: the whole id is a capability while it lives), script or bundle, its size and how it
   * ended. A boot id nobody registered names no one and is not logged: a scanner's guesses would only fill the log.
   * @param {{ laneId: string, boot: string, what: string, bytes: number }} w @param {string} outcome
   */
  const logged = (w, outcome) => {
    const boot = w.boot.slice(0, 10);
    if (w.laneId) log('boot_serve', { device: w.laneId, boot, kind: w.what, bytes: w.bytes, outcome });
  };
  const sweep = () => {
    for (const [id, b] of boots) if (now() >= b.expires) boots.delete(id);
    // an account whose last start is a day old holds nothing, so the map does not grow with every account that ever booted
    for (const [userId, day] of started) if (now() - day[day.length - 1] >= DAY_MS) started.delete(userId);
  };

  /** Ends a waiting response: what the script says (or a status for the bundle) when nothing was sent yet. @param {string} req @param {keyof typeof SAY} why @param {string} [outcome] what the log says (`sent`: the lane finished) */
  function end(req, why, outcome = why) {
    // every caller holds a request still waiting (a response that closed was forgotten with its timer)
    const w = /** @type {NonNullable<ReturnType<typeof waiting.get>>} */ (waiting.get(req));
    waiting.delete(req);
    clearTimeout(w.timer);
    logged(w, outcome);
    if (w.started) return void w.res.end();
    if (w.what === 'script') return void w.res.writeHead(200, { 'content-type': 'text/x-shellscript', ...SAFE }).end(sayScript(SAY[why]));
    w.res.writeHead(why === 'offline' ? 503 : why === 'gone' || why === 'moved' ? 404 : 502, SAFE).end();
  }

  /** @param {Hub} hub @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res @param {RegExpExecArray} m */
  function report(hub, req, res, m) {
    sweep();
    const b = boots.get(m[1]);
    const lane = b ? hub.conns.get(b.laneId) : undefined;
    const moved = bootHost !== null && req.headers.host !== bootHost;
    if (moved || !b || !lane || b.report >= REPORT_TIMES) return void res.writeHead(404, SAFE).end();
    b.report++;
    const ip = clientAddress(req, hub.config.trustProxy);
    void hub.send(lane, {
      t: 'event',
      ev: 'boot.request',
      boot: m[1],
      req: randomBytes(9).toString('base64url'),
      what: 'report',
      code: m[2],
      ip,
    });
    res.writeHead(204, SAFE).end();
  }

  return {
    /** For tests and metrics: boots waiting. */
    get size() {
      sweep();
      return boots.size;
    },
    /** Where boots are served, which `host.boot`'s answer tells the app; null: wherever this relay is reached. */
    origin,
    /** Whether `req` came to the boot host (with BOOT_ORIGIN set), which serves boots and nothing else. @param {import('node:http').IncomingMessage} req */
    onBootHost: (req) => bootHost !== null && req.headers.host === bootHost,
    /**
     * `host.boot` { boot, host } from a host lane: the boot id the app shows in its command, for the Host id it registered.
     * @param {Conn} conn @param {any} m
     * @returns {'ok' | 'bad_message' | 'boot_limit' | 'boot_quota' | 'boot_exists'}
     */
    register(conn, m) {
      sweep();
      if (typeof m.boot !== 'string' || !BOOT_ID.test(m.boot) || typeof m.host !== 'string' || !HOST_ID.test(m.host)) return 'bad_message';
      if (boots.has(m.boot)) return 'boot_exists';
      const { userId, deviceId } = conn.identity;
      if ([...boots.values()].filter((b) => b.userId === userId).length >= PENDING) return 'boot_limit';
      // a day's boots, so the path is not a file drop: what a boot serves is the registering account's to choose
      const day = (started.get(userId) ?? []).filter((at) => now() - at < DAY_MS);
      started.set(userId, day);
      if (day.length >= perDay) return 'boot_quota';
      day.push(now());
      boots.set(m.boot, { userId, laneId: deviceId, hostId: m.host, expires: now() + BOOT_MS, script: 0, bundle: 0, report: 0 });
      return 'ok';
    },
    /** `host.unboot` { boot }: the app is done with it (Allow, Deny, the card closed). @param {Conn} conn @param {any} m */
    unregister(conn, m) {
      const b = typeof m.boot === 'string' ? boots.get(m.boot) : undefined;
      if (b && b.laneId === conn.identity.deviceId) boots.delete(m.boot);
    },
    /**
     * A GET of a boot path: asks the app's lane for the script or the bundle, and streams its answer. False when the path is not a boot's.
     * A report (the script says why it stopped) is passed to the lane as `boot.request` `what: 'report'` and answered 204 at once, or 404 when the boot is gone.
     * @param {Hub} hub @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res @param {string} path
     */
    serve(hub, req, res, path) {
      const rep = req.method === 'GET' ? REPORT.exec(path) : null;
      if (rep) return report(hub, req, res, rep), true;
      const m = req.method === 'GET' ? PATH.exec(path) : null;
      if (!m) return false;
      sweep();
      const what = m[2] ? 'bundle' : 'script';
      const req2 = randomBytes(9).toString('base64url');
      const b = boots.get(m[1]);
      const lane = b ? hub.conns.get(b.laneId) : undefined;
      // with a boot host, this relay's own host serves none: a link to it is no one's installer
      const moved = bootHost !== null && req.headers.host !== bootHost;
      waiting.set(req2, {
        boot: m[1],
        res,
        laneId: b?.laneId ?? '',
        bytes: 0,
        max: what === 'script' ? MAX_SCRIPT : MAX_BUNDLE,
        started: false,
        timer: null,
        what,
      });
      if (moved) return end(req2, 'moved'), true;
      if (!b || (what === 'script' ? b.script >= 1 : b.bundle >= BUNDLE_TIMES)) return end(req2, 'gone'), true;
      if (!lane) return end(req2, 'offline'), true;
      if (what === 'script') b.script++;
      else b.bundle++;
      const w = /** @type {any} */ (waiting.get(req2));
      w.timer = setTimeout(() => end(req2, 'silent'), FIRST_BYTE_MS);
      w.timer.unref?.();
      res.on('close', () => waiting.get(req2)?.res === res && (waiting.delete(req2), clearTimeout(w.timer), logged(w, 'closed')));
      void hub.send(lane, {
        t: 'event',
        ev: 'boot.request',
        boot: m[1],
        req: req2,
        what,
        ip: clientAddress(req, hub.config.trustProxy),
        ...(m[3] && { build: m[3] }),
      });
      return true;
    },
    /**
     * `boot.data` { req, data, end?, failed? } from the lane that was asked: bytes for the waiting response (base64), its end, or a refusal.
     * A message for a request that is not this lane's, or past the response's cap, ends it.
     * @param {Conn} conn @param {any} m
     */
    data(conn, m) {
      const w = typeof m.req === 'string' ? waiting.get(m.req) : undefined;
      if (!w || w.laneId !== conn.identity.deviceId) return;
      if (m.failed === true) return end(m.req, 'failed');
      const bytes = typeof m.data === 'string' && m.data ? Buffer.from(m.data, 'base64') : Buffer.alloc(0);
      w.bytes += bytes.length;
      if (w.bytes > w.max) return end(m.req, 'failed');
      if (!w.started) {
        w.started = true;
        clearTimeout(w.timer);
        w.res.writeHead(200, { 'content-type': w.what === 'script' ? 'text/x-shellscript' : 'application/gzip', ...SAFE });
      }
      if (bytes.length) w.res.write(bytes);
      // a downloader that does not read is dropped rather than buffered for: its bytes would wait in this process
      if (w.res.writableLength > MAX_UNSENT) {
        waiting.delete(m.req);
        logged(w, 'dropped');
        return void w.res.destroy();
      }
      if (m.end === true) end(m.req, 'failed', 'sent');
    },
    /** A lane went: whatever it was asked fails now. @param {string} laneId */
    laneGone(laneId) {
      for (const [req, w] of [...waiting]) if (w.laneId === laneId) end(req, 'offline');
    },
  };
}
