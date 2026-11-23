// One remote outbox delivery: validate the exact owner/folder, upload negotiated images, then register the sent-input projection immediately before dispatch.
const { uploadImages } = require('./imageTransfer.cjs');
const { uploadFiles } = require('./fileTransfer.cjs');
const { isHostMode } = require('../../shared/host/permissions.mjs');
const { assertTaken } = require('../../shared/host/startRefusal.mjs');
const { remoteAttachmentKind } = require('../../shared/host/attachmentKinds.mjs');
const { SIDE_CHAT_PARENT_CHANGED, SIDE_CHAT_PARENT_CHANGED_WORDS } = require('../../shared/host/sideChats.mjs');
const { withSelections } = require('../../shared/selections.mjs');
const MOVED = 'The chat now belongs to another machine.';
const NO_PLAN = "Plan mode isn't available on a machine yet. Turn it off and send again.";
const NO_ATTACHMENTS = 'Only images, files, folders and selected text can be attached to a remote machine. Remove the rest and send again.';

async function deliverRemote(
  entry,
  owner,
  host,
  {
    checks,
    subscribed,
    disposed,
    outbox,
    ownerOf,
    state,
    projection,
    hostFor,
    kindOf,
    scopeOf,
    sideStart = /** @type {import('./remoteSend.cjs').ChatStart | undefined} */ (undefined),
  },
) {
  const chatId = entry.chatId;
  const {
    item,
    start: queuedStart,
    shown,
  } = /** @type {{ item: any, shown?: boolean, start?: import('./remoteSend.cjs').ChatStart }} */ (entry.options);
  const start = sideStart ?? queuedStart;
  let deliveryFolder = owner.folder;
  const check = () => {
    if (disposed() || hostFor(owner.hostId) !== host)
      throw Object.assign(new Error('The machine is not reachable.'), { code: 'host_unreachable' });
    if (!outbox.pending(chatId).some((e) => e.key === entry.key && e.state === 'queued'))
      throw Object.assign(new Error('This message was removed.'), { code: 'request_retired' });
    const current = ownerOf(chatId);
    if (current.hostId !== owner.hostId || current.epoch !== entry.epoch) throw Object.assign(new Error(MOVED), { code: 'stale_epoch' });
    if (start?.scope !== undefined && scopeOf(owner.hostId) !== start.scope)
      throw Object.assign(new Error('This machine changed. Choose where to run the chat again.'), { code: 'machine_changed', app: true });
    if (current.folder !== deliveryFolder)
      throw Object.assign(new Error('The target folder changed while this message was being prepared. Retry it.'), {
        code: 'directory_missing',
      });
    if (start?.sideChat) {
      // Subscription still reconciles an earlier accepted input. A lost parent forbids a new dispatch, including a replay.
      const parent = ownerOf(start.sideChat.sourceId);
      if (
        parent.hostId !== owner.hostId ||
        (parent.ownerHostId ?? parent.hostId) !== owner.hostId ||
        parent.epoch !== start.sideChat.epoch ||
        parent.folder !== deliveryFolder
      )
        throw Object.assign(new Error(SIDE_CHAT_PARENT_CHANGED_WORDS), { code: SIDE_CHAT_PARENT_CHANGED, app: true });
    }
  };
  try {
    // a machine that came back: whichever of its "online" events comes first, the chat listens before it is sent anything (#3525)
    await checks.validate(entry);
    await subscribed?.(chatId);
    await checks.validate(entry);
    if (disposed()) throw Object.assign(new Error('The machine is not reachable.'), { code: 'host_unreachable' });
    if (!outbox.pending(chatId).some((e) => e.key === entry.key && e.state === 'queued')) return false;
    const now = ownerOf(chatId);
    deliveryFolder = now.folder;
    if (now.hostId !== owner.hostId || now.epoch !== entry.epoch) throw Object.assign(new Error(MOVED), { code: 'stale_epoch' });
    check();
    const { opts } = item;
    if (opts?.plan) throw Object.assign(new Error(NO_PLAN), { code: 'unsupported' });
    const attached = item.attachments ?? [];
    if (attached.some((a) => !remoteAttachmentKind(a.kind)))
      throw Object.assign(new Error(NO_ATTACHMENTS), { code: 'unsupported', app: true });
    // Use the same quote and annotation format the composer draws. Older Hosts already take it as text.
    const text = withSelections(
      item.text,
      attached.filter((a) => a.kind === 'selection'),
    );
    const pictures = attached.filter((a) => a.kind === 'image');
    const images = await uploadImages({ host, chatId, epoch: entry.epoch, attachments: pictures, check });
    const files = await uploadFiles({ host, chatId, epoch: entry.epoch, attachments: attached.filter((a) => a.kind === 'file'), check });
    check();
    const pick = { ...(opts?.model ? { model: opts.model } : {}), ...(opts?.effort ? { effort: opts.effort } : {}) };
    // the Host runs a chat in the folder it was given with the chat's first message, or with a later one if it lost the session
    const cwd = typeof now.folder === 'string' && now.folder ? { cwd: now.folder } : {};
    // who wrote it rides with the message, so the turn it starts says whether a person did (a Host that cannot carry it leaves it out)
    const human = opts?.human === true ? { human: true } : {};
    // into the turn that is running there, when the person chose that and the agent takes it (frozen with the message at keep); a Host that does not know the word queues it
    const steer = opts?.steer === true ? { followUp: 'steer' } : {};
    // the message sets the chat's goal (its text is the objective): a Host that cannot is refused by the gate, never sent plain text
    const goal = opts?.goal ? { goal: true } : {};
    // the agent it runs on, for the key the Mac lends with it (never sent to the Host): the one a held switch moves the chat to, which this message settles
    const lendAs = state()?.get(chatId)?.pendingSwitch?.harness ?? kindOf?.(chatId);
    // the mode the chat is in here is the one its turn runs under there: a Host that was never told it runs the chat in its own default
    // the mode frozen with the message when it was queued (remotePicks), never one picked later
    const mode = isHostMode(opts?.hostMode) ? opts.hostMode : null;
    // with Plan, the mode the person had picked, which Plan keeps as the one its tools run under
    const base = mode === 'plan' && isHostMode(opts?.hostBase) && opts.hostBase !== 'plan' ? opts.hostBase : null;
    // Register immediately before dispatch: the stream can beat the RPC reply.
    // each picture keeps the digest its upload made, so the saved message names the machine's copy even when the Host's echo of it carries no reference
    let at = 0;
    const named = pictures.length
      ? { ...item, attachments: attached.map((a) => (a.kind === 'image' ? { ...a, imageId: images[at++] } : a)) }
      : item;
    const remember = () => projection.remember(chatId, entry.key, text.trim(), named, shown === true);
    const startPending = start?.sideChat && projection.has(chatId, entry.key);
    try {
      if (start) {
        remember();
        if (start.sideChat) projection.project(chatId);
        assertTaken(
          await host.start(
            chatId,
            {
              text,
              ...(images.length ? { images } : {}),
              ...(files.length ? { files } : {}),
              harness: start.harness,
              ...(start.sideChat ? { sideChat: start.sideChat } : {}),
              projectId: start.projectId ?? null,
              // the credential the person chose for this chat; the Host keeps and enforces it (a Host without `logins` is refused by the gate)
              ...(start.credential ? { credential: start.credential } : {}),
              ...cwd,
              ...pick,
              ...(mode ? { permission: mode } : {}),
              ...(base ? { planBase: base } : {}),
              ...human,
              ...goal,
            },
            { key: entry.key },
          ),
        );
      } else {
        // A refused mode retains the input; never run it under permissions other than the selected ones.
        if (base) await host.permit({ chatId, value: base });
        if (mode) await host.permit({ chatId, value: mode });
        if (disposed()) throw Object.assign(new Error('The machine is not reachable.'), { code: 'host_unreachable' });
        const current = ownerOf(chatId);
        if (current.hostId !== owner.hostId || current.epoch !== entry.epoch)
          throw Object.assign(new Error(MOVED), { code: 'stale_epoch' });
        if (!outbox.pending(chatId).some((e) => e.key === entry.key && e.state === 'queued')) return false;
        check();
        remember();
        const reply = await host.send(
          chatId,
          {
            text,
            ...(images.length ? { images } : {}),
            ...(files.length ? { files } : {}),
            ...cwd,
            ...pick,
            ...human,
            ...steer,
            ...goal,
            ...(lendAs ? { lendAs } : {}),
          },
          { key: entry.key },
        );
        assertTaken(reply);
        // taken into the turn that is running: nothing starts a turn for it, so its row is retired when that turn ends (a steered message is shown as sent, never as one to send again)
        if (reply?.action === 'steered') projection.steered?.(chatId, entry.key);
      }
    } catch (error) {
      // A later attempt can fail before the Host looks up the original key, so it cannot resolve an existing uncertainty.
      const uncertain =
        startPending || (error?.code === 'host_unreachable' && error.notSent !== true) || error?.code === 'request_interrupted';
      if (!start?.sideChat || !uncertain) projection.forget(chatId, entry.key);
      throw error;
    }
    return true;
  } catch (error) {
    if (error?.code === 'request_retired') return false;
    throw error;
  }
}
module.exports = { deliverRemote, MOVED, NO_ATTACHMENTS, NO_PLAN };
