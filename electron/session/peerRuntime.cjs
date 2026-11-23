// The main-process peer messaging runtime: the trusted boundary between windows, harness tools and the shared peer message service.

const crypto = require('node:crypto');
const { PeerMessageService } = require('./peerMessages.cjs');
const { registerPeerTools } = require('../capabilities/contract/peerMessages.cjs');
const { ownerOf } = require('../platform/segmentOwner.cjs');
const { addHook, addGuard } = require('./hookChain.cjs');
const { isMomoMeta } = require('../../shared/momoChat.mjs');
const { readable } = require('../momo/contract/toolIsolation.cjs');
const { clock } = require('../platform/ports/clock.cjs');
const { approveHeld, declineHeld, sweepHeld } = require('./peerHold.cjs');
const { noteIgnored } = require('../ignored.cjs');

/** How often held messages are checked for expiry and for two chats' modes coming to match, with no window open. */
const HOLD_SWEEP_MS = 15000;

/** How long a send waits for the chats' titles; a slow list still fills the shared cache for the next send. */
const TITLES_WAIT_MS = 1000;

const fail = (code) => {
  throw Object.assign(new Error(code), { code });
};

/** Trusted app boundary for the common messaging service. No native ids or harness UI gates. */
class PeerRuntime {
  /**
   * @param {{ file: string, controller: any, chats: any, registry: any,
   *           sourceWindow: (event: any, expected: string) => string | null, gate: (chatId: string) => any,
   *           titles?: () => Promise<Map<string, string>>, read: (chatId: string, args: any) => any, readReceipt?: any,
   *           temporary?: (chatId: string) => boolean, publish?: (data: any) => void,
   *           channelAvailability?: (channel: string | undefined, chatId: string) => string | null | Promise<string | null>,
   *           referenceWindow?: (event: any) => boolean, readReference?: any, readHistory?: any, projectOf?: (chatId: string) => Promise<string | null>,
   *           permission?: (chatId: string) => string | null }} o
   */
  constructor({
    file,
    controller,
    chats,
    registry,
    sourceWindow,
    gate,
    titles = async () => new Map(),
    read,
    readReceipt,
    temporary,
    publish,
    channelAvailability = () => null,
    referenceWindow = () => false,
    readReference,
    readHistory,
    projectOf = async () => null,
    permission = () => null,
  }) {
    this.controller = controller;
    this.chats = chats;
    this.sourceWindow = sourceWindow;
    this.gate = gate;
    /** every chat's title on every harness (app/ipc/chatList.cjs chatTitleReader): list_chats searches it */
    this.titles = titles;
    this.read = read;
    this.readReceipt = readReceipt;
    this.channelAvailability = channelAvailability;
    this.referenceWindow = referenceWindow;
    this.readReference = readReference;
    /** a chat's whole history as turns (peerTranscript.cjs readPeerTurns): Chrome's side panel shows it */
    this.readHistory = readHistory;
    this.projectOf = projectOf;
    this.service = new PeerMessageService({
      file,
      controller,
      // MoMo's chats are kept apart: never a sender's or a target's (electron/momo/contract/toolIsolation.cjs)
      exists: (id) => readable(chats, id),
      gate: (id) =>
        this.service?.startupError ??
        (this.paused.has(id) ? (this.pauseErrors.has(id) ? 'target_pause_not_persisted' : 'target_paused_by_user') : gate(id)),
      publish,
      temporary,
      steerAvailability: async (id) => (await this.capabilities(id)).peerSteer.reason,
      // a chat in Full access holds a message from a stricter chat for its user (peerHold.cjs)
      permission: (id) => (this.chats.records.has(id) ? permission(id) : null),
      // Like Claude Code's SendMessage: any chat the caller can list may be messaged; the user's wording grants nothing.
      // The receiving chat's gate (above) and the user's pause still decide delivery; a self-send fails before this.
      authorize: (source) => ({ sourceTurnId: this.turnToken(source) ?? null }),
      // a send never waits long on a harness's list: with no titles yet, the windows name the chats they know
      titles: () =>
        Promise.race([
          this.titles().catch(() => new Map()),
          new Promise((resolve) => clock.setTimeout(resolve, TITLES_WAIT_MS, new Map())?.unref?.()),
        ]),
    });
    this.paused = new Set(this.service.data.pausedChats ?? []);
    // main owns the hold's deadline: it expires on time with no window open
    this.holdSweep = clock.setInterval(() => this.sweepHeld(), HOLD_SWEEP_MS);
    this.holdSweep?.unref?.();
    this.pauseErrors = new Set();
    // every hook is added beside what is there (the turn-end ledger's, the linked sessions'), never in its place
    addGuard(controller, 'beforeDispatch', (e) => this.service.beforeDispatch(e));
    addGuard(controller, 'onDispatchResult', (e) => this.service.result(e));
    addHook(controller, 'onStopped', (id) => this.setPaused(id, true));
    addHook(controller, 'onFinished', (e) => this.service.finished(e));
    registerPeerTools(registry, {
      service: this.service,
      toolAccess: async (id) => (await this.capabilities(id)).peerTools.reason,
      owner: (ctx) => ownerOf(chats.records, ctx),
      directory: (id, args) => this.directory(id, args),
      read: (id, target, args) => {
        if (!readable(chats, target)) fail('chat_unavailable');
        return read(target, args);
      },
    });
  }

