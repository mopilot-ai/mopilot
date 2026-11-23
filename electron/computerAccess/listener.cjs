// Computer access (#1364): the socket this Mac listens on for paired devices: on 127.0.0.1 unless the person allowed
// other computers on the network, on its usual port when it is free. It turns away a browser page (which always sends
// an Origin), any other path, too many handshakes at once and a source that keeps trying, and hands each accepted
// WebSocket on, taking only small messages until the device proves its key (hostConnection.cjs raises the limit).
const { noteIgnored } = require('../ignored.cjs');

/** The path a device connects to. */
const SOCKET_PATH = '/mopilot-access';
/** The port this Mac tries first, so a paired device finds it again after a restart. */
const PREFERRED_PORT = 47616;
/** The largest message before the handshake is done (a hello or a confirmation is a few hundred bytes). */
const HANDSHAKE_BYTES = 16 * 1024;
/** How many connections may be in their handshake at once, and how many a source may start a minute. */
const HANDSHAKES_MAX = 8;
const ATTEMPTS_PER_MINUTE = 30;

class AccessListener {
  /**
   * @param {{ options: () => { http?: Pick<typeof import('node:http'), 'createServer'>, port?: number,
   *     lanAddress?: () => string | null, accept: (req: any, socket: any, head: Buffer, o: { maxBytes: number }) => any },
   *   wanted: () => boolean, handshaking: () => number, onSocket: (ws: any) => void, now: () => number }} o
   *   options: read at each use (tests swap them); handshaking: connections still in their handshake
   */
  constructor(o) {
    this.o = o;
    /** @type {import('node:http').Server | null} */
    this.server = null;
    /** @type {{ address: string, port: number } | null} */
    this.listening = null;
    /** @type {string | null} the interface the server is bound to */
    this.boundTo = null;
    /** source address -> when its recent connections started (the last minute) */
    this.attempts = new Map();
  }

  /**
   * Opens the server on `host`; resolves once it listens, or without listening when access went off meanwhile.
   * @param {string} host
   */
  async open(host) {
    const opts = this.o.options();
    const http = opts.http ?? require('node:http');
    const server = http.createServer((_req, res) => {
      res.writeHead(404).end();
    });
    server.on('upgrade', (req, socket, head) => this.#upgrade(req, socket, head));
    server.on('error', (error) => noteIgnored('run the computer access listener', error));
    const listen = (port) =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolve(/** @type {any} */ (server.address()).port);
        });
      });
    let port;
    try {
      port = await listen(opts.port ?? PREFERRED_PORT).catch((error) => {
        // the usual port is taken: any free one (a paired device is told the new one when it pairs again)
        if (/** @type {any} */ (error)?.code !== 'EADDRINUSE') throw error;
        return listen(0);
      });
    } catch (error) {
      server.close();
      throw error;
    }
    // turned off while it was opening
    if (!this.o.wanted()) {
      server.close();
      return false;
    }
    this.server = server;
    this.boundTo = host;
    this.listening = { address: host === '0.0.0.0' ? (opts.lanAddress?.() ?? host) : host, port };
    return true;
  }

  /** Stops accepting connections (the ones already open are the host's to end). True when it was listening. */
  async close() {
    const server = this.server;
    this.server = null;
    this.listening = null;
    this.boundTo = null;
    if (server) await new Promise((resolve) => server.close(() => resolve(undefined)));
    return !!server;
  }

  /** Whether a new connection from `address` may start its handshake now; counts it when it may. */
  #admit(address) {
    const now = this.o.now();
    const recent = (this.attempts.get(address) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= ATTEMPTS_PER_MINUTE || this.o.handshaking() >= HANDSHAKES_MAX) return false;
    this.attempts.set(address, [...recent, now]);
    return true;
  }

  #upgrade(req, socket, head) {
    // a page in a browser on this Mac always sends an Origin: a device never does
    if (!this.listening || req.url !== SOCKET_PATH || req.headers.origin) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    // nobody proved anything yet: few handshakes at once and a few a minute from one source
    if (!this.#admit(socket.remoteAddress ?? '')) {
      socket.end('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n');
      return;
    }
    const ws = this.o.options().accept(req, socket, head, { maxBytes: HANDSHAKE_BYTES });
    if (ws) this.o.onSocket(ws);
  }
}

module.exports = { AccessListener, SOCKET_PATH, PREFERRED_PORT, HANDSHAKE_BYTES, HANDSHAKES_MAX, ATTEMPTS_PER_MINUTE };
