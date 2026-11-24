// The relay's network edge: an HTTP server with the WSS endpoint (/v1/ws, authenticated by the account JWT at upgrade),
// the signed revocation endpoint (POST /v1/revoke), the account purge (POST /v1/account/purge), the account switch (POST /v1/account/access) and a health check, wired to the Hub with the ping and sweep timers.
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { MAX_MESSAGE_BYTES } from './frames.mjs';
import { Hub } from './hub.mjs';
import { apnsSetsOf } from './config.mjs';
import { Metrics } from './metrics.mjs';
import { createOps } from './ops.mjs';
import { digestOf, purgeAccount } from './purge.mjs';
import { PushService } from './push.mjs';
import { Store } from './store.mjs';
import { messageOf } from './processGuards.mjs';
import { isHostToken, laneOf, verifyHost } from './hosts.mjs';
import { clientAddress } from './address.mjs';
import { accountDisabled, closeOf, countRefusal, setAccountAccess } from './access.mjs';
import { serveRendezvous } from './rendezvousHttp.mjs';

/** The path of a request; a request target that is not a URL ('//', '//[') has none. */
const pathOf = (/** @type {http.IncomingMessage} */ req) => {
  try {
    return new URL(String(req.url), 'http://relay').pathname;
  } catch {
    return null;
  }
};

/** The answer to a request whose handler failed: a 500, or the connection dropped when the answer had already begun. */
export const failRequest = (/** @type {http.ServerResponse} */ res) => (res.headersSent ? res.destroy() : void res.writeHead(500).end());

/** What a purge request may carry: the device ids of one account. */
const PURGE_BODY_BYTES = 64 * 1024;
const PURGE_MAX_DEVICES = 500;
/** How long a socket the relay took only to refuse may stay before it is ended, whatever its client does. */
const REFUSED_LINGER_MS = 2000;

/** A request's JSON body, or null when it is too large or not JSON. */
async function readJson(/** @type {http.IncomingMessage} */ req, /** @type {number} */ max) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) return null;
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return null;
  }
}

const bearer = (/** @type {http.IncomingMessage} */ req) => /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1] ?? null;

/**
 * @param {object} o
 * @param {import('./config.mjs').RelayConfig} o.config
 * @param {import('./store.mjs').Db} o.db
 * @param {{ verify: Function, verifyRevocation(token: string): Promise<{ userId: string, deviceId: string } | null>, verifyPurge?(token: string): Promise<{ userId: string, digest: string } | null>, verifyAccess?(token: string): Promise<{ userId: string, disabled: boolean, atMs: number } | null> }} o.verifier
 * @param {import('./push.mjs').PushSend | null} o.send null turns push off
 * @param {() => number} [o.now]
 * @param {(event: string, data: object) => void} [o.log]
 * @param {import('./durableStore.mjs').DurableStore | null} [o.durable] keeps frames until acked; null is the plain mailbox
 * @param {Metrics} [o.metrics] where events are counted (the push senders count into the same one)
 * @param {number} [o.refusedLingerMs] how long a socket taken only to be refused may stay
 */
