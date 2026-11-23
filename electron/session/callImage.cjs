// One tool call's own screenshot from a chat's saved history, for a phone that taps a screenshot or zoom step (electron/remote/methods/steps.cjs): the image the model got from that call (its masked capture), never a new capture. Every harness's history is read the same way (each adapter's native reader), newest segment first.
const { historyImageItem, itemIdOf } = require('./historyImageItem.cjs');
const { toolOutput } = require('../../shared/toolOutput.mjs');

/** A screenshot or zoom tool, by its name (desktop_screenshot, app_zoom, browser_screenshot, save_screenshot) or its action (`computer`). */
const SHOT = /(?:^|_)(?:screenshot|zoom)$/;
const CALLS = new Set(['mcpToolCall', 'dynamicToolCall']);

/** The call's arguments, as an object: Codex keeps them as JSON text. @param {unknown} v */
function argsOf(v) {
  if (typeof v !== 'string') return v && typeof v === 'object' ? /** @type {any} */ (v) : {};
  try {
    const parsed = JSON.parse(v);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** Whether a history item is a screenshot or a zoom: the only steps a phone may open a picture of. @param {any} item */
function isShot(item) {
  if (!CALLS.has(item?.type)) return false;
  // the end of the tool's name, whatever server prefix it carries (mcp__server__computer_screenshot)
  const action = argsOf(item.arguments).action;
  return SHOT.test(String(item.tool ?? '')) || action === 'screenshot' || action === 'zoom';
}

/**
 * The last image the call returned as a data: URL, or null: no such call, not a screenshot or a zoom, or its picture is not kept.
 * @param {{ segments: any[] } | undefined} record the chat's record (ChatsStore)
 * @param {(segment: any, signal?: AbortSignal, o?: object) => Promise<{ turns?: any[] } | null>} readTurns the native reader
 * @param {string} callId
 */
async function readCallImage(record, readTurns, callId, cache = null) {
  const item = await historyImageItem(record, readTurns, callId, isShot, undefined, cache);
  return item ? (toolOutput(item).images.at(-1) ?? null) : null;
}

/** readCallImage by chat id, the record and the native reader looked up at each read (as main wires the peer runtime). */
const peerCallImage =
  (/** @type {{ records: Map<string, any> }} */ chats, /** @type {() => any} */ nativeReader, /** @type {any} */ cache = null) =>
  (/** @type {string} */ chatId, /** @type {string} */ callId) =>
    readCallImage(chats.records.get(chatId), nativeReader(), callId, cache);

module.exports = { readCallImage, peerCallImage, isShot, itemIdOf };
