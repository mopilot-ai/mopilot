// A listener on 127.0.0.1 with the port the system picks, in the shape of PrivateSocketListener (./privateSocket.cjs): where Node can listen on no Unix socket (Windows), the address `127.0.0.1:<port>` stands in for its path.
const { noteIgnored } = require('../ignored.cjs');

const HOST = '127.0.0.1';

class LoopbackListener {
  /** @param {{ createServer: () => import('node:net').Server }} o */
  constructor({ createServer }) {
    this.createServer = createServer;
    /** @type {import('node:net').Server | null} */
    this.server = null;
    /** no folder holds a port: kept for the callers that read PrivateSocketListener's */
    this.dir = null;
    /** @type {string | null} the address, once listening */
    this.path = null;
    /** @type {Promise<string> | null} */
    this.listening = null;
    /** @type {() => unknown} fails the start still opening, if there is one */
    this.cancel = () => undefined;
  }

  /** Starts listening (once); resolves with `127.0.0.1:<port>`. A failed start leaves the next call free to try again. */
  listen() {
    if (this.listening) return this.listening;
    const server = this.createServer();
    this.server = server;
    const listening = new Promise((resolve, reject) => {
      let settled = false;
      const fail = (/** @type {Error} */ error) => {
        if (settled) return noteIgnored('receive a loopback listener error', error);
        settled = true;
        reject(error);
      };
      // a close while it was opening wins: Node then never says it is listening, so the close says so instead
      this.cancel = () => settled || fail(new Error('The loopback listener was closed while opening.'));
      server.on('error', fail);
      server.listen(0, HOST, () => {
        settled = true;
        this.path = `${HOST}:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`;
        resolve(this.path);
      });
    });
    this.listening = listening;
    listening.catch(() => {
      if (this.listening !== listening) return;
      this.listening = null;
      this.server = null;
    });
    return listening;
  }

  close() {
    this.cancel();
    const server = this.server;
    this.server = null;
    this.path = null;
    this.listening = null;
    // the connections it accepted are their owner's to end (socket.cjs ToolSocket.close)
    server?.close();
  }
}

module.exports = { LoopbackListener, HOST };
