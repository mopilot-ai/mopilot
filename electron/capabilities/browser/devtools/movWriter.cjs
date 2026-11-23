// browser_record's video file: a QuickTime movie (.mov) of Motion-JPEG frames, written as the frames come (each frame goes to disk at once; only its size and time stay in memory) and finished with its index (moov) on close. QuickTime Player and Safari play it as it is.
const { fs } = require('../../../platform/ports/fs.cjs');

/** The movie's time unit: milliseconds. */
const TIMESCALE = 1000;
/** How long the last frame shows. */
const LAST_MS = 500;
/** The QuickTime 3x3 identity matrix (16.16 and 2.30 fixed point). */
const MATRIX = [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000];

const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
};
const u16 = (n) => {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n & 0xffff);
  return b;
};
const zeros = (n) => Buffer.alloc(n);
const ascii = (s) => Buffer.from(s, 'latin1');
/** A box: its size, its four-letter type, then its parts. */
const box = (type, ...parts) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([u32(8 + body.length), ascii(type), body]);
};
/** A full box: a box whose body starts with a version byte and three bytes of flags. */
const full = (type, flags, ...parts) => box(type, u32(flags & 0xffffff), ...parts);
const matrix = () => Buffer.concat(MATRIX.map(u32));
/** A Pascal string padded to `size` bytes (the compressor name). */
const pascal = (s, size) => {
  const b = zeros(size);
  b[0] = Math.min(s.length, size - 1);
  b.write(s.slice(0, size - 1), 1, 'latin1');
  return b;
};

