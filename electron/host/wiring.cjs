// The Host wiring main does: the local Host over the services electron/app/sessions.cjs builds (which chats it owns and lists, how a family stops, the permission it accepts), and the remote sends (the outbox, the ownership side map and the machines service joined).
const path = require('node:path');
const { createLocalHost } = require('./local.cjs');
const { createOutbox } = require('./outbox.cjs');
const { createRemoteSend } = require('./remoteSend.cjs');
const { createRemoteChats } = require('./remoteChats.cjs');
const { LOCAL_HOST_ID, OwnershipStore } = require('./ownership.cjs');
const { PatchLog } = require('./patchLog.cjs');
const { parseKind } = require('../../shared/harnessKind.mjs');
const { isMomoMeta } = require('../../shared/momoChat.mjs');
const { createDeletionOutbox } = require('./deletionOutbox.cjs');
const { within } = require('./boundedWait.cjs');
const { loadIdentity } = require('./pairingClient.cjs');
const { noteIgnored } = require('../ignored.cjs');
const { isEnabled } = require('../platform/flags.cjs');
const { PERMISSION_ORDER } = require('../../shared/permissionMenu.mjs');
const { registerAttention } = require('./attentionLane.cjs');
const { hostFamilyOfHarness } = require('../../shared/host/chatIds.mjs');
const { sideChatUuid } = require('../../shared/host/sideChats.mjs');

/**
 * @param {object} o
 * @param {any} o.live main's services for reading saved chat records and persisting preferences after sessions open
 * @param {any} o.controller the ChatController
 * @param {{ has: (chatId: string) => boolean, snapshot: (chatId: string) => { rev: number }, publish: Function }} o.sessions the SessionStore
 * @param {{ stop: (chatId: string) => unknown }} o.claudeTurns
 */
function localHostFor({ live, controller, sessions, claudeTurns }) {
  // the store publishes each patch to the windows; the Host keeps a tail of them to replay to a subscriber that fell behind
  const log = new PatchLog();
  const publish = sessions.publish;
  sessions.publish = (p) => {
    log.record(p);
    // the cards of a chat on another machine: three unanswered periods in a row pause its run (remoteSend.cjs); null while Host is off
    if (/** @type {any} */ (p).patch?.approvals) live.remoteSend?.()?.onSessionPatch(p);
    return publish.call(sessions, p);
  };
  return createLocalHost({
    controller: () => controller,
    state: () => sessions,
    claudeTurns: () => claudeTurns,
    family: (chatId) => parseKind(controller.ref(chatId).kind)?.family ?? '',
    log,
    // a chat with a record, or one whose state a harness event already started
    owns: (chatId) => live.chats.records.has(chatId) || sessions.has(chatId),
    // MoMo's own chats are on no list
    list: () => [...live.chats.records].filter(([, rec]) => !isMomoMeta(rec.meta)).map(([id]) => id),
    permit: (p) => {
      if (!PERMISSION_ORDER.includes(/** @type {any} */ (p.value))) throw new Error("That permission isn't one MoPilot has.");
      return live.patchPrefs({ permission: p.value });
    },
  });
}

