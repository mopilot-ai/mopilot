// What a paired phone's live items carry on the wire: user image references retain each attachment's position while its bytes and machine-local path stay in the feed for messages.image; in a MoMo chat a reply's `Options:` line leaves its text and comes as `options` (shared/momoOptions.mjs), as the saved rows have it.
const { withOptions } = require('../../shared/momoOptions.mjs');

/** @param {any[]} items @param {unknown} turnId @param {boolean} [momo] the chat is MoMo's (app/phoneMomoChat.cjs) */
function phoneMessageItems(items, turnId, momo = false) {
  return items.map((item) =>
    item?.type === 'userMessage' && Array.isArray(item.content)
      ? {
          ...item,
          messageId: JSON.stringify(['live', turnId, item.id]),
          content: item.content.map((part) => (['image', 'localImage'].includes(part?.type) ? { type: 'image' } : part)),
        }
      : momo && item?.type === 'agentMessage'
        ? withOptions(item)
        : item,
  );
}

module.exports = { phoneMessageItems };
