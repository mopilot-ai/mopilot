// The remote methods behind a phone composer's @ menu: the chats and project files that match what is typed, for a chat the device follows (mentions.list) or for a chat about to start in a saved project (mentions.start).
const { RemoteError } = require('../serviceErrors.cjs');
const { deviceAnswerer, mayAnswer } = require('../../../shared/answerOwner.mjs');

module.exports = {
  'mentions.list': async (svc, client, p) => {
    // the same rule as reading the chat's files: only a device that follows the chat, still following when the lists are read
    const follows = () => client.kind === 'phone' && mayAnswer(deviceAnswerer(client.follows), p.chatId);
    if (!follows()) throw new RemoteError('forbidden', 'Follow this chat to mention its files and other chats.');
    const found = await svc.ops.mentionsList(p);
    if (!follows()) throw new RemoteError('forbidden', 'Follow this chat to mention its files and other chats.');
    return found;
  },
  // nothing is followed yet: a paired phone (checked again once the folder is read) lists the chats and the saved project's files
  'mentions.start': async (svc, client, p) => {
    svc.assertPaired(client);
    const found = await svc.ops.mentionsStart(p);
    svc.assertPaired(client);
    return found;
  },
};
