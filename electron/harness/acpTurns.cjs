// ACP turns, in main (A15): a basic harness's prompt is built from what was typed and attached
// (text, then images, then files as resource links), sent through the ChatController's `acpSend`
// (its turn bookkeeping), and titled from its first words. No window is needed to start one. Windows
// follow it through `acp:event`: turnStarting shows the message at once, turnStarted / turnFailed
// finish it, and the host's own turnStart begins the translated turn (core/crates/translate).
const { assertInputCurrent, carryInputGuard, clientIdOf } = require('../session/contract/inputGuard.cjs');
const os = require('node:os');
const path = require('node:path');
const { buildInput, provisionalTitle } = require('./codex.cjs');
const { momoContextFor, forgetMomoSent } = require('../momo/contract/context.cjs');
const { acpBlocks } = require('./acp/blocks.cjs');
const { isAuthError } = require('./acp/signin.cjs');
const { landTitle } = require('./autoTitle.cjs');
const { ignoring, noteIgnored } = require('../ignored.cjs');

const errText = (e) => String(e?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

class AcpTurns {
  audioInput = true;
  /** Never gone: a chat whose session can't be reopened gets a new one with a note (acp.cjs open), so a send can't be stuck on it (#2502). */
  sessionGone() {
    return false;
  }
  /** @returns {import('../../shared/peerMessages').PeerAdapterCapabilities} */
  peerCapabilities() {
    return { messaging: true, read: true, steer: false, toolChannel: 'channel.acp.sessionMcp' };
  }
  /**
   * @param {object} o
   * @param o.send (chatId, key, payload, meta) => Promise: ChatController.acpSend
   * @param o.rename (key, name, auto?) => void: the chat's title is Sage's (the harness has none over ACP); `auto` when
   *   MoPilot wrote it, not the user
   * @param [o.titleOf] (key) => Promise<{name, auto?} | null>: the chat's latest title record
   * @param [o.writeTitle] (key, text) => Promise<string | null>: a title its agent writes in a hidden session
   * @param [o.readAudio] (file) => Promise<object>: a validated durable audio block
   * @param o.readImage (path) => Promise<string | null>: an image as a data URL
   * @param [o.emit] (event, target?) => boolean: to windows (`acp:event`)
   * @param [o.named] (key) => boolean | Promise<boolean>: the chat has a name already (its transcript, read without blocking)
   * @param [o.home] the folder a chat without one runs in
   * @param [o.pluginSkills] () => Promise<{name, kind, file}[]>: the plugin skills and commands MoPilot provides here
   * @param [o.turnCheck] (chatId) => () => void: ChatController.turnCheck, which throws once the chat's turn was stopped or ended
   * @param [o.toolsNote] (chatId) => string | null: what MoPilot's computer and browser tools reach
   *   (capabilities/contract/surfaceNote.cjs), sent ahead of a chat's first prompt in this app run (ACP has no system prompt)
   * @param [o.savedSettings] (chatId) => saved linked-chat configuration; ordinary chats keep their native settings
   */
  constructor(o) {
    this.sendTo = o.send;
    this.rename = o.rename;
    this.readImage = o.readImage;
    this.readAudio = o.readAudio ?? null;
    /** @type {any} Pending audio ownership transfers to the native dispatch journal. */
    this.audioPending = null;
    this.emit = o.emit ?? (() => false);
    this.named = o.named ?? (() => false);
    this.titleOf = o.titleOf ?? (async () => null);
    this.writeTitle = o.writeTitle ?? (async () => null);
    this.home = o.home ?? os.homedir();
    /** without it, acpBlocks offers none */
    this.pluginSkills = o.pluginSkills;
    this.turnCheck = o.turnCheck ?? (() => () => undefined);
    this.toolsNote = o.toolsNote ?? (() => null);
    this.savedSettings = o.savedSettings ?? (() => null);
    /** chats whose session was sent the tools note in this app run (a reloaded session has it in its history) */
    this.noted = new Set();
    /** an ACP harness can call tools with no prompt running: nobody is there to answer a card then (#1319 G11) */
    this.toolsOutsidePrompt = true;
    /** key -> {cwd}: chats a window just created, not yet sent to */
    this.sessions = new Map();
    /** chats whose transcript is being read for a name: a turn started meanwhile leaves naming to that one */
    this.naming = new Set();
  }

  /** A chat a window just created: its folder is where its session starts. */
  registerSession(key, info = {}) {
    if (typeof key !== 'string' || !key) return false;
    this.sessions.set(key, { cwd: typeof info.cwd === 'string' && path.isAbsolute(info.cwd) ? info.cwd : null });
    return true;
  }

  /** @returns {Promise<{ started: boolean, turnId?: string, itemId?: string, error?: string, code?: string }>} */
  async startTurn(chatId, ref, item, origin = null) {
    const key = ref.key;
    const to = origin ?? 'any';
    const opts = item.opts || {};
    const text = String(item.text ?? '');
    const attachments = Array.isArray(item.attachments) ? item.attachments : [];
    const clientId = attachments.some((a) => a.kind === 'audio') ? item.id : clientIdOf(item);
    // reading the images (and the plugin skills) takes a while: a Stop meanwhile means the prompt is not sent
    const current = this.turnCheck(chatId);
    this.emit(
      { kind: 'turnStarting', key, chatId, clientId, itemId: item.id, text, attachments, ...(opts.note ? { note: opts.note } : {}) },
      to,
    );
    /** @type {string | null} */
    let momo = null;
    try {
      const note = opts.compact || this.noted.has(key) ? null : this.toolsNote(chatId);
      // a MoMo chat's memory, when this session wasn't given this one yet
      momo = opts.compact ? null : momoContextFor(chatId, { session: key, query: text });
      const blocks = await acpBlocks(
        opts.prefix ? `${opts.prefix}\n\n${text}` : text,
        attachments,
        this.readImage,
        this.pluginSkills,
        momo,
        this.readAudio,
      );
      // the note is its own block, for the model only (MCP/ACP annotations): the user's message stays what they typed
      if (note) blocks.unshift({ type: 'text', text: note, annotations: { audience: ['assistant'] } });
      const cwd = this.sessions.get(key)?.cwd || this.home;
      // the chat's folder only matters for a session that doesn't exist yet: a later one keeps its own
      assertInputCurrent(item);
      current();
      const permission = this.savedSettings(chatId)?.permission;
      const receipt = await this.sendTo(
        chatId,
        key,
        {
          cwd,
          blocks,
          display: buildInput(text, attachments),
          ...(permission ? { initialPermission: permission } : {}),
          // a message sent with a model or effort (a scheduled task's run, Auto's pick) runs on them, and what an earlier
          // Auto turn left on the session goes back to the chat's own (acp/initialConfig.cjs)
          ...(opts.model || opts.effort || opts.autoRestore
            ? { config: { model: opts.model, effort: opts.effort, ...(opts.autoRestore ? { restore: opts.autoRestore } : {}) } }
            : {}),
        },
        carryInputGuard(item, { human: !!opts.human && !opts.prefix, uuid: clientId, ...(opts.compact ? { compact: opts.compact } : {}) }),
      );
      if (receipt?.delivery === 'dispatched') {
        try {
          this.audioPending?.dispatched(item.id);
        } catch (error) {
          noteIgnored('release pending audio after native dispatch; the dispatch journal still owns it', error);
        }
      }
      this.sessions.delete(key);
      if (note) this.noted.add(key);
      try {
        this.emit({ kind: 'turnStarted', key, chatId, clientId, text }, to);
      } catch (error) {
        noteIgnored('publish an accepted ACP turn; native history still owns it', error);
      }
      // a chat without a name takes its first message as one (nameAfter)
      if (key === chatId && text.trim() && !this.naming.has(key))
        void this.nameAfter(key, chatId, text).catch(ignoring('name an accepted ACP chat'));
      return {
        started: true,
        turnId: receipt?.turnId ?? `at-${clientId}`,
        itemId: `u-${clientId}`,
        ...(receipt?.delivery ? { delivery: receipt.delivery } : {}),
      };
    } catch (e) {
      // a prompt that didn't start gives its memory back, so the next one carries it
      if (momo) forgetMomoSent(chatId, key);
      this.emit({ kind: 'turnFailed', key, chatId, clientId, error: errText(e) }, to);
      // a harness that asks for a sign-in fails a peer delivery the way the peer gate refuses one (login_required)
      return {
        started: false,
        error: errText(e),
        ...(isAuthError(e) ? { code: 'login_required' } : {}),
        ...(e?.deliveryUnknown ? { held: true } : {}),
      };
    }
  }

  /**
   * The first message names a chat without a name: cut short now, then replaced by a title its agent writes in a
   * hidden session (autoTitle.cjs), unless the user renamed it meanwhile. The turn does not wait for that title.
   */
  async nameAfter(key, chatId, text) {
    this.naming.add(key);
    let provisional;
    try {
      if (await this.named(key)) return;
      provisional = provisionalTitle(text);
      this.rename(key, provisional, true);
      this.emit({ kind: 'threadName', key, chatId, name: provisional });
    } finally {
      this.naming.delete(key);
    }
    landTitle({
      prompt: text,
      generate: () => this.writeTitle(key, text),
      unnamed: async () => {
        const cur = await this.titleOf(key);
        return !!cur?.auto && cur.name === provisional;
      },
      apply: (name) => {
        if (name === provisional) return;
        this.rename(key, name, true);
        this.emit({ kind: 'threadName', key, chatId, name, provisional });
      },
      what: 'write a title for an ACP chat',
    }).catch(ignoring('name an ACP chat'));
  }
}

module.exports = { AcpTurns, acpBlocks };
