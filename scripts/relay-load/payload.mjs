// The frames the relay load harness sends: a `box` whose header names its pair, direction, counter, length and creation time
// (with a checksum over all of it) and whose body is a function of them, so a receiver can tell a lost, corrupted, truncated,
// duplicated or misrouted frame from a good one.

const MAGIC = 0x524c4431; // "RLD1"
export const HEADER_BYTES = 32;
const DIRS = ['m2p', 'p2m'];

const bodyByte = (/** @type {number} */ pair, /** @type {number} */ ctr, /** @type {number} */ i) => (pair * 131 + ctr * 31 + i * 7) & 255;

/** FNV-1a over the header's first 28 bytes. */
function headerCheck(/** @type {Buffer} */ box) {
  let h = 0x811c9dc5;
  for (let i = 0; i < 28; i++) h = Math.imul(h ^ box[i], 0x01000193) >>> 0;
  return h;
}

/** @returns {Buffer} `size` bytes (at least the header) */
export function makeBox(
  /** @type {number} */ pair,
  /** @type {'m2p' | 'p2m'} */ dir,
  /** @type {number} */ ctr,
  /** @type {number} */ size,
  /** @type {number} */ sentAt,
) {
  const box = Buffer.alloc(Math.max(size, HEADER_BYTES));
  box.writeUInt32BE(MAGIC, 0);
  box.writeUInt32BE(ctr, 4);
  box.writeUInt32BE(pair, 8);
  box.writeUInt8(DIRS.indexOf(dir), 12);
  box.writeDoubleBE(sentAt, 16);
  box.writeUInt32BE(box.length, 24);
  box.writeUInt32BE(headerCheck(box), 28);
  for (let i = HEADER_BYTES; i < box.length; i++) box[i] = bodyByte(pair, ctr, i);
  return box;
}

/** @returns {Buffer} the 24-byte nonce for a frame (unique per pair, direction and counter) */
export function makeNonce(/** @type {number} */ pair, /** @type {'m2p' | 'p2m'} */ dir, /** @type {number} */ ctr) {
  const nonce = Buffer.alloc(24);
  nonce.writeUInt32BE(pair, 0);
  nonce.writeUInt8(DIRS.indexOf(dir), 4);
  nonce.writeUInt32BE(ctr, 8);
  return nonce;
}

/**
 * @returns {{ pair: number, dir: 'm2p' | 'p2m', ctr: number, sentAt: number, intact: boolean } | null} null when it is not one of ours;
 * `intact` is false when the header does not match its checksum, the length is not the one sent, or a body byte differs
 */
export function readBox(/** @type {Buffer} */ box) {
  if (box.length < HEADER_BYTES || box.readUInt32BE(0) !== MAGIC) return null;
  const ctr = box.readUInt32BE(4);
  const pair = box.readUInt32BE(8);
  const dir = DIRS[box.readUInt8(12)];
  if (!dir) return null;
  let intact = box.readUInt32BE(24) === box.length && box.readUInt32BE(28) === headerCheck(box);
  for (let i = HEADER_BYTES; i < box.length && intact; i++) intact = box[i] === bodyByte(pair, ctr, i);
  return { pair, dir: /** @type {'m2p' | 'p2m'} */ (dir), ctr, sentAt: box.readDoubleBE(16), intact };
}

/** The wire message for one frame. */
export function frameText(
  /** @type {string} */ pairId,
  /** @type {number} */ pair,
  /** @type {'m2p' | 'p2m'} */ dir,
  /** @type {number} */ ctr,
  /** @type {number} */ size,
  /** @type {number} */ sentAt,
) {
  return JSON.stringify({
    t: 'frame',
    pair: pairId,
    dir,
    ctr,
    nonce: makeNonce(pair, dir, ctr).toString('base64'),
    box: makeBox(pair, dir, ctr, size, sentAt).toString('base64'),
  });
}
