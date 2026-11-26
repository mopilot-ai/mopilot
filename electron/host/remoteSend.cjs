// A message to a chat that runs on a remote Host: kept in the outbox before it goes anywhere, shown in the chat's queue as "Waiting for host" while the machine is away, sent in order under its own key when it returns, and done only when the Host has it on record.
const crypto = require('node:crypto');
const { deliverRemote, NO_ATTACHMENTS, NO_PLAN } = require('./remoteSendDelivery.cjs');
const { remoteAttachmentKind } = require('../../shared/host/attachmentKinds.mjs');
const { waitingFor } = require('./outbox.cjs');
const { createSwitch } = require('./remoteSwitch.cjs');
const { createRebase } = require('./remoteSendRebase.cjs');
const { PEER_REASONS } = require('../../shared/peerReasons.mjs');
const { createGoal } = require('./remoteGoal.cjs');
const { createRename } = require('./remoteRename.cjs');
const { createApprovalWaits } = require('./remoteSendApprovals.cjs');
const { createSendChecks } = require('./remoteSendChecks.cjs');
const { createSendProjection } = require('./remoteSendProjection.cjs');
const { createRefusalView } = require('./refusalView.cjs');
const { picksFor } = require('./remotePicks.cjs');
const { LOCAL_HOST_ID } = require('./ownership.cjs');

/** A card nobody answered for this long is one approval timeout; the third in a row pauses the run (design/host: Offline and queueing). */
const APPROVAL_MS = 10 * 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The organization sign-in on this Mac ended: the message waits for one more sign-in here, then goes (orgSignedIn). */
const ORG_SIGNIN = 'org_signin_required';
const MOVED = 'The chat now belongs to another machine.';
/** What the row says of a message handed to the controller whose delivery nobody confirmed: the wording peer messages use for the same state. */
const UNCONFIRMED = PEER_REASONS.delivery_still_unknown;
const STOP_AWAY = "Can't reach the machine, so Stop did not arrive. The run goes on there.";

/**
 * @typedef {{ get: (chatId: string) => { queue: any[], permission?: string | null, pendingSwitch?: unknown }, patch: (chatId: string, p: { queue: any[] }) => unknown }} QueueState
 * @typedef {{ send: Function, start: Function, stop: Function, switchTo: Function, goal: Function, rename: Function, permit: Function, state: () => string, onState: (fn: (s: string) => void) => () => void, connect: () => Promise<void> }} RemoteHost
 * @typedef {{ harness: string, projectId?: string | null, credential?: { source: string, login?: string }, scope?: string, sideChat?: import('../../shared/host/sideChats.mjs').SideChatStart }} ChatStart how a chat is started on its Host: its first message goes with this
 */

/**
 * @param {object} o
 * @param {ReturnType<typeof import('./outbox.cjs').createOutbox>} o.outbox
 * @param {(chatId: string) => { hostId: string, ownerHostId?: string, epoch: number, folder?: string | null }} o.ownerOf the ownership side map's record for the chat (a chat nobody claimed is local); its folder is where the Host runs the chat
 * @param {(hostId: string) => RemoteHost | null} o.hostFor the connection to a machine; null when there is none to make
 * @param {(hostId: string) => { status?: string, name?: string, hostKey?: string, harnesses?: { id: string, planMode?: boolean }[] } | undefined} o.rowOf the registry's row for a machine (its name, and its agents with what its Host said of each)
 * @param {() => QueueState} o.state the sessions' state, where a chat's queue is shown
 * @param {(item: any, origin: number | null) => any} o.tray a message as the chat's queue stores it
 * @param {(chatId: string) => void} [o.paused] tells the user a run was paused for unanswered approvals
 * @param {(chatId: string, item: any) => Promise<{ action?: string, error?: string } | null | undefined>} [o.localSend] delivers a message to a chat that runs here (a chat continued back to this Mac)
 * @param {number} [o.approvalMs] how long cards may wait before a timeout counts
 * @param {(hostId: string) => boolean} [o.engineOwns] whether the machine's own approval engine keeps the clock (it agreed on approvals2 and the app flag is on): then this app reads the pause and starts no timer of its own
 * @param {() => string} [o.mintKey]
 * @param {(fn: () => void) => () => void} [o.onRowChange] the registry's row changed (a heartbeat, a status): a machine whose connection came up first may be usable now; returns the way to stop listening
 * @param {(chatId: string) => Promise<void> | void} [o.subscribed] resolves once the chat's stream is subscribed on the connection that is up (remoteChats.cjs): a message goes after it, so its reply is heard from its first word
 * @param {(chatId: string) => boolean} [o.canSend] whether a temporary chat still belongs to this app run
 * @param {(chatId: string, details: unknown) => boolean} [o.followMove] the Host says it handed the chat to another machine (a refusal's `details`): the side map follows when that is newer than what it holds; true when it moved
 * @param {(hostId: string, folder: string) => Promise<unknown>} [o.checkFolder] revalidates a phone's durable folder gate after restart
 * @param {(chatId: string) => import('../../shared/host/models.mjs').HostModelPick | null | undefined} [o.selectionOf] the chat's persisted machine-scoped model pick
 * @param {(chatId: string) => import('../../shared/host/permissions.mjs').HostPermissionPick | null | undefined} [o.permissionOf]
 * @param {() => string | undefined} [o.userDefaultOf] this Mac's default permission mode: where a chat on a machine STARTS when it has no pick and no mode of its own; a chat that already runs there keeps the mode its Host reports
 * @param {() => { takenIn?: (chatId: string) => boolean, refreshEpoch?: (chatId: string) => boolean } | undefined} [o.taken] the chats taken in from a machine's list (electron/app/machineChatAdoption.cjs): one keeps the mode its Host reports, and one the Host refuses for its epoch reads it again and is sent once more
 * @param {(chatId: string) => string | undefined} [o.kindOf] current adapter kind for continued or switched chats
 * @param {(hostId: string) => unknown} [o.wake] the machine looked offline with a message waiting: a stopped cloud machine is woken (cloudWake.cjs)
 * @param {(error: Error) => void} [o.report]
 */
