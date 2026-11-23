// Files and recordings a phone sends in parts: each stream is put together in order, within the Chrome panel's attachment limits, and forgotten when it is finished, abandoned or too old.
const { RemoteError } = require('./serviceErrors.cjs');
const { uploadOwner } = require('./attachmentOwners.cjs');
const { MAX_FILE_BYTES, MAX_AUDIO_BYTES } = require('../../shared/remote/schema.mjs');
/** How long a stream may sit idle, and how many a client keeps open. */
const IDLE_MS = 10 * 60 * 1000;
const MAX_STREAMS = 8;

class ChunkStreams {
  /** @param {() => number} [now] */
  constructor(now = Date.now) {
    this.now = now;
    /** @type {Map<string, { purpose: string, total: number, next: number, parts: Buffer[], bytes: number, at: number, done?: Buffer }>} */
    this.streams = new Map();
  }

  #prune() {
    const old = this.now() - IDLE_MS;
    for (const [key, s] of this.streams) if (s.at < old) this.streams.delete(key);
  }

  /**
   * One part. A part already taken is acknowledged again (a retry after a dropped reply); one that skips ahead is refused
   * so the sender resends from `received`. Returns the parts taken and, once the last arrived, the whole as a Buffer.
   * @param {string} owner who sends (a pair)
   * @param {{ stream: string, index: number, total: number, data: string, purpose: 'file' | 'audio' }} c
   */
  add(owner, c) {
    this.#prune();
    const key = `${owner}:${c.stream}`;
    let s = this.streams.get(key);
    if (!s) {
      if (c.index !== 0) throw new RemoteError('stale', 'Send that upload again from the start.');
      const open = [...this.streams.keys()].filter((k) => k.startsWith(`${owner}:`)).length;
      if (open >= MAX_STREAMS) throw new RemoteError('failed', 'Too many uploads at once. Wait for one to finish.');
      s = { purpose: c.purpose, total: c.total, next: 0, parts: [], bytes: 0, at: this.now() };
      this.streams.set(key, s);
    }
    if (s.purpose !== c.purpose || s.total !== c.total) throw new RemoteError('stale', 'That upload id was used for something else.');
    s.at = this.now();
    if (c.index < s.next || s.done)
      return { received: s.next, done: !!s.done, ...(s.done && c.purpose === 'audio' ? { bytes: s.done.length } : {}) };
    if (c.index > s.next) throw new RemoteError('stale', `Resend from part ${s.next}.`);
    const part = Buffer.from(c.data, 'base64');
    s.bytes += part.length;
    if (s.bytes > (c.purpose === 'audio' ? MAX_AUDIO_BYTES : MAX_FILE_BYTES)) {
      this.streams.delete(key);
      throw new RemoteError(
        'invalid',
        c.purpose === 'audio' ? 'That recording is too long. Dictate in shorter parts.' : 'That file is larger than 20 MB.',
      );
    }
    s.parts.push(part);
    s.next += 1;
    if (s.next < s.total) return { received: s.next, done: false };
    const whole = Buffer.concat(s.parts);
    s.parts = [];
    if (c.purpose === 'file') {
      this.streams.delete(key);
      return { received: s.next, done: true, whole };
    }
    // a recording waits for chat.transcribe to take it
    s.done = whole;
    return { received: s.next, done: true, bytes: whole.length };
  }

  /** The finished recording of a stream, once; stale when it isn't finished or was already taken. */
  take(owner, /** @type {string} */ stream) {
    this.#prune();
    const key = `${owner}:${stream}`;
    const s = this.streams.get(key);
    if (!s?.done || s.purpose !== 'audio') throw new RemoteError('stale', 'That recording is no longer here. Record it again.');
    this.streams.delete(key);
    return s.done;
  }
}

/** One ChunkStreams per service, made when first needed. */
const STREAMS = new WeakMap();
const streamsOf = (/** @type {any} */ svc) => {
  let s = STREAMS.get(svc);
  if (!s) STREAMS.set(svc, (s = new ChunkStreams(svc.now)));
  return s;
};

/**
 * The recording a phone finished sending (it is taken once), transcribed on this Mac's own speech setup. `keep: false` leaves
 * the clip out of the recordings the Mac keeps, which is how a MoMo voice note goes (only its text is used).
 * @param {any} svc @param {any} client @param {{ stream: string, mime: string }} p @param {{ keep?: boolean }} [o]
 */
function transcribeUpload(svc, client, p, { keep = true } = {}) {
  const audio = streamsOf(svc).take(uploadOwner(client), p.stream);
  return svc.ops.dictation.transcribeClip({ audio, mime: p.mime, keep });
}

module.exports = { ChunkStreams, IDLE_MS, MAX_STREAMS, streamsOf, transcribeUpload };
