// Opaque, bounded Host image references and chunk contracts; both ends negotiate chatImages before sending bytes or image-bearing messages.
export const IMAGE_FEATURE = 'chatImages';
/** A Host with this reads a chat's picture for any client currently paired with it, whoever sent it (host/src/imageProtocol.mjs); one without reads only the asking client's own uploads. */
export const CHAT_IMAGE_FEATURE = 'chatImagesChat';
export const IMAGE_METHODS = Object.freeze(['chat.attach', 'chat.image']);
export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
export const IMAGE_CHUNK_BYTES = 96 * 1024;
export const MAX_MESSAGE_IMAGES = 16;
const ID = /^[a-f0-9]{64}$/;
const MIME = /^(image\/(png|jpeg|webp|gif)|application\/octet-stream)$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** A content digest, never a filesystem path. */
export function imageIdOf(value, bad) {
  if (typeof value !== 'string' || !ID.test(value)) throw bad('That image reference is not available.');
  return value;
}
/** Optional image references of a message; repeated pictures retain their positions. */
export function imageRefs(value, bad) {
  if (value == null) return {};
  if (!Array.isArray(value) || value.length > MAX_MESSAGE_IMAGES) throw bad('Attach fewer images.');
  return value.length ? { images: value.map((id) => imageIdOf(id, bad)) } : {};
}
const offsetOf = (value, bad) => {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_IMAGE_BYTES) throw bad('That image offset is not available.');
  return value;
};

export const imageParsers = (effect, scoped, bad) => ({
  'chat.attach': (p) => {
    const scope = effect(p);
    const imageId = imageIdOf(p.imageId, bad);
    const offset = offsetOf(p.offset, bad);
    if (!Number.isSafeInteger(p.size) || p.size < 1 || p.size > MAX_IMAGE_BYTES || offset >= p.size)
      throw bad('That image is too large or has an invalid size.');
    if (typeof p.mime !== 'string' || !MIME.test(p.mime)) throw bad('That image format is not supported.');
    if (typeof p.data !== 'string' || p.data.length > (IMAGE_CHUNK_BYTES / 3) * 4 || p.data.length % 4 || !BASE64.test(p.data))
      throw bad('That image chunk is not available.');
    return { ...scope, imageId, offset, size: p.size, mime: p.mime, data: p.data };
  },
  'chat.image': (p) => {
    const scope = scoped(p);
    const imageId = imageIdOf(p.imageId, bad);
    const offset = offsetOf(p.offset, bad);
    const limit = p.limit ?? IMAGE_CHUNK_BYTES;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > IMAGE_CHUNK_BYTES) throw bad('Ask for a smaller image chunk.');
    return { ...scope, imageId, offset, limit };
  },
});

/** Native paths and inline image bytes never ride a Host user-message projection. */
export const hostImageUrl = (id) => `host-image:${id}`;
export const hostImageId = (url) => (typeof url === 'string' && /^host-image:[a-f0-9]{64}$/.test(url) ? url.slice(11) : null);

/** A Mac scopes a Host-originated opaque reference to the registered source machine before saving it. */
export function scopedHostImageUrl(hostId, imageId) {
  return `host-image:${encodeURIComponent(JSON.stringify([hostId, imageId]))}`;
}
export function hostImageLocator(url) {
  const bare = hostImageId(url);
  if (bare) return { imageId: bare, hostId: null };
  if (typeof url !== 'string' || !url.startsWith('host-image:') || url.length > 2048) return null;
  try {
    const value = JSON.parse(decodeURIComponent(url.slice(11)));
    return Array.isArray(value) &&
      value.length === 2 &&
      typeof value[0] === 'string' &&
      value[0] &&
      value[0].length <= 256 &&
      ID.test(value[1])
      ? { hostId: value[0], imageId: value[1] }
      : null;
  } catch {
    return null;
  }
}
/** The sender's registered machine owns the origin; a remote message cannot nominate a different machine or a private path. */
export function scopeHostPictures(user, hostId) {
  if (!Array.isArray(user?.content)) return user;
  return {
    ...user,
    content: user.content.map((part) => {
      if (part?.type === 'localImage') return { type: 'image' };
      if (part?.type !== 'image') return part;
      const ref = hostImageLocator(part.url);
      return ref ? { type: 'image', url: scopedHostImageUrl(hostId, ref.imageId) } : { type: 'image' };
    }),
  };
}

/**
 * A message this Mac sent keeps drawing from the image files the composer attached while it is live: each of the Host's own `host-image:` pictures gets its file's `path` beside it (the live bubble reads that file, and asks the machine only when the file is gone),
 * and a picture the Host's echo left out is added as a `localImage` after the text. The saved record never holds these paths (`withoutPreviewPaths`): the composer's files are temporary, the machine's reference is what lasts.
 */
/** @param {any} user @param {any} attachments @param {string} [hostId] the machine a picture's digest is scoped to */
export function withSentPictures(user, attachments, hostId) {
  const sent = (Array.isArray(attachments) ? attachments : []).filter((a) => a?.kind === 'image' && typeof a.path === 'string' && a.path);
  if (!sent.length || !Array.isArray(user?.content)) return user;
  // a picture the machine took has its content digest (`imageId`, kept when the upload was made): the reference the saved record keeps, even when the machine's echo left the picture without one
  const refOf = (a) => (hostId && ID.test(a.imageId ?? '') ? scopedHostImageUrl(hostId, a.imageId) : null);
  let next = 0;
  const content = user.content.map((part) => {
    if (part?.type !== 'image' || next >= sent.length) return part;
    const a = sent[next++];
    return { ...part, ...(typeof part.url !== 'string' && refOf(a) ? { url: refOf(a) } : {}), path: a.path };
  });
  const extra = sent
    .slice(next)
    .map((a) => (refOf(a) ? { type: 'image', url: refOf(a), path: a.path } : { type: 'localImage', path: a.path }));
  const at = content.findLastIndex((part) => part?.type === 'text' || part?.type === 'image') + 1;
  return {
    ...user,
    content: [...content.slice(0, at), ...extra, ...content.slice(at)],
  };
}

/** The user message as it is saved: the machine's references stay, the composer's temporary file paths (a preview for the live bubble only) do not. */
export function withoutPreviewPaths(user) {
  if (!Array.isArray(user?.content)) return user;
  return {
    ...user,
    content: user.content
      .filter((part) => part?.type !== 'localImage')
      .map((part) => {
        if (part?.type !== 'image' || !('path' in part)) return part;
        const { path: _preview, ...kept } = part;
        return kept;
      }),
  };
}

/** An event as it is saved: the message it carries by the machine's refs only. */
export const durableEvent = (ev) => (ev?.user ? { ...ev, user: withoutPreviewPaths(ev.user) } : ev);
