// A screenshot a Host sent, looked at before the app decodes it: the bytes must be a PNG or JPEG of a sane size, so a crafted image cannot make Electron's decoder allocate without bound or parse what is not an image.
const { ToolError } = require('../contract/registry.cjs');

/** Most bytes of an image (the wire carries at most 8 MiB per message, base64). */
const MAX_BYTES = 8 * 1024 * 1024;
/** Most pixels along a side, and in all: a full-page capture is 4000 wide and 8000 tall at most, at the Host's scale. */
const MAX_SIDE = 32_768;
const MAX_PIXELS = 100_000_000;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** @param {string} why */
const refuse = (why) => new ToolError(`The screenshot from the host was refused: ${why}.`, 'capture_failed');

/**
 * Throws a ToolError unless `bytes` is a PNG (whose header names a size within the limits) or a JPEG within the byte limit.
 * @param {Buffer} bytes
 * @returns {Buffer} the same bytes
 */
function checkScreenshot(bytes) {
  if (bytes.length > MAX_BYTES) throw refuse('it is too large');
  if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return bytes;
  // a PNG starts with its signature and an IHDR chunk, whose first two numbers are the width and the height
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE) || bytes.subarray(12, 16).toString('latin1') !== 'IHDR')
    throw refuse('it is not a PNG or JPEG');
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width < 1 || height < 1 || width > MAX_SIDE || height > MAX_SIDE || width * height > MAX_PIXELS)
    throw refuse('its size is not plausible');
  return bytes;
}

module.exports = { checkScreenshot, MAX_BYTES, MAX_SIDE, MAX_PIXELS };
