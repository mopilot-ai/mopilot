// The remote methods on one chat: follow it, read it, send to it, stop it, switch its harness, open it and dictate (starting a chat is start.cjs, attachments and recordings attach.cjs).
const { requireAttachments } = require('../attachmentOwners.cjs');
const { RemoteError } = require('../serviceErrors.cjs');
const { UPDATE_EXTENSION } = require('../../../shared/remote/schema.mjs');
const { beforeSend } = require('../sendLedger.cjs');
const { ledgerOf, payloadOf, sendKey } = require('../sendIdentity.cjs');

/** A send under an id already used for other text or files is a different message, not a retry; the deadline is not part of what was asked. */
// the native id is derived from the pair, chat and send id, so it says nothing more about the message and never changes its fingerprint
const fingerprint = (/** @type {any} */ { deadline: _deadline, sendId: _id, nativeMessageId: _native, ...rest }) => JSON.stringify(rest);
/** `tookMs` (a phone's reply only): how long the Mac held the request before the harness took it, so a phone can tell the Mac's share of a slow send from the network's. */
const sentReply = (/** @type {any} */ result, /** @type {number | undefined} */ tookMs) => ({
  sent: true,
  ...(tookMs === undefined ? {} : { tookMs }),
  ...(result?.warning ? { warning: String(result.warning) } : {}),
});

/** A chat a phone may follow, else gone. */
function reachable(/** @type {any} */ svc, /** @type {string} */ chatId) {
  if (!svc.ops.reachable(chatId)) throw new RemoteError('gone', svc.goneText);
}

/**
 * A follow-up goes after the chat's earlier ones, so a phone's retries and the panel's keep their order; a Stop retires
 * the ones still waiting. The same queue serves the panel and the phones.
 */
async function sendOrdered(
  /** @type {any} */ svc,
  /** @type {any} */ client,
  /** @type {any} */ p,
  /** @type {(() => void) | undefined} */ admit = undefined,
  /** @type {(() => void) | undefined} */ stopped = svc.ops.sendCheck?.(p.chatId),
) {
  requireAttachments(svc, client, p.attachments);
  const { chatId } = p;
  const owner = svc.sendOwners.get(chatId) ?? {};
  svc.sendOwners.set(chatId, owner);
  const assertCurrent = () => {
    if (p.deadline !== undefined && Date.now() >= p.deadline)
      throw new Error('This message took too long to prepare. Retry it when ready.');
    stopped?.();
    // a message waiting behind a running turn is not sent for a phone the Mac removed meanwhile
    svc.assertPaired(client);
    if (svc.ops.reachable) reachable(svc, chatId);
    if (svc.sendOwners.get(chatId) !== owner) throw new Error('This message was stopped before it could be sent. Retry it when ready.');
  };
  const pending = (svc.sends.get(chatId) ?? Promise.resolve()).then(() => {
    assertCurrent();
    return svc.ops.send(p, assertCurrent, admit);
  });
  const tail = pending.then(
    () => undefined,
    () => undefined,
  );
  svc.sends.set(chatId, tail);
  void tail.then(() => {
    if (svc.sends.get(chatId) === tail) {
      svc.sends.delete(chatId);
      if (svc.sendOwners.get(chatId) === owner) svc.sendOwners.delete(chatId);
    }
  });
  return pending;
}

module.exports = {
  'chat.follow': async (svc, client, p) => {
    reachable(svc, p.chatId);
    // following starts at the snapshot's rev, so no patch after it is lost (the phone holds one that arrives before the snapshot)
    const follow = svc.cardUpdates.follow(client, p.chatId);
    const paired = svc.paired(client);
    const current = () => client.follows.owners.get(p.chatId) === follow.owner && (!paired || svc.paired(client));
    // a phone that follows (again) mid-turn starts its count for the turn from zero
    svc.budget.forget(client.pairId, p.chatId);
    try {
      return await svc.snapshot(p.chatId, p.items, current);
    } catch (error) {
      if (client.follows.requests.get(p.chatId) === follow.request) client.follows.delete(p.chatId);
      throw error;
    }
  },
  'chat.unfollow': (svc, client, p) => {
    client.follows.delete(p.chatId);
    svc.budget.forget(client.pairId, p.chatId);
    svc.mirror.recheck();
    if (!svc.followers(p.chatId).length) svc.ledger.forget(p.chatId);
    return { unfollowed: true };
  },
  // a phone pages back from the oldest row it has; a panel reads the recent end
  'chat.read': async (svc, _client, p) => {
    if (p.before === undefined) return svc.ops.read(p.chatId);
    const page = await svc.ops.older(p.chatId, p.before, p.limit);
    if (!page) throw new RemoteError('stale', 'This chat changed. Refresh it to read earlier messages.');
    return { chatId: p.chatId, ...page };
  },
  'chat.switch': async (svc, _client, p) => {
    await svc.ops.switchHarness(p);
    return { switched: true };
  },
  'chat.send': async (svc, client, p) => {
    // a phone that queued the message offline sends it again under the same id until it hears the answer; it goes to the harness once,
    // and the answer it gets is the first one, also after the Mac restarted
    const { sendId, ...message } = p;
    const began = Date.now();
    const stopped = svc.ops.sendCheck?.(p.chatId);
    const took = () => (client.kind === 'phone' ? Date.now() - began : undefined);
    if (!sendId) return sentReply(await sendOrdered(svc, client, p), took());
    const key = sendKey(client, 'chat.send', p.chatId, sendId);
    const { deadline: _deadline, nativeMessageId: _native, ...payload } = message;
    return ledgerOf(svc).run(
      key,
      payloadOf(payload),
      () => beforeSend(async (admit) => sentReply(await sendOrdered(svc, client, message, admit, stopped), took())),
      {
        key: `${client.kind === 'phone' ? client.pairId : 'panel'}:${p.chatId}:${sendId}`,
        what: fingerprint(p),
      },
    );
  },
  'chat.stop': async (svc, _client, p) => {
    svc.sendOwners.delete(p.chatId);
    await svc.ops.stop(p.chatId);
    return { stopped: true };
  },
  // the app's Remove on a queued message; removed is false when it already went out (or was never the user's)
  'chat.queue.cancel': async (svc, _client, p) => {
    reachable(svc, p.chatId);
    return { removed: !!svc.ops.unqueue(p.chatId, p.id) };
  },
  // the app's Retry on a queued message a machine's Host refused: it goes again under its own key; retried is false when it is no longer there
  'chat.queue.retry': async (svc, _client, p) => {
    reachable(svc, p.chatId);
    const sent = await svc.ops.requeue(p.chatId, p.id);
    return sent ? { retried: true, status: sent.status, ...(sent.error ? { error: String(sent.error) } : {}) } : { retried: false };
  },
  'chat.open': async (svc, _client, p) => {
    await svc.ops.open(p.chatId, p.page);
    return { opened: true };
  },
  'dictation.begin': (svc, _client, p) => {
    if (!svc.ops.dictation.begin) throw new Error(UPDATE_EXTENSION);
    return svc.ops.dictation.begin(p.clientId, p.target, p.generation);
  },
  'dictation.end': async (svc, _client, p) => {
    await svc.ops.dictation.end?.(p.capture, p.clientId, p.generation);
    return { released: true };
  },
};