/** The JPEG frame's pixel size from its SOF marker, or null when it has none. */
function jpegSize(/** @type {Buffer} */ jpeg) {
  let i = 2;
  while (i + 9 < jpeg.length) {
    if (jpeg[i] !== 0xff) return null;
    const marker = jpeg[i + 1];
    const len = jpeg.readUInt16BE(i + 2);
    // SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
      return { height: jpeg.readUInt16BE(i + 5), width: jpeg.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  return null;
}

/** stts: each frame's duration, as runs of equal durations. */
function timeToSample(/** @type {number[]} */ durations) {
  /** @type {[number, number][]} */
  const runs = [];
  for (const d of durations) {
    const last = runs[runs.length - 1];
    if (last && last[1] === d) last[0]++;
    else runs.push([1, d]);
  }
  return full('stts', 0, u32(runs.length), ...runs.flatMap(([n, d]) => [u32(n), u32(d)]));
}

/** The movie's index for `frames` ({ offset, size, ms }), `width` x `height` pixels. */
function movieBox({ frames, width, height }) {
  const durations = frames.map((f) => Math.max(1, Math.round(f.ms)));
  const duration = durations.reduce((a, b) => a + b, 0);
  const sampleEntry = box(
    'jpeg',
    zeros(6),
    u16(1), // data reference index
    u16(0), // version
    u16(0), // revision
    zeros(4), // vendor
    u32(0), // temporal quality
    u32(0x200), // spatial quality: normal
    u16(width),
    u16(height),
    u32(72 << 16),
    u32(72 << 16),
    u32(0), // data size
    u16(1), // frames per sample
    pascal('Photo - JPEG', 32),
    u16(24), // depth
    u16(0xffff), // no color table
  );
  const stbl = box(
    'stbl',
    full('stsd', 0, u32(1), sampleEntry),
    timeToSample(durations),
    full('stsc', 0, u32(1), u32(1), u32(1), u32(1)),
    full('stsz', 0, u32(0), u32(frames.length), ...frames.map((f) => u32(f.size))),
    full('stco', 0, u32(frames.length), ...frames.map((f) => u32(f.offset))),
  );
  const minf = box(
    'minf',
    full('vmhd', 1, u16(0x40), zeros(6)),
    full('hdlr', 0, ascii('dhlr'), ascii('alis'), zeros(12), pascal('DataHandler', 12)),
    box('dinf', full('dref', 0, u32(1), full('alis', 1))),
    stbl,
  );
  const mdia = box(
    'mdia',
    full('mdhd', 0, u32(0), u32(0), u32(TIMESCALE), u32(duration), u16(0), u16(0)),
    full('hdlr', 0, ascii('mhlr'), ascii('vide'), zeros(12), pascal('VideoHandler', 13)),
    minf,
  );
  const tkhd = full(
    'tkhd',
    3, // enabled, in the movie
    u32(0),
    u32(0),
    u32(1), // track id
    zeros(4),
    u32(duration),
    zeros(8),
    u16(0), // layer
    u16(0), // alternate group
    u16(0), // volume
    zeros(2),
    matrix(),
    u32(width << 16),
    u32(height << 16),
  );
  const mvhd = full(
    'mvhd',
    0,
    u32(0),
    u32(0),
    u32(TIMESCALE),
    u32(duration),
    u32(0x10000), // rate 1.0
    u16(0x100), // volume 1.0
    zeros(10),
    matrix(),
    zeros(24), // preview, poster, selection and current times
    u32(2), // next track id
  );
  return { moov: box('moov', mvhd, box('trak', tkhd, mdia)), duration };
}

/**
 * A movie being written to `file`: add(jpeg, at) appends a frame shown from `at` (ms), finish() writes the index and
 * closes it. Frames whose pixel size differs from the first frame's still play (QuickTime scales them).
 */
class MovWriter {
  constructor(/** @type {string} */ file) {
    this.file = file;
    // the file is new and this writer's (files.cjs freeFile made it)
    this.fd = fs.openSync(file, 'w', 0o600);
    const ftyp = box('ftyp', ascii('qt  '), u32(0x200), ascii('qt  '));
    fs.writeSync(this.fd, ftyp);
    this.mdatAt = ftyp.length;
    // the mdat's size is written on finish
    fs.writeSync(this.fd, Buffer.concat([u32(0), ascii('mdat')]));
    this.offset = this.mdatAt + 8;
    /** @type {{ offset: number, size: number, at: number }[]} */
    this.frames = [];
    this.width = 0;
    this.height = 0;
    this.bytes = 0;
    this.closed = false;
  }

  /** Appends a JPEG frame shown from `at`; a frame that is no JPEG is skipped. Returns whether it was kept. */
  add(/** @type {Buffer} */ jpeg, /** @type {number} */ at) {
    if (this.closed) return false;
    const size = jpegSize(jpeg);
    if (!size) return false;
    if (!this.frames.length) Object.assign(this, size);
    fs.writeSync(this.fd, jpeg);
    this.frames.push({ offset: this.offset, size: jpeg.length, at });
    this.offset += jpeg.length;
    this.bytes += jpeg.length;
    return true;
  }

  /** Writes the index and closes the file. Returns what the movie holds (a movie with no frame is removed: null). */
  finish() {
    if (this.closed) return null;
    this.closed = true;
    if (!this.frames.length) {
      fs.closeSync(this.fd);
      fs.rmSync(this.file, { force: true });
      return null;
    }
    const frames = this.frames.map((f, i, all) => ({ ...f, ms: i + 1 < all.length ? all[i + 1].at - f.at : LAST_MS }));
    fs.writeSync(this.fd, u32(this.offset - this.mdatAt), 0, 4, this.mdatAt);
    const { moov, duration } = movieBox({ frames, width: this.width, height: this.height });
    fs.writeSync(this.fd, moov, 0, moov.length, this.offset);
    fs.closeSync(this.fd);
    return {
      file: this.file,
      frames: frames.length,
      width: this.width,
      height: this.height,
      ms: duration,
      bytes: this.offset + moov.length,
    };
  }
}

module.exports = { MovWriter, movieBox, jpegSize, LAST_MS, TIMESCALE };
