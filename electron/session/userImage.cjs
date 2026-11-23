// One picture the user attached to a message, from a chat's saved history, for a phone that opens a message's thumbnail (electron/remote/methods/steps.cjs messages.image): the turns leave the bytes out (peerTranscript.cjs), so it is read again from the harness's own record, newest segment first.
const { hostImageLocator } = require('../../shared/host/images.mjs');
const { historyImageItem } = require('./historyImageItem.cjs');

/** The picture blocks of a message's content: Claude keeps them as `image` with a data: URL, Codex and the app's own turns as `localImage` with a file. @param {any} item */
function imagesOf(item) {
  return (Array.isArray(item?.content) ? item.content : []).filter(
    (/** @type {any} */ c) => c?.type === 'image' || c?.type === 'localImage',
  );
}

/** The index-th picture of a message as `{ url }` (a data: URL) or `{ path }` (a file on this Mac); null when it has none or it is only a link. @param {any} item @param {number} index */
function pictureAt(item, index) {
  const picture = imagesOf(item)[index];
  if (!picture) return null;
  if (picture.type === 'localImage') return typeof picture.path === 'string' && picture.path ? { path: picture.path } : null;
  if (typeof picture.url !== 'string') return null;
  const hostImage = hostImageLocator(picture.url);
  if (hostImage) return { hostImage };
  return picture.url.startsWith('data:image/') ? { url: picture.url } : null;
}

/**
 * The index-th picture of the message an id names, as `{ url }` (a data: URL) or `{ path }` (a file on this Mac), or null: no such
 * message or picture, or a picture that is only a link (a phone never makes the Mac fetch one).
 * @param {{ segments: any[] } | undefined} record the chat's record (ChatsStore)
 * @param {(segment: any, signal?: AbortSignal, o?: object) => Promise<{ turns?: any[] } | null>} readTurns the native reader
 * @param {string} itemId @param {number} index
 */
async function readUserImage(record, readTurns, itemId, index, check = () => undefined, cache = null) {
  const item = await historyImageItem(record, readTurns, itemId, (item) => item.type === 'userMessage', check, cache);
  return pictureAt(item, index);
}

/** readUserImage by chat id, the record and the native reader looked up at each read (as main wires the peer runtime). */
const peerUserImage =
  (/** @type {{ records: Map<string, any> }} */ chats, /** @type {() => any} */ nativeReader, /** @type {any} */ cache = null) =>
  (/** @type {string} */ chatId, /** @type {string} */ itemId, /** @type {number} */ index, check = () => undefined) =>
    readUserImage(chats.records.get(chatId), nativeReader(), itemId, index, check, cache);

module.exports = { readUserImage, peerUserImage, imagesOf, pictureAt };