  sweepHeld() {
    if (this.service.startupError) return Promise.resolve();
    return sweepHeld(this.service).catch((error) => noteIgnored('expire or release held peer messages', error));
  }

  dispose() {
    clock.clearInterval(this.holdSweep);
  }

  turnToken(source) {
    const rt = this.controller.rt(source);
    return rt.inputToken ?? rt.token;
  }

  setPaused(id, paused) {
    const ids = new Set(this.service.data.pausedChats ?? []);
    // Stop takes effect in memory even if the disk is full. Resume takes effect only
    // after its durable record succeeds, so an unsuccessful resume cannot wake peers.
    if (paused) this.paused.add(id);
    if ((paused ? ids.has(id) : !ids.has(id)) && !this.pauseErrors.has(id)) {
      if (!paused) this.paused.delete(id);
      return;
    }
    if (paused) ids.add(id);
    else ids.delete(id);
    try {
      this.service.commit({ ...this.service.data, pausedChats: [...ids] });
      this.pauseErrors.delete(id);
      if (!paused) this.paused.delete(id);
    } catch (error) {
      if (this.paused.has(id)) this.pauseErrors.add(id);
      throw error;
    }
  }

  /** Called only for a validated user send, before controller creates its queued item: the user's turn resumes paused peers. */
  userTurn(source, item) {
    if (!item?.opts?.human || typeof item.text !== 'string') return item;
    this.setPaused(source, false);
    return { ...item, id: typeof item.id === 'string' && item.id ? item.id : crypto.randomUUID() };
  }

  async capabilities(target) {
    if (!this.chats.records.has(target)) fail('chat_unavailable');
    const declared = this.controller.peerCapabilities?.(target) ?? { messaging: false, read: false, steer: false };
    const reason = await this.service.gate(target);
    const toolsReason = this.service.startupError ?? (await this.channelAvailability(declared.toolChannel, target));
    const state = this.controller.state.get(target);
    const feature = (supported, blocked) => ({
      available: !!supported && !blocked,
      reason: !supported ? 'adapter_capability_unavailable' : (blocked ?? null),
    });
    return {
      peerMessaging: feature(declared.messaging, reason),
      peerRead: feature(declared.read, null),
      peerTools: feature(declared.messaging, toolsReason),
      peerSteer: feature(
        declared.steer,
        reason ??
          toolsReason ??
          (state.turn === 'awaitingUser' ? 'approval_pending' : state.pendingSwitch ? 'harness_switch_pending' : null),
      ),
    };
  }

