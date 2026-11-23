// DEV ONLY: the journey's hands on the dev host: types commands into its input FIFO, reads its log and its pairing code.
import fs from 'node:fs';
import fsp from 'node:fs/promises';

const PAUSE = (/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** When a file was last written (0 when it is not there yet); any other failure to read it is a failure. */
async function mtimeOf(/** @type {string} */ file) {
  try {
    return (await fsp.stat(file)).mtimeMs;
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return 0;
    throw error;
  }
}

export class JourneyHost {
  /** @param {{ fifo: string, log: string, codeFile: string, sleep?: (ms: number) => Promise<void>, now?: () => number }} o */
  constructor({ fifo, log, codeFile, sleep = PAUSE, now = Date.now }) {
    this.fifo = fifo;
    this.log = log;
    this.codeFile = codeFile;
    this.sleep = sleep;
    this.now = now;
  }

  /** One line of input for the host (`r`, `run plan`, `y`). */
  send(/** @type {string} */ line) {
    let fd;
    try {
      // non-blocking, so a host that is not running fails here instead of hanging the journey
      fd = fs.openSync(this.fifo, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
    } catch {
      throw new Error(`the dev host is not reading ${this.fifo}; start it with scripts/mobile-ios-journey.sh host start`);
    }
    try {
      fs.writeSync(fd, `${line}\n`);
    } finally {
      fs.closeSync(fd);
    }
  }

  /** Where the log is now, so a wait looks only at what comes after. */
  mark() {
    return fs.statSync(this.log).size;
  }

  /** The first match of the pattern in the log after `since`. @param {RegExp} pattern @param {{ since?: number, timeoutMs?: number }} [o] */
  async waitLog(pattern, { since = 0, timeoutMs = 20_000 } = {}) {
    const end = this.now() + timeoutMs;
    for (;;) {
      // `since` is a byte offset (mark), and the log holds multi-byte characters
      const text = (await fsp.readFile(this.log)).subarray(since).toString('utf8');
      const found = text.match(pattern);
      if (found) return found;
      if (this.now() >= end) throw new Error(`the dev host log did not show ${pattern} within ${timeoutMs / 1000}s`);
      await this.sleep(300);
    }
  }

  /** A fresh pairing code: asks the host for one and takes the file only once it was written after the ask (an earlier write is a code the ask replaces). */
  async newPairingCode() {
    const askedAt = this.now();
    this.send('r');
    const end = askedAt + 10_000;
    for (;;) {
      const at = await mtimeOf(this.codeFile);
      // a read between the host's truncate and its write sees an empty file: ask the file again
      if (at >= askedAt) {
        const code = (await fsp.readFile(this.codeFile, 'utf8')).trim();
        if (code) return code;
      }
      if (this.now() >= end) throw new Error(`the dev host did not write a new pairing code to ${this.codeFile}`);
      await this.sleep(200);
    }
  }
}