/**
 * @param {object} o
 * @param {string} o.dir the user data dir
 * @param {() => boolean} o.allowed Host's closed-alpha gate (electron/host/access.cjs)
 * @param {() => { hostFor: (id: string) => any, row: (id: string) => any, onRowChange: (fn: () => void) => () => void }} o.machines main's machines service
 * @param {() => any} o.state the sessions' state, where a chat's queue is shown
 * @param {(item: any, origin: number | null) => any} o.tray
 * @param {(chatId: string) => void} [o.paused]
 * @param {() => boolean} [o.unattended] the app flag host.unattended (default: the flag)
 * @param {number} [o.approvalMs] how long an approval card may wait before a timeout counts (remoteSend's default when not given)
 * @param {(chatId: string, item: any) => Promise<any>} [o.localSend]
 * @param {(chatId: string) => Promise<void> | void} [o.subscribed] resolves once the chat's stream is subscribed on its machine's connection (remoteChats.cjs)
 * @param {(chatId: string) => boolean} [o.canSend] whether a temporary chat still belongs to this app run
 * @param {(hostId: string, folder: string) => Promise<unknown>} [o.checkFolder] a durable phone input rechecks its folder after a restart
 * @param {(chatId: string) => import('../../shared/host/models.mjs').HostModelPick | null | undefined} [o.selectionOf]
 * @param {(chatId: string) => import('../../shared/host/permissions.mjs').HostPermissionPick | null | undefined} [o.permissionOf]
 * @param {() => string | undefined} [o.userDefaultOf] this Mac's default permission mode: where a chat on a machine starts when it has no pick and no mode of its own
 * @param {(chatId: string) => string | undefined} [o.kindOf]
 * @param {(hostId: string) => unknown} [o.wake] a stopped cloud machine is woken for a message waiting for it (cloudWake.cjs)
 * @param {(error: Error) => void} o.report
 * @returns {() => ReturnType<typeof createRemoteSend> | null} the service, or null while Host is off
 */
function remoteSendFor({
  dir,
  allowed,
  machines,
  state,
  tray,
  paused,
  approvalMs,
  unattended = () => isEnabled('host.unattended'),
  localSend,
  subscribed,
  canSend,
  checkFolder,
  selectionOf,
  permissionOf,
  userDefaultOf,
  kindOf,
  wake,
  report,
}) {
  /** @type {ReturnType<typeof createRemoteSend> | null} */
  let service = null;
  /** @type {InstanceType<typeof OwnershipStore> | null} */
  let owners = null;
  // the file is read again each time: another process may have moved the chat
  const ownerStore = () => {
    owners ??= new OwnershipStore(path.join(dir, 'host-ownership.json'));
    owners.refresh();
    return owners;
  };
  const ownerOf = (/** @type {string} */ chatId) => ownerStore().get(chatId);
  return () => {
    if (!allowed()) return null;
    return (service ??= createRemoteSend({
      outbox: createOutbox({ dir: path.join(dir, 'host-outbox'), report }),
      ownerOf,
      hostFor: (id) => machines().hostFor(id),
      rowOf: (id) => machines().row(id),
      onRowChange: (fn) => machines().onRowChange(fn),
      state,
      tray,
      paused,
      ...(approvalMs === undefined ? {} : { approvalMs }),
      engineOwns: (hostId) => unattended() && machines().hostFor(hostId)?.speaks?.('approvals2') === true,
      localSend,
      subscribed,
      canSend,
      checkFolder,
      selectionOf,
      permissionOf,
      userDefaultOf,
      kindOf,
      wake,
      followMove: (chatId, details) => {
        const to = /** @type {any} */ (details)?.targetHostId;
        const epoch = /** @type {any} */ (details)?.epoch;
        const store = ownerStore();
        if (typeof to !== 'string' || !Number.isSafeInteger(epoch) || epoch <= store.get(chatId).epoch) return false;
        store.set(chatId, { hostId: to, ownerHostId: to, epoch, folder: null });
        return true;
      },
      report,
    }));
  };
}

/**
 * The approval timeout an unpackaged build is asked to use (MOPILOT_HOST_APPROVAL_MS, milliseconds), so a spec can see three timeouts pause a run without waiting half an hour; a packaged app ignores it.
 * @param {Record<string, string | undefined>} env @param {boolean} packaged
 * @returns {number | undefined}
 */
function devApprovalMs(env, packaged) {
  const ms = Number(env.MOPILOT_HOST_APPROVAL_MS);
  return !packaged && Number.isSafeInteger(ms) && ms > 0 ? ms : undefined;
}

