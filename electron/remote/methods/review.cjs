// The remote methods that review a chat's work read-only: its changed files, one file's diff with word marks, and a text file of its project folder. A device reads only a chat it follows; nothing here writes, and what comes back is data for a screen, never instructions.
const { RemoteError } = require('../serviceErrors.cjs');
const { deviceAnswerer, mayAnswer } = require('../../../shared/answerOwner.mjs');
const { MAX_FILES } = require('../review/changes.cjs');
const { pageOf } = require('../review/diffRows.cjs');
const { readFileInside } = require('../review/safeFile.cjs');

/** Bytes a listing may take once encoded. */
const LIST_BUDGET = 100_000;
const NOT_FOLLOWED = 'Follow this chat to review its changes.';

/** Whether the device still follows the chat (it may unfollow while a read runs). */
const follows = (/** @type {any} */ client, /** @type {string} */ chatId) =>
  client.kind === 'phone' && mayAnswer(deviceAnswerer(client.follows), chatId);

/** The chat's folder for a device that follows the chat; refusals say why. */
async function folderFor(/** @type {any} */ svc, /** @type {any} */ client, /** @type {string} */ chatId) {
  if (!follows(client, chatId)) throw new RemoteError('forbidden', NOT_FOLLOWED);
  const folder = await svc.ops.review.folderOf(chatId);
  if (!folder) throw new RemoteError('gone', 'That chat has no project folder.');
  return folder;
}

/** The reply, once the device is known to still follow the chat after the reads that built it. */
function stillFollowed(/** @type {any} */ client, /** @type {string} */ chatId, /** @type {any} */ reply) {
  if (!follows(client, chatId)) throw new RemoteError('forbidden', NOT_FOLLOWED);
  return reply;
}

/** The files a request's scope changed in the chat's folder, and for a turn which turn it was and whether it is still running. */
async function changedFiles(/** @type {any} */ svc, /** @type {string} */ cwd, /** @type {any} */ p) {
  const { review } = svc.ops;
  /** @type {{ turnId: string, live: boolean } | undefined} */
  let turn;
  const read = await review.files({
    cwd,
    scope: p.scope,
    turn: async () => {
      const found = await review.turnDiff(p.chatId, p.turnId ?? null);
      turn = found && { turnId: found.turnId, live: found.live };
      return found?.diff;
    },
  });
  return { ...read, turn: turn ?? {} };
}

/** The leading entries whose encoded size fits one reply (a frame to a phone is 256 KB sealed). */
function within(/** @type {object[]} */ entries) {
  let bytes = 0;
  return entries.filter((entry) => (bytes += Buffer.byteLength(JSON.stringify(entry))) <= LIST_BUDGET);
}

module.exports = {
  'diff.list': async (svc, client, p) => {
    const { files, omitted, turn } = await changedFiles(svc, await folderFor(svc, client, p.chatId), p);
    const listed = within(files.slice(0, MAX_FILES).map(({ rows: _rows, ...file }) => file));
    return stillFollowed(client, p.chatId, {
      scope: p.scope,
      ...turn,
      files: listed,
      total: files.length,
      omitted,
      truncated: listed.length < files.length,
    });
  },
  'diff.read': async (svc, client, p) => {
    const { files, turn } = await changedFiles(svc, await folderFor(svc, client, p.chatId), p);
    const file = files.find((f) => f.path === p.path);
    if (!file) throw new RemoteError('gone', "That file isn't changed here.");
    const { rows, ...head } = file;
    return stillFollowed(client, p.chatId, {
      ...head,
      ...turn,
      ...(file.binary ? { rows: [], from: 0, next: null, total: 0 } : pageOf(rows, p.from, p.rows)),
    });
  },
  'file.read': async (svc, client, p) => {
    const read = await readFileInside({
      folder: await folderFor(svc, client, p.chatId),
      path: p.path,
      offset: p.offset,
      maxBytes: p.maxBytes,
    });
    return stillFollowed(client, p.chatId, read);
  },
};
