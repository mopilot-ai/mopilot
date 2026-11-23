// The Codex adapter's runs on a thread's own settings (a goal's turns, a review, a voice session's delegations): the
// chat's model and permission are set before they start; permission changes alone preserve the running model.
const { CodexEvents } = require('./codexEvents.cjs');
const { messageOf } = require('../ignored.cjs');
const { chatPrefs, modelSettings, permissionSettings, permissionKey } = require('./codexParams.cjs');
const { carryInputGuard } = require('../session/contract/inputGuard.cjs');

/** @typedef {InstanceType<typeof import('./codex.cjs').CodexAdapter>} CodexAdapter the adapter these methods run on */

class CodexRunPermission extends CodexEvents {
  /**
   * Set the thread's approval policy and sandbox to the chat's permission, for the runs Codex starts on the thread's own
   * settings (a goal's turns, a review). Throws when Codex refuses it: such a run would go on Codex's default sandbox.
   * @this {CodexAdapter}
   * @param {string} chatId @param {string} nid the chat's loaded thread
   * @param {any} [opts] a goal message's own picks (permission, extra folders), which win as they do for a turn
   * @param {any} [guarded] the message the run is for: a Stop of it keeps the update from being sent
   * @param {boolean} [starting] a new run takes the model choice; an in-flight permission edit preserves its model
   */
  async applyPermission(chatId, nid, opts = {}, guarded = null, starting = true) {
    const prefs = chatPrefs(this.prefs() || {}, this.chatConfig(chatId));
    const choice = starting ? modelSettings(prefs, opts ?? {}, await this.defaults()) : null;
    const params = {
      threadId: nid,
      ...(choice?.model ? choice : {}),
      ...permissionSettings(prefs, this.meta.get(nid)?.cwd, opts ?? {}),
    };
    try {
      await this.request('thread/settings/update', guarded ? carryInputGuard(guarded, params) : params);
    } catch (e) {
      throw new Error(`Couldn't apply this chat's permission: ${messageOf(e)}`);
    }
    this.permissionKeys.set(nid, permissionKey(prefs));
    // computer use's authorization anchor follows the sandbox the run goes with, as a turn's does
    this.state?.patch(chatId, { permission: opts?.permission ?? prefs.permission ?? 'default' });
  }

  /**
   * A goal just turned active on the thread: a permission picked after it was applied for that goal, while Codex was
   * asked to start it, found no goal running and was left for its next run. It goes on now.
   * @this {CodexAdapter}
   * @param {string} chatId @param {string} nid
   */
  permissionCaughtUp(chatId, nid) {
    const applied = this.permissionKeys.get(nid);
    if (applied !== undefined && applied !== permissionKey(chatPrefs(this.prefs() || {}, this.chatConfig(chatId))))
      void this.permissionChanged(chatId);
  }

  /**
   * The chat's permission or extra folders changed (no chat: the default permission did): a loaded thread whose goal is
   * active, or that a voice session holds, takes them now, since Codex starts that goal's next turns and the voice
   * session's delegated ones on the thread's own settings. Any other thread gets them with its next run (a turn carries
   * its own; a goal, a review or a voice session applies them first).
   * @this {CodexAdapter}
   * @param {string | null} [chatId]
   * @returns {Promise<string[]>} the chats whose thread took them
   */
  async permissionChanged(chatId = null) {
    const chats = chatId === null ? [...this.leases.keys()].map((nid) => this.chatOf(nid)) : [chatId];
    const applied = await Promise.all([...new Set(chats)].map((chat) => this.runPermission(chat)));
    return applied.filter((chat) => chat !== null);
  }

  /**
   * Apply the chat's permission to the thread its running goal or voice session is on, one update at a time per thread:
   * each reads the chat's permission when it is sent, so the last one sent is the latest choice. A failure is told unless
   * a newer change follows.
   * @this {CodexAdapter}
   * @param {string} chatId
   * @returns {Promise<string | null>} the chat, when its thread took it
   */
  async runPermission(chatId) {
    const nid = this.codexThread(chatId);
    // a pinned lease is a voice session's (electron/session/voice.cjs)
    const running = () => !!nid && this.leases.has(nid) && (this.goalActive(chatId, nid) || this.leases.get(nid).pinned);
    if (!running()) return null;
    const gen = (this.permissionGens.get(nid) ?? 0) + 1;
    this.permissionGens.set(nid, gen);
    // the thread was let go, or its goal or voice session ended, while an earlier update ran: its next run applies it
    const apply = () => (running() ? this.applyPermission(chatId, nid, {}, null, false).then(() => true) : false);
    const prev = this.permissionRuns.get(nid);
    const run = prev ? prev.then(apply) : apply();
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    this.permissionRuns.set(nid, settled);
    settled.then(() => {
      if (this.permissionRuns.get(nid) !== settled) return;
      this.permissionRuns.delete(nid);
      this.permissionGens.delete(nid);
    });
    try {
      return (await run) ? chatId : null;
    } catch (e) {
      // a newer change is on its way, and it is the one the thread will run with
      if (this.permissionGens.get(nid) !== gen) return null;
      const keeps = this.goalActive(chatId, nid)
        ? 'The running goal keeps its earlier one until you pause and resume it.'
        : 'The voice session keeps its earlier one until you start it again.';
      this.emit({ kind: 'toast', level: 'error', text: `${messageOf(e).replace(/[.!]+$/, '')}. ${keeps}` }, 'any');
      return null;
    }
  }
}

module.exports = { CodexRunPermission };
