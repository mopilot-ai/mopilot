// The CDP pipe of a Chromium started with --remote-debugging-pipe: JSON messages, each ended by a NUL byte, written to its fd 3 and read from its fd 4 (no TCP port exists to reach it by).

/** The longest message either side may send; a screenshot's base64 is the largest thing that crosses. */
export const MAX_MESSAGE = 64 * 1024 * 1024;

export class PipeError extends Error {
  /** @param {'too-large' | 'not-json' | 'closed'} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = 'PipeError';
    this.code = code;
  }
}

/**
 * A decoder for the bytes from Chromium: `push` them as they arrive and take the messages they complete. It throws a
 * PipeError on a message that is not a JSON value or is larger than `maxMessage`.
 * @param {{ maxMessage?: number }} [o]
 */
export function createPipeDecoder({ maxMessage = MAX_MESSAGE } = {}) {
  /** @type {Buffer[]} */
  let held = [];
  let size = 0;
  return {
    /** @param {Uint8Array} chunk @returns {any[]} */
    push(chunk) {
      /** @type {any[]} */
      const out = [];
      let rest = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      for (let end = rest.indexOf(0); end >= 0; end = rest.indexOf(0)) {
        const message = Buffer.concat([...held, rest.subarray(0, end)]);
        held = [];
        size = 0;
        rest = rest.subarray(end + 1);
        if (message.length > maxMessage) throw new PipeError('too-large', 'A message is larger than allowed.');
        try {
          out.push(JSON.parse(message.toString('utf8')));
        } catch {
          throw new PipeError('not-json', 'A message is not JSON.');
        }
      }
      if (rest.length > 0) {
        held.push(rest);
        size += rest.length;
        if (size > maxMessage) throw new PipeError('too-large', 'A message is larger than allowed.');
      }
      return out;
    },
  };
}

/**
 * The two ends of a pipe as one connection: `send` writes a message, `onMessage` hears the ones Chromium sends, `onClose`
 * hears the pipe end (either side closing it, a write failing or a malformed message, which is a protocol error that cuts it).
 * @param {{ read: import('node:stream').Readable, write: import('node:stream').Writable, maxMessage?: number }} o
 */
export function createCdpPipe({ read, write, maxMessage }) {
  const decoder = createPipeDecoder({ maxMessage });
  /** @type {Set<(message: any) => void>} */
  const messageFns = new Set();
  /** @type {Set<(why: string) => void>} */
  const closeFns = new Set();
  let closed = false;
  /** @param {string} why */
  const close = (why) => {
    if (closed) return;
    closed = true;
    read.destroy();
    write.destroy();
    for (const fn of [...closeFns]) fn(why);
    closeFns.clear();
    messageFns.clear();
  };
  read.on('data', (chunk) => {
    let messages;
    try {
      messages = decoder.push(chunk);
    } catch (e) {
      return close(/** @type {PipeError} */ (e).code);
    }
    for (const message of messages) for (const fn of [...messageFns]) fn(message);
  });
  read.on('end', () => close('ended'));
  read.on('close', () => close('ended'));
  read.on('error', () => close('error'));
  write.on('error', () => close('error'));
  return {
    /** @param {object} message */
    send(message) {
      if (closed) throw new PipeError('closed', 'The pipe is closed.');
      write.write(Buffer.concat([Buffer.from(JSON.stringify(message)), Buffer.from([0])]));
    },
    /** @param {(message: any) => void} fn */
    onMessage(fn) {
      messageFns.add(fn);
      return () => void messageFns.delete(fn);
    },
    /** @param {(why: string) => void} fn */
    onClose(fn) {
      closeFns.add(fn);
      return () => void closeFns.delete(fn);
    },
    close: () => close('closed'),
    get closed() {
      return closed;
    },
  };
}
