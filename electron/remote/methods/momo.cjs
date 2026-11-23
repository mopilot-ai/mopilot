// The remote methods on MoMo (phones only): its main chat, memory, open loops, routines, brain, state and settings, and the cards it raises. While MoMo is paused only Run now is refused (it starts MoMo's own work); the user's own edits, answers and messages go through, as on the Mac (#3648). Each runs MoMo's operations (remote/momoOps.cjs); the service has already refused every one for an account MoMo isn't allowed for.
const { RemoteError } = require('../serviceErrors.cjs');
const { beforeSend } = require('../sendLedger.cjs');
const { transcribeUpload } = require('../chunks.cjs');
const { ledgerOf, payloadOf, sendKey } = require('../sendIdentity.cjs');

const { MOMO_DEFAULTS } = require('../../../shared/momoPrefs.mjs');

const STALE = 'That request was already answered.';

/** MoMo's operations, once main made them. */
function opsOf(/** @type {any} */ svc) {
  const ops = svc.momo();
  if (!ops) throw new RemoteError('failed', 'MoMo is not ready.');
  return ops;
}

/** The chat a request reaches: MoMo's main chat unless it names a channel (A2), whose journal is made on first use when `make`. */
const chatOf = (/** @type {any} */ ops, /** @type {string | undefined} */ channelId, make = true) =>
  channelId === undefined ? ops.mainChatId() : ops.chatFor(channelId, make);

/**
 * A phone's answer to a MoMo card, checked the way a window's is: the device follows the chat, the card is still up, the
 * rev is not older than the card's, and the key is one the card offered. MoMo's chat is kept out of the coding side's
 * answer path (momo/toolIsolation.cjs), so this is its own.
 */
async function answer(/** @type {any} */ svc, /** @type {any} */ client, /** @type {any} */ p) {
  const ops = opsOf(svc);
  const chatId = await chatOf(ops, p.channelId, false);
  if (!chatId || !client.follows.has(chatId)) throw new RemoteError('forbidden', 'Follow this chat to answer its cards.');
  const state = svc.ops.state.get(chatId);
  const card = (await svc.ops.cardsOf(chatId)).find((c) => c.id === p.cardId);
  const approval = ops.cardOf(chatId, p.cardId);
  if (!card || !approval) throw new RemoteError('stale', STALE);
  svc.ledger.note(chatId, card.version, state.rev);
  if (p.rev < svc.ledger.revOf(chatId, card.version)) throw new RemoteError('stale', STALE);
  if (!card.choices?.some((c) => c.key === p.key)) throw new RemoteError('invalid', 'Choose an option offered by this request.');
  // the reads above awaited: a phone the Mac removed meanwhile does not answer
  svc.assertPaired(client);
  if (!ops.answerCard(approval, p.key, client.pairId)) throw new RemoteError('stale', STALE);
  return { answered: true };
}

/** MoMo's home API (momo/homeSlot.cjs), once main has one. */
function homeOf(/** @type {any} */ svc) {
  const home = svc.momoHome?.api();
  if (!home) throw new RemoteError('failed', 'MoMo’s home isn’t available here yet.');
  return home;
}

