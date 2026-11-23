// The remote methods that change a chat from a phone: rename it, archive it or bring it back, or fork a side chat from it (pinning is chats.pin in read.cjs). Each runs main's own operation (app/phoneChatOps.cjs, app/phoneSideChat.cjs).
const { RemoteError, asRefusal } = require('../serviceErrors.cjs');

/** A chat a phone may change: one main knows, never one kept from the coding side (MoMo's). @param {any} svc @param {string} chatId */
function known(svc, chatId) {
  if (!svc.ops.reachable(chatId)) throw new RemoteError('gone', svc.goneText);
}

/** The operation, when this Mac's wiring has it. @param {any} svc @param {'renameChat' | 'archiveChat' | 'sideChat'} name */
function op(svc, name) {
  const fn = svc.ops[name];
  if (typeof fn !== 'function') throw new RemoteError('failed', 'Update MoPilot on your Mac to do this from your phone.');
  return fn;
}

module.exports = {
  // a chat's login, pinned or released: the app's own account row, for a paired phone
  'chat.account': (svc, client, p) => {
    known(svc, p.chatId);
    if (typeof svc.ops.setChatAccount !== 'function')
      throw new RemoteError('failed', 'Update MoPilot on your Mac to do this from your phone.');
    svc.assertPaired(client);
    try {
      return svc.ops.setChatAccount(p);
    } catch (error) {
      throw new RemoteError('invalid', error instanceof Error ? error.message : 'Could not change the account.');
    }
  },
  // Auto-switch moves chats between logins on a limit: the Mac's own setting, changed only by a paired phone
  'accounts.autoSwitch': (svc, client, p) => {
    if (typeof svc.ops.setAutoSwitch !== 'function')
      throw new RemoteError('failed', 'Update MoPilot on your Mac to do this from your phone.');
    svc.assertPaired(client);
    return svc.ops.setAutoSwitch(p);
  },
  'chats.rename': async (svc, client, p) => {
    known(svc, p.chatId);
    const rename = op(svc, 'renameChat');
    svc.assertPaired(client);
    await rename(p.chatId, p.title);
    return { title: p.title };
  },
  'chats.archive': async (svc, client, p) => {
    known(svc, p.chatId);
    const archive = op(svc, 'archiveChat');
    svc.assertPaired(client);
    await archive(p.chatId, p.archived);
    return { archived: p.archived };
  },
  // the Mac's Side chat from a phone: a temporary fork of the chat, which the phone then opens by the id it gets; a harness without one is refused with main's own code
  'chat.sideChat': async (svc, client, p) => {
    known(svc, p.chatId);
    const side = op(svc, 'sideChat');
    svc.assertPaired(client);
    try {
      return { chatId: await side(p.chatId) };
    } catch (error) {
      throw asRefusal(error);
    }
  },
};