export function createRelay({
  config,
  db,
  verifier,
  send,
  now = Date.now,
  log,
  durable,
  metrics = new Metrics(),
  refusedLingerMs = REFUSED_LINGER_MS,
}) {
  const store = new Store(db);
  const push = new PushService({ store, send, now, metrics, log, apns: apnsSetsOf(config.push) });
  const hub = new Hub({ store, push, verifier: /** @type {any} */ (verifier), config, now, log, durable: durable ?? undefined, metrics });
  const ops = createOps({
    db,
    hub,
    metrics,
    metricsToken: config.metricsToken,
    durable: !!durable,
    healthTimeoutMs: config.healthTimeoutMs,
    now,
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });

  /**
   * Takes an upgrade only to say no in a close code its client can read (a refused upgrade reads to a WebSocket client as a bare
   * network error, which it dials again at once). The socket never reaches the hub: whatever it sends is dropped (a frame that breaks
   * the protocol is that socket's error, not the relay's), and it is ended shortly whether or not its client answers the close.
   */
  const refuse = (
    /** @type {http.IncomingMessage} */ req,
    /** @type {import('node:net').Socket} */ socket,
    /** @type {Buffer} */ head,
    /** @type {number} */ code,
    /** @type {string} */ reason,
  ) =>
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on('error', () => ws.terminate());
      ws.close(code, reason);
      setTimeout(() => ws.terminate(), refusedLingerMs).unref();
    });

  /** Whatever a client sends, an error here is that request's: it is logged and answered, never an uncaught exception that ends the relay. */
  const guarded =
    (/** @type {(...args: any[]) => Promise<void>} */ handler, /** @type {(...args: any[]) => void} */ fail) =>
    (/** @type {any[]} */ ...args) =>
      handler(...args).catch((e) => (log?.('error', { message: messageOf(e) }), fail(...args)));

  /** POST /v1/account/purge: the account service deleted a user; body {deviceIds}, signed with the purge audience. 200 {devices, pairs}; the sender retries a 5xx. */
  const purge = async (/** @type {http.IncomingMessage} */ req, /** @type {http.ServerResponse} */ res) => {
    const who = await verifier.verifyPurge?.(bearer(req) ?? '');
    if (!who) return void res.writeHead(401).end();
    const body = Number(req.headers['content-length']) > PURGE_BODY_BYTES ? null : await readJson(req, PURGE_BODY_BYTES);
    const ids = body?.deviceIds;
    if (
      !Array.isArray(ids) ||
      ids.length > PURGE_MAX_DEVICES ||
      !ids.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 128)
    )
      return void res.writeHead(400, { connection: 'close' }).end();
    // the ids must be the ones the signed token names
    if (digestOf(ids) !== who.digest) return void res.writeHead(403, { connection: 'close' }).end();
    const done = await purgeAccount(hub, { userId: who.userId, deviceIds: ids });
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(done));
  };

  const server = http.createServer(
    guarded(
      async (req, res) => {
        const path = pathOf(req);
        // the boot host serves boots and nothing else (boot.mjs)
        if (hub.boots.onBootHost(req)) return void (hub.boots.serve(hub, req, res, path ?? '') || res.writeHead(404).end());
        if (await ops.handle(req, res, path ?? '')) return;
        if (req.method === 'POST' && path === '/v1/revoke') {
          const who = await verifier.verifyRevocation(bearer(req) ?? '');
          if (!who) return void res.writeHead(401).end();
          // the sender retries a 5xx; a database error must not take the process down
          await hub.revoke(who).then(
            () => res.writeHead(204).end(),
            (e) => (log?.('error', { message: messageOf(e) }), res.writeHead(500).end()),
          );
        } else if (req.method === 'POST' && path === '/v1/account/purge') {
          await purge(req, res);
        } else if (req.method === 'POST' && path === '/v1/account/access') {
          // the account service switched an account's relay access off or on; it sends the request again after a 5xx
          const change = await verifier.verifyAccess?.(bearer(req) ?? '');
          if (!change) return void res.writeHead(401).end();
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(await setAccountAccess(hub, change)));
        } else if (
          path?.startsWith('/v1/rendezvous/') &&
          (await serveRendezvous({ req, res, path, hub, verifier, trustProxy: config.trustProxy }))
        ) {
          // answered
        } else if (!hub.boots.serve(hub, req, res, path ?? '')) {
          res.writeHead(404).end();
        }
      },
      (_req, res) => failRequest(res),
    ),
  );

  /**
   * Who an upgrade is from: a Host by its credential, else an account token, on the host lane when the URL asks for it (`?as=hostlink`, desktops and phones).
   * @param {http.IncomingMessage} req
   */
  const identify = async (req) => {
    const token = bearer(req) ?? '';
    if (isHostToken(token)) return verifyHost(hub, token, clientAddress(req, config.trustProxy));
    const identity = await verifier.verify(token);
    if (new URL(String(req.url), 'http://relay').searchParams.get('as') !== 'hostlink') return identity;
    return identity?.kind === 'desktop' || identity?.kind === 'phone' ? laneOf(identity) : null;
  };

  const upgrade = async (
    /** @type {http.IncomingMessage} */ req,
    /** @type {import('node:net').Socket} */ socket,
    /** @type {Buffer} */ head,
  ) => {
    // the server stops listening for socket errors once it hands over an upgrade: a client that resets while its token is checked would
    // otherwise be an uncaught exception that ends the whole relay (ws takes over the socket's errors once it has it)
    socket.on('error', () => socket.destroy());
    if (hub.draining) {
      socket.end('HTTP/1.1 503 Service Unavailable\r\nRetry-After: 2\r\nConnection: close\r\n\r\n', () => socket.destroy());
      return;
    }
    // the boot host serves boots and nothing else: no socket either
    const found = pathOf(req) === '/v1/ws' && !hub.boots.onBootHost(req) ? await identify(req) : null;
    if (found === 'limited') {
      socket.end('HTTP/1.1 429 Too Many Requests\r\nRetry-After: 10\r\nConnection: close\r\n\r\n', () => socket.destroy());
      return;
    }
    if (found === 'revoked') {
      // a Host whose credential is gone hears so in a close code it can read, and stops dialing
      refuse(req, socket, head, 4403, 'revoked');
      return;
    }
    const identity = found;
    if (!identity) {
      // ended and then destroyed: a client that never closes its half would otherwise hold the socket for good (no HTTP timeout applies after an upgrade)
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n', () => socket.destroy());
      return;
    }
    // the client went away while its token was checked
    if (socket.destroyed) return;
    // a full relay, an account at its device cap or one switched off is refused before the hub takes the socket; the hub decides again
    // once it starts. The caps are read from memory first: a full relay asks the database nothing about the sockets it turns away
    const refused = hub.refusal(identity) ?? ((await accountDisabled(hub, identity)) ? 'account_disabled' : null);
    if (socket.destroyed) return;
    if (refused) countRefusal(hub, refused);
    if (refused === 'restarting') {
      socket.end('HTTP/1.1 503 Service Unavailable\r\nRetry-After: 2\r\nConnection: close\r\n\r\n', () => socket.destroy());
      return;
    }
    if (refused) {
      // a refused socket is outside the caps, so a device that keeps dialing is held to its connect rate here: past it the upgrade is
      // answered in plain HTTP, which costs no handshake and holds no socket (the shipped apps wait 15 s or more and never get here)
      if (hub.connectBuckets.get(identity.deviceId).tryTake() > 0) {
        socket.end('HTTP/1.1 429 Too Many Requests\r\nRetry-After: 10\r\nConnection: close\r\n\r\n', () => socket.destroy());
        return;
      }
      refuse(req, socket, head, ...closeOf(refused));
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const handlers = hub.connect(ws, identity);
      ws.on('message', (data, isBinary) => (isBinary ? ws.close(1003, 'text only') : handlers.message(data.toString())));
      ws.on('pong', handlers.pong);
      ws.on('close', handlers.close);
      ws.on('error', () => {
        // a message over the size limit has already started a close with the reason (1009): let it be sent, then end the socket whatever the other side does
        if (ws.readyState === ws.CLOSING) setTimeout(() => ws.terminate(), 1000).unref();
        else ws.terminate();
      });
    });
  };
  server.on(
    'upgrade',
    guarded(upgrade, (_req, socket) => socket.destroy()),
  );

  /** @type {NodeJS.Timeout[]} */
  const timers = [];

  async function close() {
    ops.stop();
    for (const t of timers) clearInterval(t);
    for (const c of wss.clients) c.terminate();
    const done = new Promise((r) => server.close(r));
    // keep-alive HTTP connections (health checks, revocations) would hold the close open
    server.closeAllConnections();
    await done;
  }

  /** Stops the service the way a deploy does: see Hub.shutdown. The sockets get a moment to take their 1012 before the listener goes. */
  async function shutdown({ graceMs = 8000 } = {}) {
    for (const t of timers) clearInterval(t);
    await hub.shutdown({ graceMs });
    const closing = [...wss.clients].map((c) => new Promise((resolve) => c.once('close', resolve)));
    await Promise.race([Promise.all(closing), new Promise((resolve) => setTimeout(resolve, Math.min(1000, graceMs)).unref())]);
    await close();
  }

  return {
    store,
    hub,
    metrics,
    server,
    wss,
    /** @returns {Promise<number>} the port it listens on */
    listen(port = config.port, host = config.host) {
      ops.start();
      timers.push(
        setInterval(() => {
          try {
            hub.tick();
          } catch (e) {
            log?.('error', { message: messageOf(e) });
          }
        }, config.pingMs).unref(),
      );
      timers.push(setInterval(() => hub.sweep().catch((e) => log?.('error', { message: messageOf(e) })), config.sweepMs).unref());
      return new Promise((resolve) =>
        server.listen(port, host, () => resolve(/** @type {import('node:net').AddressInfo} */ (server.address()).port)),
      );
    },
    shutdown,
    close,
  };
}