/**
 * The chats that run on a remote Host, followed from this app: their events reach the ACP host's event bus and their transcripts (electron/host/remoteChats.cjs).
 * @param {object} o
 * @param {string} o.dir the user data dir
 * @param {() => boolean} o.allowed Host's closed-alpha gate (electron/host/access.cjs)
 * @param {() => { hostFor: (id: string) => any, row?: (id: string) => any }} o.machines main's machines service
 * @param {() => { items: any, emitEvent: (event: object) => void, questions?: any } | undefined} o.acpHost main's ACP host, which is set up after the sessions
 * @param {(chatId: string) => boolean} [o.canFollow] whether a temporary chat still belongs to this app run
 * @param {() => any} [o.state] main's session store, where a chat's goal and background tasks are shown from
 * @param {() => { forgetChat?: (chatId: string) => void, sent: { take: (chatId: string, key?: string) => string | undefined, seen: (chatId: string, text: string | undefined, key?: string) => void, attached: (chatId: string, key?: string) => any[] | undefined, settleSteered: (chatId: string) => void } } | null | undefined} [o.sender] the messages service, which keeps what was sent until the transcript has it (remoteSend.cjs)
 * @param {(error: Error) => void} [o.report] where a failure to follow a chat goes (default: the app-wide ignored-error log)
 * @param {(chatId: string, value: unknown) => void} [o.attention] told a chat's `attention` from its Host's state lane (attentionLane.cjs)
 * @param {(chatId: string, harness: string) => void} [o.agent] told the agent a chat runs on once a switch settled (`laneOf`)
 * @param {(chatId: string, note: object) => void} [o.note] told the divider of a switch the Host journaled (`laneOf`)
 * @param {() => import('../platform/secretFile.cjs').SafeStorage | null} o.safeStorage opens this app's sealed Host key (pairingClient.cjs), read when it is wanted
 */
function remoteChatsFor({
  dir,
  allowed,
  machines,
  acpHost,
  state,
  sender,
  report,
  attention,
  agent,
  note,
  safeStorage,
  canFollow = () => true,
}) {
  // this app's key id, read when wanted (a rotation changes it); a key that can't be opened now (the keychain locked) is none,
  // so a Host's event is still handled rather than lost with the error
  const keyId = () => {
    try {
      return loadIdentity(path.join(dir, 'host-client-key.json'), safeStorage()).keyId;
    } catch (error) {
      noteIgnored('read this app’s Host key', error);
      return null;
    }
  };
  const deletions = createDeletionOutbox({
    dir: path.join(dir, 'host-deletions'),
    identity: keyId,
    hostFor: (id) => machines().hostFor(id),
    rowOf: (id) => machines().row?.(id),
    enabled: allowed,
    report,
    beforeDelete: (id) => sender?.()?.forgetChat?.(id),
  });

  /** @type {ReturnType<typeof createRemoteChats> | null} */
  let service = null;
  /** @type {InstanceType<typeof OwnershipStore> | null} */
  let owners = null;
  // the file is read again each time: another process may have moved the chat
  const store = () => {
    owners ??= new OwnershipStore(path.join(dir, 'host-ownership.json'));
    owners.refresh();
    return owners;
  };
  const get = () => {
    const host = allowed() ? acpHost() : undefined;
    if (!host) return null;
    return (service ??= createRemoteChats({
      items: host.items,
      hostFor: (id) => machines().hostFor(id),
      ownerOf: (chatId) => {
        const { hostId, folder } = store().get(chatId);
        return { hostId, folder };
      },
      emit: (event) => host.emitEvent(event),
      state,
      questions: () => host.questions,
      sent: {
        take: (chatId, key) => sender?.()?.sent.take(chatId, key),
        seen: (chatId, text, key) => sender?.()?.sent.seen(chatId, text, key),
        attached: (chatId, key) => sender?.()?.sent.attached(chatId, key),
        settleSteered: (chatId) => sender?.()?.sent.settleSteered(chatId),
      },
      report,
      attention,
      agent,
      note,
      selfKey: keyId,
    }));
  };
  const chats = {
    /** The service, or null while Host is off or the sessions are not up. */
    get,
    sideChatOwner: (/** @type {string} */ chatId) => {
      const own = store();
      if (own.error) throw new Error('Could not read this chat’s machine. Try again.');
      return own.get(chatId);
    },
    /** A chat was deleted: it is no longer followed, and the ownership file forgets it, so it is not made again from the machine's stream. @param {string} chatId @param {number} [waitMs] how long to wait for the machine to take the deletion (the time left of the caller's bound) */
    async forget(chatId, waitMs) {
      if (!allowed()) return null;
      const owner = store().get(chatId);
      const remote = owner.hostId !== LOCAL_HOST_ID;
      const had = remote && deletions.queued(owner.hostId, chatId);
      const job = remote ? deletions.enqueue({ hostId: owner.hostId, chatId, epoch: owner.epoch }) : null;
      try {
        sender?.()?.forgetChat?.(chatId);
        get()?.unfollow(chatId);
        store().remove(chatId);
      } catch (error) {
        // the chat was not deleted here: a job made for this attempt must not delete its machine copy on a later reconnect
        if (job && !had) deletions.cancel(job);
        throw error;
      }
      if (sideChatUuid(chatId)) /** @type {any} */ (acpHost())?.remove?.(chatId);
      // a machine that does not answer must not hold the deletion up here: it goes on as pending, and the job stays queued for the machine's return
      await within(
        (async () => {
          await deletions.flush();
          // a flush that was already running took its list before this job existed: one more pass sends it now
          if (job && deletions.has(job)) await deletions.flush();
        })(),
        waitMs,
      );
      const pending = job !== null && deletions.has(job);
      // a machine that answers but cannot take the deletion waits for an update, not for itself: the person is told which
      return { pending, ...(pending && deletions.outdated(owner.hostId) ? { outdated: true } : {}) };
    },
    pendingDeletions: () => (allowed() ? deletions.pending() : []),
    dropMachine: (id) => deletions.dropMachine(id),
    /** Side chats expire on app exit. After a crash the first follow pass retires the previous app's side chats. */
    async retireSideChats(waitMs = 0) {
      if (!allowed()) return;
      const retired = store()
        .remoteChats()
        .filter(({ chatId }) => !canFollow(chatId));
      await Promise.all(
        retired.map(({ chatId }) => chats.forget(chatId, waitMs).catch((error) => noteIgnored('retire a temporary machine chat', error))),
      );
    },
    /** Follow every chat the ownership file puts on a remote Host: at startup and whenever a machine appears or answers. */
    followAll() {
      void chats.retireSideChats();
      if (allowed()) void deletions.flush();
      const follower = get();
      if (!follower) return;
      for (const { chatId } of store().remoteChats()) if (canFollow(chatId)) follower.follow(chatId);
    },
  };
  return chats;
}

