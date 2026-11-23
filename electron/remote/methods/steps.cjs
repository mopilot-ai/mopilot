// The remote methods on a followed chat's work (phones only): a screenshot or zoom step's own picture and a picture the user attached to a message, opened on a tap, and where the chat works now. Pictures are the model's own captures from the chat's history (app/phoneSteps.cjs), never a new capture of the Mac.
const { imageRead } = require('../phoneImageReads.cjs');
const { RemoteError } = require('../serviceErrors.cjs');

/** A chat the phone follows: a picture of its work goes only to a phone that has the chat open. @param {any} svc @param {any} client @param {string} chatId */
function followed(svc, client, chatId) {
  if (!svc.ops.reachable(chatId)) throw new RemoteError('gone', svc.goneText);
  if (!client.follows.has(chatId)) throw new RemoteError('forbidden', 'Open this chat to see its pictures.');
}

module.exports = {
  // {} when the step has no picture to show (not a screenshot or a zoom, or its picture is not kept)
  'steps.thumbnail': async (svc, client, p) => {
    const check = () => {
      svc.assertPaired(client);
      followed(svc, client, p.chatId);
    };
    return (await imageRead(svc, check, () => svc.ops.stepImage?.(p.chatId, p.callId, p.maxSide))) ?? {};
  },
  // {} when the message has no such picture to show (not kept, or too large)
  'messages.image': async (svc, client, p) => {
    const check = () => {
      svc.assertPaired(client);
      followed(svc, client, p.chatId);
    };
    return (await imageRead(svc, check, () => svc.ops.userImage?.(p.chatId, p.itemId, p.index, p.maxSide, check))) ?? {};
  },
  // {} before the chat's first browser or desktop step
  'surface.current': async (svc, client, p) => {
    followed(svc, client, p.chatId);
    return (await svc.ops.surface?.(p.chatId)) ?? {};
  },
};
