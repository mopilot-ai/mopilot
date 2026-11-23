// Own a private Unix listener through secure publication, startup failure, cancellation and replacement.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { noteIgnored } = require('../ignored.cjs');

class PrivateSocketListener {
  constructor({ prefix, createServer, tmpdir = os.tmpdir }) {
    this.options = { prefix, createServer, tmpdir };
    this.attempt = null;
    this.server = null;
    this.dir = null;
    this.path = null;
    this.listening = null;
  }

  listen() {
    if (this.listening) return this.listening;
    const attempt = {
      server: null,
      dir: null,
      closed: false,
      cancel: () => {
        /* no bind until setup succeeds */
      },
    };
    this.attempt = attempt;
    const listening = this.#start(attempt);
    this.listening = listening;
    listening.catch(() => {
      if (this.listening === listening) this.listening = null;
    });
    return listening;
  }

  async #start(attempt) {
    let file;
    try {
      attempt.dir = fs.mkdtempSync(path.join(this.options.tmpdir(), this.options.prefix));
      this.dir = attempt.dir;
      fs.chmodSync(attempt.dir, 0o700);
      file = path.join(attempt.dir, 's.sock');
      const server = this.options.createServer();
      attempt.server = server;
      this.server = server;
      await new Promise((resolve, reject) => {
        let settled = false;
        const finish = (ok, error) => {
          if (settled) return;
          settled = true;
          if (ok) resolve(undefined);
          else reject(error);
        };
        attempt.cancel = () => finish(false, new Error('The private socket was closed while opening.'));
        // A bind error already queued before close still needs a listener after cancellation.
        server.on('error', (error) => {
          if (settled) noteIgnored('receive a private socket listener error', error);
          else finish(false, error);
        });
        server.listen(file, () => {
          if (settled) return;
          try {
            fs.chmodSync(file, 0o600);
            finish(true, null);
          } catch (error) {
            finish(false, error);
          }
        });
      });
      if (this.attempt !== attempt) throw new Error('The private socket was closed while opening.');
      this.path = file;
    } catch (error) {
      this.#dispose(attempt);
      throw error;
    }
    return file;
  }

  #dispose(attempt) {
    if (attempt.closed) return;
    attempt.closed = true;
    attempt.cancel();
    if (this.attempt === attempt) {
      this.attempt = null;
      this.server = null;
      this.dir = null;
      this.path = null;
      this.listening = null;
    }
    try {
      attempt.server?.close();
    } finally {
      attempt.server?.closeAllConnections?.();
      if (attempt.dir) fs.rmSync(attempt.dir, { recursive: true, force: true });
    }
  }

  close() {
    if (this.attempt) this.#dispose(this.attempt);
  }
}
module.exports = { PrivateSocketListener };
