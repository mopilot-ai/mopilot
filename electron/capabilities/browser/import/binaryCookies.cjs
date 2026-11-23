// Parses Safari's Cookies.binarycookies file into normalized cookies, with strict bounds checks so a truncated or hostile file fails cleanly instead of reading out of range.
const { ImportError } = require('./errors.cjs');

/** Seconds between the Unix epoch (1970) and the Mac absolute time epoch (2001). */
const MAC_EPOCH_OFFSET = 978307200;
const MAX_LIFETIME_SECONDS = 400 * 24 * 60 * 60;
/** Most pages and cookies per page accepted; real files hold far fewer. */
const MAX_PAGES = 10000;
const MAX_COOKIES_PER_PAGE = 100000;
/** A cookie record: 8 bytes size+version, flags, reserved, four string offsets, 8 end-marker bytes, two doubles. */
const MIN_RECORD = 56;
const FLAG_SECURE = 1;
const FLAG_HTTP_ONLY = 4;

const corrupt = (/** @type {string} */ what) => new ImportError('read_failed', `The Safari cookie file is damaged (${what}).`);

/**
 * The NUL-terminated string at `offset` inside record `rec`, or null when it is out of range or unterminated.
 * @param {Buffer} rec
 * @param {number} offset
 */
function readCString(rec, offset) {
  if (offset < MIN_RECORD || offset >= rec.length) return null;
  const end = rec.indexOf(0, offset);
  if (end < 0) return null;
  return rec.toString('utf8', offset, end);
}

/**
 * One cookie record, or null when it is malformed.
 * @param {Buffer} rec
 */
function parseRecord(rec) {
  const flags = rec.readUInt32LE(8);
  const host = readCString(rec, rec.readUInt32LE(16));
  const name = readCString(rec, rec.readUInt32LE(20));
  const path = readCString(rec, rec.readUInt32LE(24));
  const value = readCString(rec, rec.readUInt32LE(28));
  const expiration = rec.readDoubleLE(40);
  const creation = rec.readDoubleLE(48);
  if (host === null || name === null || path === null || value === null) return null;
  if (!Number.isFinite(expiration) || !Number.isFinite(creation)) return null;
  return { host, name, path, value, flags, expiration, creation };
}

/**
 * @typedef {{ host: string, name: string, value: string, path: string, secure: boolean, httpOnly: boolean, sameSite: 'unspecified', expires: number, hostOnly: boolean }} Cookie
 */

/**
 * Cookies of a Cookies.binarycookies file. Session cookies (no expiry) are left out; cookies already expired at `now`
 * are counted in `stats.expired`; a lifetime beyond 400 days is shortened to 400 days. A damaged file throws an
 * ImportError('read_failed'); a malformed record inside an otherwise valid page is skipped. `stats.total` is the
 * number of cookies the file declares.
 * @param {Buffer} buffer
 * @param {{ now?: number }} [o] ms since the Unix epoch
 * @returns {{ cookies: Cookie[], stats: { total: number, imported: number, expired: number } }}
 */
function parseBinaryCookies(buffer, { now = Date.now() } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8) throw corrupt('too short');
  if (buffer.toString('latin1', 0, 4) !== 'cook') throw corrupt('bad signature');
  const pageCount = buffer.readUInt32BE(4);
  if (pageCount > MAX_PAGES) throw corrupt('too many pages');
  let pos = 8 + pageCount * 4;
  if (pos > buffer.length) throw corrupt('truncated page table');
  const nowSeconds = now / 1000;
  /** @type {Cookie[]} */
  const cookies = [];
  let total = 0;
  let expired = 0;
  for (let p = 0; p < pageCount; p++) {
    const size = buffer.readUInt32BE(8 + p * 4);
    if (size < 8 || size > buffer.length - pos) throw corrupt('page outside the file');
    const page = buffer.subarray(pos, pos + size);
    pos += size;
    // the page tag is big-endian (bytes 00 00 01 00), unlike the little-endian fields inside the page
    if (page.readUInt32BE(0) !== 0x100) throw corrupt('bad page header');
    const count = page.readUInt32LE(4);
    if (count > MAX_COOKIES_PER_PAGE || 8 + count * 4 > page.length) throw corrupt('bad cookie count');
    total += count;
    for (let c = 0; c < count; c++) {
      const start = page.readUInt32LE(8 + c * 4);
      if (start < 8 + count * 4 || start + 4 > page.length) continue;
      const recSize = page.readUInt32LE(start);
      if (recSize < MIN_RECORD || recSize > page.length - start) continue;
      const rec = parseRecord(page.subarray(start, start + recSize));
      if (!rec) continue;
      if (rec.expiration <= 0 || rec.expiration <= rec.creation) continue;
      const expires = rec.expiration + MAC_EPOCH_OFFSET;
      if (expires <= nowSeconds) {
        expired++;
        continue;
      }
      cookies.push({
        host: rec.host,
        name: rec.name,
        value: rec.value,
        path: rec.path,
        secure: (rec.flags & FLAG_SECURE) !== 0,
        httpOnly: (rec.flags & FLAG_HTTP_ONLY) !== 0,
        sameSite: 'unspecified',
        expires: Math.min(expires, nowSeconds + MAX_LIFETIME_SECONDS),
        hostOnly: !rec.host.startsWith('.'),
      });
    }
  }
  return { cookies, stats: { total, imported: cookies.length, expired } };
}

module.exports = { MAC_EPOCH_OFFSET, parseBinaryCookies };
