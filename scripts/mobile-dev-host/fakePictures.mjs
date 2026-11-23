// DEV ONLY: the pictures the messages of the dev host's fake app carry: remembered when sent, kept with the message, and read again by place as the Mac's history does (messages.image).

/** A 1x1 JPEG: what a picture too big for a phone's thumbnail reads as. */
export const TINY_JPEG =
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';
/** Base64 characters above which a picture reads as TINY_JPEG: the Mac sends a thumbnail, never the camera's file, and a phone refuses a reply of 3 million. */
export const MOST_PICTURE = 1_500_000;
const IMAGE_URL = /^data:image\/[\w.+-]+;base64,([A-Za-z0-9+/]+={0,2})$/;

export function createPictures() {
  /** @type {Map<string, string>} attachment id to the base64 of a picture sent as one */
  const sent = new Map();
  /** @type {Map<string, string[]>} `chat id, message id` to the base64 pictures that message carries (a queued message keeps its queue id) */
  const kept = new Map();
  // the item feed names a message `["live", turn, item]` or `[chat, turn, "userMessage", item]`: its pictures are kept under the item
  const at = (/** @type {string} */ chatId, /** @type {string} */ messageId) =>
    `${chatId}\n${/^\[.*,"([^"\\]+)"\]$/s.exec(messageId)?.[1] ?? messageId}`;
  return {
    /** An attachment: a picture sent as an image data URL is remembered, any other file is not. */
    remember: (/** @type {string} */ id, /** @type {unknown} */ dataUrl) => {
      const picture = IMAGE_URL.exec(String(dataUrl ?? ''));
      if (picture) sent.set(id, picture[1]);
    },
    /** The pictures among the attachments a message carries. */
    of: (/** @type {string[] | undefined} */ ids) => (ids ?? []).map((id) => sent.get(id)).filter((p) => typeof p === 'string'),
    keep: (/** @type {string} */ chatId, /** @type {string} */ messageId, /** @type {string[]} */ images) => {
      if (images.length) kept.set(at(chatId, messageId), images);
    },
    held: (/** @type {string} */ chatId, /** @type {string} */ messageId) => kept.get(at(chatId, messageId)) ?? [],
    /** The picture at a place of a message, as the Mac's history answers; null when the message has none there. */
    read: (/** @type {string} */ chatId, /** @type {string} */ messageId, /** @type {number} */ index) => {
      const data = kept.get(at(chatId, messageId))?.[index];
      return data ? { data: data.length > MOST_PICTURE ? TINY_JPEG : data, width: 1, height: 1 } : null;
    },
  };
}