module.exports = {
  // MoMo's home: the one view and the one intent both clients use (shared/momoHomeApi.mjs); a phone is the owner's device, so any intent is the owner's
  // the phone's Google steps, relayed to the home's Host: only `host.momoGoogle`, whatever the phone sends (the Host parses the op and its parameters)
  'momo.home.google': (svc, _client, p) => {
    const home = homeOf(svc);
    if (typeof home.hostCall !== 'function') throw new RemoteError('failed', 'MoMo’s home isn’t available here yet.');
    // the home's refusal ("MoMo isn't running anywhere right now") is an IntentError (an ES module this one cannot load synchronously): its words go to the phone as they are
    return Promise.resolve(home.hostCall('host.momoGoogle', p)).catch((/** @type {any} */ error) => {
      throw error?.name === 'IntentError' ? new RemoteError('failed', error.message) : error;
    });
  },
  'momo.home.view': (svc) => homeOf(svc).view(),
  'momo.home.intent': (svc, _client, p) => homeOf(svc).intent(p.intent),
  'momo.chat.follow': async (svc, client, p) => {
    const paired = svc.paired(client);
    // MoMo's main chat, or the journal of the channel `channelId` names (made on its first follow)
    const chatId = await chatOf(opsOf(svc), p.channelId);
    if (paired) svc.assertPaired(client);
    // following starts at the snapshot's rev, so no patch after it is lost
    const follow = svc.cardUpdates.follow(client, chatId);
    const current = () => client.follows.owners.get(chatId) === follow.owner && (!paired || svc.paired(client));
    try {
      return await svc.snapshot(chatId, p.items, current);
    } catch (error) {
      if (client.follows.requests.get(chatId) === follow.request) client.follows.delete(chatId);
      throw error;
    }
  },
  'momo.chat.unfollow': async (svc, client, p) => {
    const chatId = await chatOf(opsOf(svc), p.channelId, false);
    if (!chatId) return { unfollowed: true };
    client.follows.delete(chatId);
    if (!svc.followers(chatId).length) svc.ledger.forget(chatId);
    return { unfollowed: true };
  },
  'momo.chat.send': async (svc, client, p) => {
    const ops = opsOf(svc);
    const chatId = await chatOf(ops, p.channelId);
    const stopped = svc.ops.sendCheck?.(chatId);
    const check = () => {
      svc.assertPaired(client);
      if (!svc.momoAllowed()) throw new RemoteError('forbidden', 'MoMo is not available.');
      if (p.expectedChatId !== undefined && p.expectedChatId !== chatId)
        throw new RemoteError('stale', 'MoMo’s main chat changed. Read it before sending.');
      stopped?.();
    };
    check();
    return ledgerOf(svc).run(sendKey(client, 'momo.chat.send', chatId, p.id), payloadOf({ text: p.text, followUp: p.followUp }), () =>
      beforeSend(async (admit) => {
        check();
        const warning = await ops.send(chatId, p, check, admit);
        return { sent: true, ...(warning ? { warning: String(warning) } : {}) };
      }),
    );
  },
  // A voice note for MoMo's chat: the recording the phone sent in parts (chat.attach) is turned into text on this Mac's own speech
  // setup and not kept with the recordings. Only text comes back; the phone shows it in its composer and sends it with momo.chat.send,
  // so the send's dedup, hold and invite check apply to it as to any message. Allowed while MoMo is paused, as a typed message is.
  'momo.chat.transcribe': async (svc, client, p) => {
    opsOf(svc).assertAllowed();
    // a voice note for a channel's composer: the channel must still be there (the text goes back to the phone, which sends it with momo.chat.send)
    if (p.channelId !== undefined) opsOf(svc).channels.assertChannel(p.channelId);
    svc.assertPaired(client);
    if (!svc.momoAllowed()) throw new RemoteError('forbidden', 'MoMo is not available.');
    const { text } = await transcribeUpload(svc, client, p, { keep: false });
    svc.assertPaired(client);
    return { text };
  },
  'momo.chat.stop': async (svc, client, p) => {
    const ops = opsOf(svc);
    const chatId = await chatOf(ops, p.channelId, false);
    svc.assertPaired(client);
    // a channel with no chat yet has nothing to stop
    if (chatId) await ops.stop(chatId);
    return { stopped: true };
  },
  'momo.card.answer': answer,
  'momo.memory.list': (svc) => opsOf(svc).memory.list(),
  'momo.memory.search': (svc, _client, p) => opsOf(svc).memory.search(p.query),
  'momo.memory.edit': (svc, _client, p) => opsOf(svc).memory.edit(p.factId, p.text),
  'momo.memory.forget': async (svc, _client, p) => ({ forgotten: true, ...(await opsOf(svc).memory.forget(p.factId)) }),
  'momo.memory.docs': (svc) => opsOf(svc).memory.docs(),
  'momo.memory.changes': (svc) => opsOf(svc).memory.changes(),
  'momo.memory.undo': (svc, _client, p) => opsOf(svc).memory.undo(p.changeId),
  'momo.memory.past': (svc) => opsOf(svc).memory.past(),
  'momo.memory.writeDoc': async (svc, _client, p) => {
    await opsOf(svc).memory.writeAboutYou(p.text);
    return { written: true };
  },
  'momo.loops.list': (svc) => opsOf(svc).loops.list(),
  'momo.loops.act': (svc, _client, p) => opsOf(svc).loops.act(p.loopId, { action: p.action, ...(p.snooze ? { snooze: p.snooze } : {}) }),
  // read only, as the loops list: answered while MoMo is paused too
  'momo.tasks.list': (svc) => opsOf(svc).tasks.list(),
  // the user's own mark: only this and the Mac's window ever set one, so it is a phone's explicit request, never MoMo's
  'momo.tasks.mark': (svc, _client, p) => opsOf(svc).tasks.mark(p.taskId, p.mark, p.undoToken),
  // what MoMo suggested: read while paused too; the user's own Add, Start or Hide (Start sends the first step to MoMo's chat on the Mac)
  'momo.suggestions.list': (svc) => opsOf(svc).suggestions.list(),
  'momo.suggestions.act': (svc, _client, p) => opsOf(svc).suggestions.act(p.id, p.action),
  // Try again on the morning brief: the Mac writes it now, as the user's own request
  'momo.brief.runNow': async (svc) => ({ ran: true, ...(await opsOf(svc).brief.runNow()) }),
  // MoMo not made yet (it failed to start, or is starting): offline, under its default name
  'momo.state.get': (svc) => {
    const ops = svc.momo();
    if (!ops) return { name: MOMO_DEFAULTS.persona.name, color: MOMO_DEFAULTS.persona.color, status: 'offline', needsYou: 0 };
    return ops.state();
  },
  'momo.prefs.get': (svc) => opsOf(svc).prefs.get(),
  'momo.prefs.set': (svc, _client, p) => opsOf(svc).prefs.set(p),
  'momo.routines.list': (svc) => opsOf(svc).routines.list(),
  'momo.routines.pause': async (svc, _client, p) => ({ routine: await opsOf(svc).routines.pause(p.id) }),
  'momo.routines.resume': async (svc, _client, p) => ({ routine: await opsOf(svc).routines.resume(p.id) }),
  'momo.routines.run': async (svc, _client, p) => {
    const ops = opsOf(svc);
    // Run now starts MoMo's own work, which a pause holds, as the Mac's runner does
    ops.awake();
    await ops.routines.run(p.id);
    return { started: true };
  },
  'momo.routines.approve': async (svc, _client, p) => ({ routine: await opsOf(svc).routines.approve(p.id, p.seen) }),
  'momo.routines.edit': async (svc, _client, p) => ({ routine: await opsOf(svc).routines.edit(p.id, p.edit) }),
  'momo.routines.delete': async (svc, _client, p) => {
    await opsOf(svc).routines.remove(p.id);
    return { deleted: true };
  },
  'momo.sources.status': (svc) => opsOf(svc).sources.status(),
  // reads only: answered while MoMo is paused too
  'momo.activity.list': (svc) => opsOf(svc).activity.list(),
  'momo.brain.get': (svc) => opsOf(svc).brain.get(),
  'momo.brain.set': (svc, _client, p) => {
    const { brain } = opsOf(svc);
    if (!brain.allowedToSet()) throw new RemoteError('forbidden', 'Allow brain changes from this Mac first.');
    return brain.set(p.brain);
  },
};