/**
 * The Host an event comes from, for the envelope the stream batcher puts on every send: this Mac for an event outside any chat, else the Host that runs the chat (this Mac until Host is wired).
 * @param {any} live main's `live`, whose `hostOwnership` (electron/host/machines.cjs) is set up with Host
 * @param {string | null} chat
 */
function hostOfChat(live, chat) {
  return chat === null ? LOCAL_HOST_ID : (live.hostOwnership?.get(chat).hostId ?? LOCAL_HOST_ID);
}

/**
 * The routes main hands the controller and the ACP IPC for a chat that runs on another machine: Stop, a permission card's answer, the person's name for the chat, and whether a chat runs on a machine. Stop, the name and the answer are null for a chat or card of this Mac, or while Host is off.
 * @param {any} live main's `live`, whose `remoteSend` and `remoteChats` (electron/app/ipc/host.cjs) are set up with Host
 */
function remoteRoutes(live) {
  return {
    stop: (/** @type {string} */ chatId, /** @type {unknown} */ turnId) => live.remoteSend?.()?.stop(chatId, turnId) ?? null,
    owns: (/** @type {string} */ chatId) => live.remoteSend?.()?.owns(chatId) === true,
    moving: (/** @type {string} */ chatId) => live.remoteSend?.()?.moving(chatId) === true,
    hold: (/** @type {string} */ chatId, /** @type {any} */ item, /** @type {number | null} */ origin) =>
      live.remoteSend?.()?.hold(chatId, item, origin) ?? null,
    rename: (/** @type {string} */ chatId, /** @type {string} */ name) => live.remoteSend?.()?.rename(chatId, name) ?? null,
    answer: (/** @type {string} */ requestId, /** @type {string | null} */ optionId) =>
      live.remoteChats?.()?.answer(requestId, optionId) ?? null,
  };
}

