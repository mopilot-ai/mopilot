// The remote method that starts a chat: the phone's picks (harness, project, account, model, effort, permission, worktree, or one of the user's machines and its folder) and first message, once per start id.
const { requireAttachments } = require('../attachmentOwners.cjs');
const { capPermission } = require('../permissionCap.cjs');
const { createOnce } = require('../onceById.cjs');
const { RemoteError, asRefusal } = require('../serviceErrors.cjs');

/** A start that asked for something else under the same id is a different request, not a retry. */
// the native id is derived from the pair and start id, so it never changes the fingerprint
const fingerprint = (/** @type {any} */ { deadline: _deadline, startId: _id, nativeMessageId: _native, ...rest }) => JSON.stringify(rest);
const onceStart = createOnce('That start id was used for a different chat.');

/** Runs `make` once per start id: a retry gets the same chat, the same id with other picks is refused. */
function once(/** @type {any} */ svc, /** @type {any} */ client, /** @type {any} */ p, /** @type {() => Promise<any>} */ make) {
  if (!p.startId) return make();
  return onceStart(svc, `${client.kind === 'phone' ? client.pairId : 'panel'}:${p.startId}`, fingerprint(p), make);
}

/**
 * A new chat on one of the user's machines, started the way the Mac's composer and a scheduled run start one (electron/host/machineChatStart.cjs):
 * refused with main's own code and words when the machine can't run it. Images use the negotiated Host transport; other files and skills stay on this Mac.
 * @param {any} svc @param {any} client the phone (checked again after the folder is read) @param {any} message
 */
async function startOnMachine(
  svc,
  client,
  {
    hostId,
    folder,
    harness,
    projectId,
    text,
    model,
    effort,
    permission,
    attachments,
    skills,
    account,
    worktree,
    nativeMessageId,
    credential,
  },
) {
  const host = svc.host();
  if (host?.allowed() !== true) throw new RemoteError('forbidden', "Remote machines aren't available for this account.");
  if (skills.length) throw new RemoteError('invalid', 'Skills stay on this Mac. Send them in a chat here.');
  const images = attachments.length ? svc.ops.attachmentsForHost?.(attachments) : [];
  if (!Array.isArray(images) || images.some((f) => f.kind !== 'image'))
    throw new RemoteError('invalid', 'Only images can be attached on a remote machine.');
  if (account !== undefined || worktree) throw new RemoteError('invalid', 'Pick the account and worktree on that machine.');
  try {
    // the facade rechecks the phone before keeping its first message
    const result = await host.start({
      hostId,
      folder,
      harness,
      projectId,
      text,
      model,
      effort,
      permission,
      attachments: images,
      ...(credential ? { credential } : {}),
      ...(nativeMessageId ? { nativeMessageId } : {}),
      check: () => svc.assertPaired(client),
    });
    svc.assertPaired(client);
    svc.ops.attachmentsSent?.(attachments);
    return result;
  } catch (error) {
    throw asRefusal(error);
  }
}

module.exports = {
  'chat.start': (svc, client, p) => {
    const { permission, startId: _startId, ...message } = p;
    // refused before any chat exists: a permission above the Mac's ceiling, and full access from a phone
    if (permission !== undefined && client.kind === 'phone') capPermission(permission, svc.policy.permissionCeiling?.() ?? 'auto-review');
    return once(svc, client, p, async () => {
      requireAttachments(svc, client, p.attachments);
      if (message.hostId !== undefined) {
        // nothing is awaited before this start: a phone the Mac removed is refused here
        svc.assertPaired(client);
        // the permission goes with the start: it is the chat's mode before its first message is kept, and that message carries it to the machine
        // (the panel's menus know nothing of a machine's chat, so nothing is asked of them)
        return startOnMachine(svc, client, { ...message, permission });
      }
      // a chat on this Mac has one credential path of its own: the choice belongs to a machine's chat
      if (message.credential !== undefined)
        throw new RemoteError('invalid', 'Only a chat on a machine can pick where its model access comes from.');
      if (!(await svc.ops.usable(message.harness))) throw new Error("That harness can't start a chat now.");
      // the read above awaited: a phone the Mac removed meanwhile starts no chat
      svc.assertPaired(client);
      const result = await svc.ops.start({ ...message, ...(permission !== undefined ? { permission } : {}) });
      const started = typeof result === 'string' ? { chatId: result } : result;
      return started;
    });
  },
};