function createRemoteSend({
  wake,
  outbox,
  ownerOf,
  hostFor,
  rowOf,
  state,
  tray,
  paused,
  localSend,
  followMove,
  onRowChange,
  subscribed,
  canSend = () => true,
  checkFolder,
  approvalMs = APPROVAL_MS,
  engineOwns = () => false,
  mintKey = () => crypto.randomUUID(),
  selectionOf = () => null,
  permissionOf = () => null,
  userDefaultOf = () => undefined,
  taken = () => undefined,
  kindOf = () => undefined,
  report = () => undefined,
}) {
  /** Messages the Host refused, with its code and sentence, until the user deletes them or the process restarts: the queue says them in words (refusalView.cjs). @type {Map<string, { code: string, message: string, details?: Record<string, unknown>, agentWas?: any, own?: boolean }>} */
  const refused = new Map();
  // the agent the Host checks is the one a held switch sends as (remoteSendDelivery), else the chat's own
  const refusals = createRefusalView({
    rowOf,
    kindOf: (chatId) => /** @type {any} */ (state()?.get(chatId))?.pendingSwitch?.harness ?? kindOf(chatId),
    ownerOf,
  });
  /** What the Host's refusal of a kept message says now. @param {string} chatId @param {string} key */
  const refusalLine = (chatId, key) =>
    refusals.view(chatId, /** @type {NonNullable<ReturnType<typeof refused.get>>} */ (refused.get(key))).line;
  const checks = createSendChecks({ ownerOf, checkFolder });
  /** Messages whose chat moved to another owner since they were queued: they wait for the continue dialog. @type {Set<string>} */
  const moved = new Set();
  /** Messages that wait for the person to sign in to their organization on this Mac. @type {Set<string>} */
  const signin = new Set();
  /** Chats a Switch host is moving now, with the name of the machine they move to: what is sent to them is kept until the move ends. @type {Map<string, string | null>} */
  const moving = new Map();
  /** Chats begun here whose first message has not been sent yet: that message starts the chat on its Host. @type {Map<string, ChatStart>} */
  const beginning = new Map();
  const sideStart = (/** @type {string} */ chatId) => {
    const start = beginning.get(chatId);
    return start?.sideChat ? start : undefined;
  };
  const accepted = (/** @type {string} */ chatId) => {
    if (sideStart(chatId)) beginning.delete(chatId);
  };
  /** The connection followed for each machine; a machine removed and added again is a new connection. @type {Map<string, { host: RemoteHost, off: () => void }>} */
  const followed = new Map();
  /** Chats with a drain in flight in this service (callers joined to it counted), and those a "machine is ready" event reached meanwhile: the drain runs again, so an event is never swallowed by a drain that already ended offline. @type {Map<string, number>} */
  const draining = new Map();
  /** @type {Set<string>} */
  const again = new Set();
  /** Stops listening to the registry's rows; set with the first connection followed (not at creation: the registry may be inside its own change callback then). @type {(() => void) | undefined} */
  let offRows;
  let disposed = false;

  const approvals = createApprovalWaits({
    pause: (chatId) => {
      const host = hostFor(ownerOf(chatId).hostId);
      if (!host) throw new Error('The machine is not reachable.');
      // the stop is best effort: the run is paused in the app either way, and a later answer resumes it
      Promise.resolve(host.stop(chatId, undefined, { key: mintKey() })).catch(report);
      paused?.(chatId);
    },
    report,
    approvalMs,
    engineOwns: (chatId) => engineOwns(ownerOf(chatId).hostId),
    isRemote: (chatId) => isRemote(chatId),
  });

  const projection = createSendProjection({
    outbox,
    state,
    ownerOf,
    rowOf,
    signin,
    refused,
    describe: refusals.view,
    moved,
    moving,
    sideStart,
    accepted,
    connected: (hostId) => followed.get(hostId)?.host.state() === 'online',
  });
  const { project } = projection;

  const isRemote = (/** @type {string} */ chatId) => ownerOf(chatId).hostId !== LOCAL_HOST_ID;

  /** Start the connection to a machine once, and send what waited for it whenever it comes back. @param {string} hostId @param {RemoteHost} host */
  function follow(hostId, host) {
    // the registry's row and the connection turn ready in either order; whichever comes second finds the other already up and sends what waited
    offRows ??= onRowChange?.(() => void resume());
    const prior = followed.get(hostId);
    if (prior?.host === host) return;
    prior?.off();
    followed.set(hostId, {
      host,
      off: host.onState((s) => s === 'online' && void resume(hostId)),
    });
    // asked once, since the tunnel retries by itself and tells when it is up; never awaited: a send must not wait on a tunnel; an unreachable machine is the waiting state, not an error
    host.connect().catch((error) => {
      if (error?.code !== 'host_unreachable') report(error);
    });
  }

  const { rebaseChat, holdMove, endMove, settleHeld, confirmHere } = createRebase({
    refuse: (chatId, key, message) => void refused.set(key, { code: 'send_here', message: message ?? UNCONFIRMED, own: true }),
    outbox,
    ownerOf,
    moved,
    moving,
    drain: (chatId) => drain(chatId),
    localSend,
    project,
    report,
  });

  /**
   * Send what is queued for the chat, in order. Resolves with how it ended; never rejects (an unreadable outbox is reported and ends the drain as failed).
   * @param {string} chatId
   */
  async function drain(chatId) {
    draining.set(chatId, (draining.get(chatId) ?? 0) + 1);
    try {
      let result = await drainOnce(chatId);
      // the other side of "online" came up while this drain was deciding the machine was away: look again, once per such event
      while (again.delete(chatId) && !disposed && result.stopped === 'offline') result = await drainOnce(chatId);
      return result;
    } finally {
      const left = /** @type {number} */ (draining.get(chatId)) - 1;
      if (left) draining.set(chatId, left);
      else draining.delete(chatId), again.delete(chatId);
    }
  }

  /** @param {string} chatId */
  async function drainOnce(chatId) {
    try {
      return await drainChat(chatId);
    } catch (error) {
      report(/** @type {Error} */ (error));
      return {
        sent: 0,
        stopped: /** @type {const} */ ('failed'),
        error: /** @type {Error} */ (error),
      };
    }
  }

  /** @param {string} chatId */
  async function drainChat(chatId) {
    if (!canSend(chatId)) return { sent: 0, stopped: /** @type {const} */ ('held') };
    // a chat being switched keeps what was sent to it: the old owner is about to hand it over and the new one does not own it yet
    if (moving.has(chatId)) return project(chatId), { sent: 0, stopped: /** @type {const} */ ('held') };
    const owner = ownerOf(chatId);
    const host = hostFor(owner.hostId);
    if (!host) return project(chatId), { sent: 0, stopped: /** @type {const} */ ('offline') };
    follow(owner.hostId, host);
    const result = await outbox.drain(chatId, {
      online: () => !disposed && !moving.has(chatId) && waitingFor(rowOf(owner.hostId)) === null && host.state() === 'online',
      send: async (entry) => {
        if (
          !(await deliverRemote(entry, owner, host, {
            checks,
            subscribed,
            disposed: () => disposed,
            outbox,
            ownerOf,
            state,
            projection,
            hostFor,
            kindOf,
            scopeOf: (id) => rowOf(id)?.hostKey,
            sideStart: sideStart(chatId),
          }))
        )
          return;
        // the Host's reply is its own record of the input: it is done
        outbox.ack(chatId, [entry.key]);
        accepted(chatId);
        checks.clear(entry.key);
        refused.delete(entry.key);
        signin.delete(entry.key);
      },
      onStale: (entry) => moved.add(entry.key),
    });
    if (result.stopped === 'offline' && !moving.has(chatId)) void wake?.(owner.hostId);
    // refused for its epoch while the Host holds a newer one than the list gave when the chat was taken in: the epoch is read again, and the message goes once more
    if (result.stopped === 'stale_epoch' && taken()?.refreshEpoch?.(chatId)) return (await rebaseChat(chatId)) ?? result;
    // the Host handed the chat to another machine while this app did not hear (a lost commit reply, a restart): the chat is there now, and what waited goes to it
    if (
      result.stopped === 'failed' &&
      /** @type {any} */ (result.error)?.code === 'chat_released' &&
      followMove?.(chatId, /** @type {any} */ (result.error).details)
    )
      return (await rebaseChat(chatId)) ?? result;
    if (result.stopped === 'failed') {
      const code = /** @type {any} */ (result.error)?.code;
      const key = outbox.pending(chatId).find((e) => e.state === 'queued')?.key;
      if (key && code === ORG_SIGNIN) signin.add(key);
      // every refusal a Host gives is shown with its cause and what fixes it, never only logged; a fault on the way (the machine unreachable, a disk error here) is the machine's own "Waiting for host" or a log line
      else if (key && refusals.isRefusal(result.error)) refused.set(key, refusals.record(chatId, result.error));
      else report(/** @type {Error} */ (result.error));
    }
    project(chatId);
    return result;
  }

  /** Whether the chat's first queued message waits for the user; an outbox that cannot be read is not held (the drain reports it). @param {string} chatId */
  function heldForUser(chatId) {
    try {
      const head = outbox.pending(chatId).find((e) => e.state === 'queued')?.key;
      return head !== undefined && (refused.has(head) || moved.has(head) || signin.has(head));
    } catch {
      return false;
    }
  }

  /** Show and send what was kept: at startup (every chat), and when a machine is usable again (its chats). @param {string} [hostId] */
  async function resume(hostId) {
    if (disposed) return;
    // each chat on its own: one machine that answers slowly does not hold the others
    await Promise.all(
      outbox.chats().map(async (chatId) => {
        try {
          // messages kept for a move that no longer runs (a restart) go to the chat's owner now
          if (!hostId) await settleHeld(chatId);
          project(chatId);
        } catch (error) {
          report(/** @type {Error} */ (error));
        }
        if (hostId && ownerOf(chatId).hostId !== hostId) return undefined;
        // a refused or moved head waits for the user (delete, fix, continue dialog, "send now"): a heartbeat does not send it again
        if (heldForUser(chatId)) return undefined;
        if (draining.has(chatId)) again.add(chatId);
        return drain(chatId);
      }),
    );
  }

  const picksOf = picksFor({ ownerOf, selectionOf, permissionOf, userDefaultOf, taken, state, kindOf, rowOf });

  /**
   * Keeps a message in the outbox, under the chat's first-message start when it has one. `failed` is the receipt when it could not be kept.
   * @param {string} chatId @param {any} item @param {number | null} origin @param {{ requiresFolderCheck?: boolean, shown?: boolean }} [flags] what rides with it: a folder to check first, the sending window drawing it in the transcript already (the queue then does not show it as sent)
   * @returns {{ key: string, failed?: undefined } | { failed: { action: 'failed', id: string, error: string }, key?: undefined }}
   */
  function keep(chatId, item, origin, flags = {}) {
    approvals.guard.resumed(chatId);
    const q = tray(item, origin);
    // a message kept for a move in progress is delivered to whoever owns the chat when it ends (a restart finds it by `held`)
    const held = moving.has(chatId);
    // what a chat that runs here carries is its own options: the machine's picks are not made for it
    if (!held || isRemote(chatId)) q.opts = picksOf(chatId, q.opts, item, beginning.has(chatId));
    // Plan with a Host that does not take it for this agent: refused with its words, and the message is not kept
    if (q.opts.plan && !(held && !isRemote(chatId))) return { failed: { action: 'failed', id: q.id, error: NO_PLAN } };
    if (q.attachments.some((a) => !remoteAttachmentKind(a.kind))) return { failed: { action: 'failed', id: q.id, error: NO_ATTACHMENTS } };
    // a window that sends the same message twice under one id sends it once
    const key = UUID.test(q.id) ? q.id : mintKey();
    // the chat's first message starts it on the Host; kept with the message, so a restart before it is sent still starts the chat
    const start = beginning.get(chatId);
    try {
      outbox.add(chatId, {
        key,
        epoch: ownerOf(chatId).epoch,
        options: {
          item: { ...q, id: key },
          ...(start && !start.sideChat ? { start } : {}),
          ...flags,
          ...(held ? { held: true } : {}),
        },
      });
    } catch (error) {
      report(/** @type {Error} */ (error));
      return {
        failed: {
          action: 'failed',
          id: key,
          error: 'This message could not be saved, so it was not sent.',
        },
      };
    }
    // The first queued message of a side chat can be edited or removed. The start belongs to the chat until accepted.
    if (!start?.sideChat) beginning.delete(chatId);
    return { key };
  }

  return {
    /** Whether this chat runs on a remote Host (everything else is the controller's). @param {string} chatId */
    owns: isRemote,
    /**
     * A message from a window to a chat on a remote Host. null for a chat that runs here. Otherwise a send receipt: started once the Host has it,
     * queued while it waits (offline, moved or refused), failed when it could not even be kept.
     * @param {string} chatId @param {any} item @param {number | null} [origin] @param {boolean} [shown] the window draws the message in the transcript at once, so only one really waiting shows in the queue
     */
    async send(chatId, item, origin = null, shown = false) {
      if (!isRemote(chatId)) return null;
      const kept = keep(chatId, item, origin, shown ? { shown } : {});
      if (kept.failed) return kept.failed;
      const { key } = kept;
      await drain(chatId);
      // an outbox that cannot be read now still holds the message: it is waiting
      const waiting = (() => {
        try {
          return outbox.pending(chatId).some((e) => e.key === key);
        } catch {
          return true;
        }
      })();
      if (!waiting) return { action: 'started', id: key };
      if (signin.has(key)) return { action: 'queued', id: key, waitingFor: 'orgSignin' };
      return {
        action: 'queued',
        id: key,
        ...(refused.has(key) ? { error: refusalLine(chatId, key), waitingFor: 'hostRefused' } : {}),
      };
    },
    /**
     * Like send, but replies once the message is durable in the outbox: the Host is told in the background, and a refusal or an away machine shows in the
     * chat's queue (the same states). `gate` is a check that runs meanwhile (a folder read): if it rejects, the message is not sent and waits as refused with its reason.
     * null for a chat that runs here; `{ action: 'queued', id }` once kept; failed when it could not be kept.
     * @param {string} chatId @param {any} item @param {number | null} [origin] @param {Promise<unknown>} [gate]
     */
    enqueue(chatId, item, origin = null, gate = Promise.resolve()) {
      const verdict = checks.observe(gate);
      if (!isRemote(chatId)) return null;
      const kept = keep(chatId, item, origin, { requiresFolderCheck: true });
      if (kept.failed) return kept.failed;
      const { key } = kept;
      checks.set(chatId, key, verdict);
      project(chatId);
      void drain(chatId);
      return { action: 'queued', id: key };
    },
    /** The chat was just made here for a Host: its first message, when the window sends it, starts it there with this. @param {string} chatId @param {ChatStart} start */
    begin(chatId, start) {
      beginning.set(chatId, start);
    },
    /**
     * Stop pressed on a chat that runs on a remote Host: it reaches the Host now or fails, because a Stop kept for later would end a turn that does not exist yet.
     * null: the chat runs here.
     * @param {string} chatId @param {unknown} [turnId]
     */
    stop(chatId, turnId) {
      if (!isRemote(chatId)) return null;
      const host = hostFor(ownerOf(chatId).hostId);
      if (!host || host.state() !== 'online') return Promise.reject(new Error(STOP_AWAY));
      return Promise.resolve(host.stop(chatId, turnId, { key: mintKey() }));
    },
    /** The person picked another agent for a chat on a remote Host (remoteSwitch.cjs). null: the chat runs here. */
    switchTo: createSwitch({ isRemote, hostFor, ownerOf, mintKey }),
    /** The goal bar's action on a chat on a remote Host (remoteGoal.cjs). null: the chat runs here. */
    goal: createGoal({ isRemote, hostFor, ownerOf, mintKey }),
    /** The person's name for a chat on a remote Host (remoteRename.cjs). null: the chat runs here. */
    rename: createRename({
      isRemote,
      hostFor,
      ownerOf,
      mintKey,
      machineOf: (hostId) => rowOf(hostId)?.name || 'The machine',
    }),
    /** Retire every queued or sent input before remote ownership is forgotten. @param {string} chatId */
    forgetChat(chatId) {
      beginning.delete(chatId);
      for (const key of outbox.retire(chatId)) {
        refused.delete(key);
        moved.delete(key);
        signin.delete(key);
        checks.clear(key);
        projection.forget(chatId, key);
      }
      project(chatId);
    },
    /** The user deleted a queued bubble. null: it is not one of this service’s. A message the Host already has cannot be taken back (false). @param {string} chatId @param {string} qid */
    remove(chatId, qid) {
      if (projection.pendingStart(chatId, qid))
        throw new Error('The machine may already have this message. Wait for it to confirm the send.');
      if (projection.remove(chatId, qid)) return true;
      if (!outbox.pending(chatId).some((e) => e.key === qid)) return null;
      const removed = outbox.remove(chatId, qid);
      if (removed) refused.delete(qid), moved.delete(qid), signin.delete(qid), checks.clear(qid);
      project(chatId);
      return removed;
    },
    /** "Send now" on a bubble that waits for the Host: try once more now. null: not this service's. @param {string} chatId @param {string} qid */
    async sendNow(chatId, qid) {
      if (!outbox.pending(chatId).some((e) => e.key === qid)) return null;
      refused.delete(qid);
      signin.delete(qid);
      checks.clear(qid);
      // a chat that runs here is sent to its controller (what was kept for a move, or never confirmed)
      await (isRemote(chatId) ? drain(chatId) : confirmHere(chatId, qid));
      if (!outbox.pending(chatId).some((e) => e.key === qid)) return { status: 'sent' };
      if (moved.has(qid)) return { status: 'queued', error: MOVED };
      if (signin.has(qid)) return { status: 'queued', waitingFor: 'orgSignin' };
      return refused.has(qid) ? { status: 'queued', error: refusalLine(chatId, qid) } : { status: 'queued', waitingFor: 'host' };
    },
    /** The continue dialog was accepted: the messages queued for the old owner belong to the new one and go. @param {string} chatId */
    rebase: async (chatId) => void (await rebaseChat(chatId)),
    /** Whether a message of the chat waits in the outbox. @param {string} chatId */
    hasPending: (chatId) => outbox.pending(chatId).length > 0,
    /** A message for a chat a Switch host is moving, kept until the move ends: a send receipt, `queued` once kept. */
    hold(chatId, item, origin = null) {
      const kept = keep(chatId, item, origin);
      if (kept.failed) return kept.failed;
      project(chatId);
      return { action: 'queued', id: kept.key };
    },
    /** A Switch host moves the chat: `holdMove` keeps what is sent to it, `endMove` sends it to the owner (remoteSendRebase.cjs). */
    moving: (chatId) => moving.has(chatId),
    holdMove,
    endMove,
    /** The Host has these inputs on record (a hello's input keys): they are done. @param {string} chatId @param {string[]} keys */
    ack(chatId, keys) {
      outbox.ack(chatId, keys);
      project(chatId);
    },
    resume,
    /**
     * What this Mac sent, for the transcript of a chat on a Host (remoteChats.cjs): a turn start without its user message takes the oldest text sent
     * and not yet recorded; a user message that is recorded settles the one with its text.
     */
    sent: projection.sent,
    /** The person signed in to their organization on this Mac: every message that waited for it goes now. */
    orgSignedIn() {
      if (!signin.size) return Promise.resolve();
      signin.clear();
      return resume();
    },
    /** Every change to a chat's session state: its approval cards start, go on or restart the unanswered period (remoteSendApprovals.cjs). @param {{ chatId: string, patch?: { approvals?: unknown[] } }} p */
    onSessionPatch: (p) => !disposed && approvals.onSessionPatch(p),
    dispose() {
      disposed = true;
      approvals.dispose();
      for (const { off } of followed.values()) off();
      followed.clear();
      offRows?.();
      outbox.dispose();
    },
  };
}

module.exports = { createRemoteSend, NO_ATTACHMENTS, STOP_AWAY };