  async directory(source, { query = '', cursor = null, limit = 20 } = {}) {
    // a MoMo chat lists no other chat (electron/momo/contract/toolIsolation.cjs)
    if (!readable(this.chats, source)) fail('chat_unavailable');
    const titles = await this.titles().catch(() => new Map());
    const all = [...this.chats.records]
      // MoMo's chats are in no list (shared/momoChat.mjs)
      .filter(([id, rec]) => id !== source && !isMomoMeta(rec.meta))
      .map(([id, rec]) => ({
        id,
        title: titles.get(id) || id,
        archived: rec.meta?.archived != null,
        state: this.controller.state.get(id).turn,
        updatedAt: rec.updatedAt ?? 0,
      }))
      .filter((m) => m.title.toLowerCase().includes(String(query).toLowerCase()))
      .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
    const offset = cursor === null ? 0 : Number(cursor);
    if (!Number.isSafeInteger(offset) || offset < 0) fail('invalid_cursor');
    const size = Math.max(1, Math.min(50, limit));
    // only the page's chats have their folder read (a transcript read each, for some harnesses)
    const chats = await Promise.all(
      all.slice(offset, offset + size).map(async (chat) => {
        const [project, capabilities] = await Promise.all([this.projectOf(chat.id), this.capabilities(chat.id)]);
        return { ...chat, project, capabilities };
      }),
    );
    return { chats, nextCursor: offset + size < all.length ? String(offset + size) : null };
  }

  source(event, expected) {
    const source = this.sourceWindow(event, expected);
    if (!source || source !== expected || !this.chats.records.has(source)) fail('invalid_source_window');
    return source;
  }

  snapshot(source) {
    if (this.service.startupError) fail(this.service.startupError);
    return this.service.data.messages
      .filter((m) => m.sourceChatId === source || m.targetChatId === source)
      .map((m) => {
        const { dedupeKey, fingerprint, ...view } = m;
        return structuredClone(view);
      });
  }

  registerIpc(ipc) {
    const own = (e, source) => this.source(e, source);
    ipc.handle('peer:snapshot', (e, source) => this.snapshot(own(e, source)));
    ipc.handle('peer:directory', (e, source, args) => this.directory(own(e, source), args));
    ipc.handle('peer:capabilities', (e, source) => this.capabilities(own(e, source)));
    ipc.handle('peer:referenceHistory', async (e, ids, assistantOnly = false, source = null) => {
      if (!this.referenceWindow(e)) fail('invalid_source_window');
      // a MoMo chat reads no other chat; a reference made outside a chat (a new chat, a pull request) names none
      if (source != null && this.chats.records.has(source) && !readable(this.chats, source)) fail('chat_unavailable');
      if (typeof assistantOnly !== 'boolean') fail('invalid_references');
      if (!Array.isArray(ids) || ids.length > 20 || ids.some((id) => typeof id !== 'string' || !id || id.length > 256))
        fail('invalid_references');
      if (!this.readReference) fail('reference_reader_unavailable');
      // a typed or pasted mention of a MoMo chat reads nothing (electron/momo/contract/toolIsolation.cjs)
      for (const id of ids) if (!readable(this.chats, id)) fail('chat_unavailable');
      return Object.fromEntries(await Promise.all([...new Set(ids)].map(async (id) => [id, await this.readReference(id, assistantOnly)])));
    });
    ipc.handle('peer:send', (e, source, request) => {
      own(e, source);
      if (!request || typeof request !== 'object') fail('invalid_request');
      const { targetChatId, requestId, body, requestReply } = request;
      return this.service.send(source, { targetChatId, requestId, body, requestReply });
    });
    ipc.handle('peer:reply', (e, source, request) => this.service.reply(own(e, source), request));
    ipc.handle('peer:cancel', (e, source, id) => this.service.cancel(own(e, source), id));
    ipc.handle('peer:sendNow', (e, source, id) => this.service.sendNow(own(e, source), id));
    ipc.handle('peer:reconcile', (e, source, id) => this.service.reconcile(own(e, source), id, this.readReceipt));
    ipc.handle('peer:resume', (e, source, id) => this.service.resume(own(e, source), id));
    // only the receiving chat's own window answers a hold: never a tool, never the sender
    ipc.handle('peer:approve', (e, source, id) => approveHeld(this.service, own(e, source), id));
    ipc.handle('peer:decline', (e, source, id) => declineHeld(this.service, own(e, source), id));
  }
}

module.exports = { PeerRuntime };