/**
 * What the continue service holds of a chat that runs on a machine: the finished items and the last revision of the followed chat (electron/host/remoteChats.cjs). None for a chat that is not followed, or while Host is off.
 * @param {any} live main's `live`, whose `remoteChats` (electron/app/ipc/host.cjs) is set up with Host
 */
function mirrorFor(live) {
  return {
    mirrorRev: (/** @type {string} */ chatId) => live.remoteChats?.()?.rev(chatId) ?? 0,
    mirror: (/** @type {string} */ chatId) => live.remoteChats?.()?.mirror(chatId) ?? null,
  };
}

/**
 * Keeps the agent a machine chat runs on in the chat's own config (`hostAgent`, the wire's harness id) and tells the windows; a Host's word after a switch settled, and the agent a continue moved the chat on as.
 * @param {any} deps main's `live` and `broadcastAll` @param {string} chatId @param {string} harness
 */
function keepAgent(deps, chatId, harness) {
  const chats = deps?.live?.chats;
  const config = chats?.record(chatId).meta?.config;
  // patchMeta-changes: false means the agent is already kept (or the chat cannot be saved): there is nothing to tell the windows
  if (!chats?.patchMeta(chatId, { config: { ...config, hostAgent: harness } })) return;
  deps.broadcastAll('chats:changed', { id: chatId, chat: chats.get(chatId) });
}

/**
 * What a machine chat's state lane reaches here beyond the transcript: what the chat waits for (attentionLane.cjs) and the agent it runs on after a switch settled, kept in the chat's own config (`hostAgent`, the wire's harness id) so the picker and the labels follow it.
 * @param {any} ipcMain @param {() => boolean} allowed @param {any} deps main's `live` and `broadcastAll`
 */
function laneOf(ipcMain, allowed, deps) {
  return {
    attention: registerAttention(ipcMain, allowed, (/** @type {any} */ e) => deps?.broadcastAll('host:attention', e)).set,
    agent: (/** @type {string} */ chatId, /** @type {string} */ harness) => keepAgent(deps, chatId, harness),
    // a switch's divider among the chat's notes, once: the id names the turn, so a replay tells the same note again and adds nothing
    note: (/** @type {string} */ chatId, /** @type {any} */ note) => {
      const chats = deps?.live?.chats;
      const notes = chats?.record(chatId).meta?.notes ?? [];
      if (!chats || notes.some((/** @type {{ id: string }} */ n) => n.id === note.id)) return;
      // patchMeta-changes: the note's id is new, so the notes always change
      if (!chats.patchMeta(chatId, { notes: [...notes, note] })) return;
      deps.broadcastAll('chats:changed', { id: chatId, chat: chats.get(chatId) });
    },
  };
}

/**
 * The agent a chat runs on now, for the picks a message to a machine carries (a model, a permission mode: the current agent's, even while a switch is held, because they are applied before the switch settles): the one its Host last said after a switch (`hostAgent`, kept by `laneOf`), else this Mac's own reading of the chat.
 * @param {any} live main's `live`
 * @param {string} chatId
 */
const kindOfChat = (live, chatId) => live?.chats?.get(chatId)?.meta?.config?.hostAgent ?? wireKindOf(live?.controller?.ref?.(chatId)?.kind);

/** An adapter kind of this app as the Host's harness kind: a machine's Claude Code chat reads `acp:host-claude` here and is `claude` there. @param {string | undefined} kind */
const wireKindOf = (kind) => {
  const parsed = parseKind(kind);
  if (!parsed) return undefined;
  // an ACP kind always names its basic agent
  const basic = /** @type {string} */ (parsed.basic);
  return parsed.family === 'acp' ? (hostFamilyOfHarness(basic) ?? `acp:${basic}`) : parsed.family;
};

module.exports = {
  registerAttention,
  laneOf,
  keepAgent,
  kindOfChat,
  mirrorFor,
  hostOfChat,
  localHostFor,
  remoteChatsFor,
  remoteRoutes,
  remoteSendFor,
  devApprovalMs,
};
