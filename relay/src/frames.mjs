// The relay's wire format: validation of what clients send and encoding of what the relay sends. A frame is
// {pair, dir, ctr, nonce, box}; the relay checks its shape and size and never opens the box.

export const MAX_BOX_BYTES = 256 * 1024;
/** A JSON text message with a 256 KB box in base64 is about 350 KB; leave room for the envelope. */
export const MAX_MESSAGE_BYTES = 400 * 1024;
/** `cleared` is a Host's: its waiting card is gone (answered elsewhere, stopped or its turn ended), so the "needs you" notification is replaced by a quiet one that claims nothing else. */
export const PUSH_KINDS = ['needsYou', 'done', 'momoNeedsYou', 'machineOffline', 'cleared'];

const PAIR_ID = /^p_[A-Za-z0-9_-]{8,64}$/;
const B64 = /^[A-Za-z0-9+/_-]+={0,2}$/;

const bytes = (/** @type {unknown} */ v, /** @type {number} */ max) => {
  if (typeof v !== 'string' || !v || v.length > Math.ceil((max * 4) / 3) + 4 || !B64.test(v)) return null;
  const b = Buffer.from(v, 'base64');
  return b.length > 0 && b.length <= max ? b : null;
};

export const isPairId = (/** @type {unknown} */ v) => typeof v === 'string' && PAIR_ID.test(v);

/** Parses one client text message; returns the object or null when it is not a JSON object with a string `t`. */
export function parseMessage(/** @type {string} */ raw) {
  if (raw.length > MAX_MESSAGE_BYTES) return null;
  try {
    const m = JSON.parse(raw);
    return m && typeof m === 'object' && !Array.isArray(m) && typeof m.t === 'string' ? m : null;
  } catch {
    return null;
  }
}

/**
 * @returns {{ pairId: string, dir: 'p2m' | 'm2p', ctr: number, nonce: Buffer, box: Buffer } | null}
 */
export function parseFrame(/** @type {any} */ m) {
  if (!isPairId(m.pair) || (m.dir !== 'p2m' && m.dir !== 'm2p') || !Number.isSafeInteger(m.ctr) || m.ctr < 0) return null;
  const nonce = bytes(m.nonce, 64);
  const box = bytes(m.box, MAX_BOX_BYTES);
  return nonce && box ? { pairId: m.pair, dir: m.dir, ctr: m.ctr, nonce, box } : null;
}

/**
 * A receipt a client sends once it durably holds a frame it was given: { t:'ack', pair, dir, ctr }, `dir` being the direction the
 * frame travelled (the receiver's incoming one). It is the other way round from the relay's own { t:'ack', …, via } to a sender.
 * @returns {{ pairId: string, dir: 'p2m' | 'm2p', ctr: number } | null}
 */
export function parseAck(/** @type {any} */ m) {
  if (!isPairId(m.pair) || (m.dir !== 'p2m' && m.dir !== 'm2p') || !Number.isSafeInteger(m.ctr) || m.ctr < 1) return null;
  return { pairId: m.pair, dir: m.dir, ctr: m.ctr };
}

/** The text a client receives for one frame. */
export const encodeFrame = (
  /** @type {string} */ pairId,
  /** @type {string} */ dir,
  /** @type {number} */ ctr,
  /** @type {Buffer} */ nonce,
  /** @type {Buffer} */ box,
) => JSON.stringify({ t: 'frame', pair: pairId, dir, ctr, nonce: nonce.toString('base64'), box: box.toString('base64') });

export const encode = (/** @type {object} */ m) => JSON.stringify(m);
