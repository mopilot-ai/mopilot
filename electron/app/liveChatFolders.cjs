// The working directory of every chat that is not archived, on any harness, read from the main process's own chat records (#3909).
const { isMomoMeta } = require('../../shared/momoChat.mjs');

/**
 * What a worktree prune must not touch: where each live chat works. MoMo's chats never work in a managed worktree.
 * @param {{ chats: { records: Iterable<[string, { meta?: any, segments?: unknown[] }]> } }} live
 * @param {(chatId: string) => Promise<string | null>} projectOf
 * @returns {Promise<string[] | null>} null when a chat that has started has no readable folder: it might work in a worktree
 */
async function liveChatFolders(live, projectOf) {
  const open = [...live.chats.records].filter(([, r]) => typeof r.meta?.archived !== 'number' && !isMomoMeta(r.meta));
  const dirs = await Promise.all(open.map(([id]) => projectOf(id)));
  // a chat with segments has started; its folder not reading is not "no folder"
  if (open.some(([, r], i) => typeof dirs[i] !== 'string' && r.segments?.length)) return null;
  return dirs.filter((c) => typeof c === 'string');
}

module.exports = { liveChatFolders };
