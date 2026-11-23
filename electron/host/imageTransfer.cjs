// Main's bounded image-byte channel to a negotiated Host: capture explicit attachments, upload immutable digests in retry-safe chunks, and read an exact historical image with ownership checks between awaits.
const { fs } = require('../platform/ports/fs.cjs');
const { createHash } = require('node:crypto');
const { IMAGE_FEATURE, IMAGE_CHUNK_BYTES, MAX_IMAGE_BYTES, MAX_MESSAGE_IMAGES } = require('../../shared/host/images.mjs');
/** An image this app cannot send: a refusal of the message (`app`: the queue shows it, not blaming the machine). */
const failed = (code, message) => Object.assign(new Error(message), { code, app: true });
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

function mimeOf(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}
function pngOf(bytes) {
  const picture = require('../platform/ports/electronApi.cjs').api.nativeImage.createFromBuffer(bytes);
  if (picture.isEmpty()) return null;
  return picture.toPNG();
}
const UNREADABLE = 'That image could not be read. Attach it again.';
/** Reads the file once; a failed close never hides the error that ended the read, and never passes for a clean read. */
async function capture(path, check, convert) {
  const held = {};
  let result;
  let error = /** @type {any} */ (null);
  try {
    result = await readFrom(path, check, convert, held);
  } catch (e) {
    error = e;
  }
  try {
    await held.file?.close();
  } catch {
    error ??= failed('unsupported', UNREADABLE);
  }
  if (error) throw error;
  return result;
}
async function readFrom(path, check, convert, held) {
  try {
    check();
    const file = (held.file = await fs.promises.open(path, 'r'));
    check();
    const stat = await file.stat();
    check();
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_IMAGE_BYTES) throw new Error('size');
    const bytes = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      check();
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      check();
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset !== stat.size) throw new Error('changed');
    let data = bytes.subarray(0, offset);
    let mime = mimeOf(data);
    if (!mime) {
      data = await convert(data);
      check();
      if (!data || data.length > MAX_IMAGE_BYTES || mimeOf(data) !== 'image/png') throw new Error('format');
      mime = 'image/png';
    }
    return { data, mime };
  } catch (error) {
    if (['stale_epoch', 'host_unreachable', 'request_retired', 'forbidden'].includes(error?.code)) throw error;
    throw failed('unsupported', UNREADABLE);
  }
}

/** One immutable blob in retry-safe chunks under its content digest; the Host's own durable length decides where it goes on from. */
async function uploadBytes({ host, chatId, epoch, data, mime, check, kind = 'image' }) {
  const imageId = digest(data);
  for (let offset = 0; offset < data.length; ) {
    check();
    const part = data.subarray(offset, offset + IMAGE_CHUNK_BYTES);
    const response = await host.call('chat.attach', {
      chatId,
      epoch,
      key: `${kind}.${imageId}.${offset}`,
      imageId,
      offset,
      size: data.length,
      mime,
      data: part.toString('base64'),
    });
    check();
    const answer = response?.result;
    if (
      answer?.imageId !== imageId ||
      !Number.isSafeInteger(answer.received) ||
      answer.received < offset + part.length ||
      answer.received > data.length ||
      answer.done !== (answer.received === data.length)
    )
      throw failed('invalid', `The Host did not confirm this ${kind} upload. Try again.`);
    offset = answer.received;
  }
  return imageId;
}

/** No bytes are read until the authenticated connection negotiated this capability. */
async function uploadImages({ host, chatId, epoch, attachments, check, convert = pngOf }) {
  if (!attachments.length) return [];
  check();
  if (!host.speaks?.(IMAGE_FEATURE) || typeof host.call !== 'function')
    throw failed('feature_missing', 'This Host cannot receive images yet. Update it and try again.');
  if (attachments.length > MAX_MESSAGE_IMAGES || attachments.some((file) => file.kind !== 'image'))
    throw failed('unsupported', 'Only images can be attached to a remote machine.');
  const ids = [];
  for (const attachment of attachments) {
    const { data, mime } = await capture(attachment.path, check, convert);
    check();
    ids.push(await uploadBytes({ host, chatId, epoch, data, mime, check }));
  }
  return ids;
}

/** Immutable image content is verified against its stored digest before it reaches a phone decoder. */
async function readHostImage({ host, chatId, epoch, imageId, check }) {
  check();
  if (!host.speaks?.(IMAGE_FEATURE) || typeof host.call !== 'function') return null;
  const chunks = [];
  let offset = 0;
  let size;
  let mime;
  for (let index = 0; index <= Math.ceil(MAX_IMAGE_BYTES / IMAGE_CHUNK_BYTES); index++) {
    check();
    const reply = await host.call('chat.image', { chatId, epoch, imageId, offset, limit: IMAGE_CHUNK_BYTES });
    check();
    if (
      reply?.imageId !== imageId ||
      !Number.isSafeInteger(reply.size) ||
      reply.size < 1 ||
      reply.size > MAX_IMAGE_BYTES ||
      typeof reply.data !== 'string' ||
      reply.data.length > (IMAGE_CHUNK_BYTES / 3) * 4 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(reply.data)
    )
      return null;
    if ((size !== undefined && size !== reply.size) || (mime !== undefined && mime !== reply.mime)) return null;
    const bytes = Buffer.from(reply.data, 'base64');
    if (
      !bytes.length ||
      bytes.length > IMAGE_CHUNK_BYTES ||
      reply.nextOffset !== offset + bytes.length ||
      reply.nextOffset > reply.size ||
      reply.done !== (reply.nextOffset === reply.size)
    )
      return null;
    size = reply.size;
    mime = reply.mime;
    chunks.push(bytes);
    offset = reply.nextOffset;
    if (reply.done) {
      const data = Buffer.concat(chunks, size);
      return digest(data) === imageId && mimeOf(data) === mime ? { data, mime } : null;
    }
  }
  return null;
}
module.exports = { uploadImages, uploadBytes, readHostImage, mimeOf, digest };
