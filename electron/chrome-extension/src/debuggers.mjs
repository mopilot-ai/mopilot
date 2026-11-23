// Serializes the extension's per-tab debugger effects and retains retired attachment ownership through native acknowledgement and cleanup.
//
// Every attach puts the guard against other extensions' frames on the tab (frameGuard.mjs); an attach such a frame
// blocks reloads the tab once and attaches as its new page commits.

import { BLOCKED, RELOAD_AGAIN_MS, RELOADS, guardTab, isForeignRefusal, reloadToCommit } from './frameGuard.mjs';

/** @typedef {{ attached: Set<number> }} Owner */
/** @typedef {{ owner: Owner, membership: object | null, tabId: number, pending: number, retired: boolean }} Attachment */

export class Debuggers {
  constructor({ chrome, changed, log, now = Date.now }) {
    this.chrome = chrome;
    this.changed = changed;
    this.log = log;
    this.now = now;
    /** @type {((tabId: number) => void) | null} told when another extension's frame keeps an attach out (tabNotices.mjs) */
    this.onBlocked = null;
    /** @type {Map<number, number>} when each tab was last reloaded to clear another extension's frame */
    this.reloaded = new Map();
    /** @type {Set<number>} tabs reloading to clear another extension's frame: their detaches are this extension's own retries */
    this.recovering = new Set();
    /** @type {Map<number, Attachment>} the current attachment generation, reserved before dispatch */
    this.current = new Map();
    /** @type {Map<number, Attachment>} successful native effects, retained even when cleanup fails */
    this.held = new Map();
    /** @type {Set<number>} tabs where Chrome refused our detach for another extension's frame: our debugger may still be on them */
    this.refusedDetach = new Set();
    /** @type {Map<number, Promise<void>>} no new native attach can overtake old cleanup */
    this.tails = new Map();
  }

  #run(tabId, work) {
    const result = (this.tails.get(tabId) ?? Promise.resolve()).then(work);
    const tail = result
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        if (this.tails.get(tabId) === tail) this.tails.delete(tabId);
      });
    this.tails.set(tabId, tail);
    return result;
  }

  /**
   * The only native sendCommand for the agent's and the screenshot's commands. Chrome refuses it too while another
   * extension's frame is in the tab; the chat is told what attach tells it, not Chrome's refusal.
   */
  async sendCommand(/** @type {{ tabId: number, sessionId?: string }} */ debuggee, /** @type {string} */ method, params) {
    try {
      return await this.chrome.debugger.sendCommand(debuggee, method, params);
    } catch (error) {
      if (isForeignRefusal(error)) throw this.#blocked(debuggee.tabId);
      throw error;
    }
  }

  /** The only native attach: attach and attachClear go through it. */
  #nativeAttach(tabId, version) {
    return this.chrome.debugger.attach({ tabId }, version);
  }

  /**
   * The only native detach. Chrome's terminal absences (after a user cancel, a tab close or its own detach) and its
   * refusal for another extension's frame (it detached us as that frame started loading, then refuses every call on the
   * tab) mean the debugger is gone: the refusal is remembered, since a debugger that Chrome did not detach would still
   * be on the tab. Any other failure is the caller's.
   */
  async #nativeDetach(tabId) {
    try {
      await this.chrome.debugger.detach({ tabId });
    } catch (error) {
      // Chromium's debugger_api.cc reports these terminal absences after a user cancel or tab close.
      const message = error instanceof Error ? error.message : String(error);
      if (isForeignRefusal(error)) this.refusedDetach.add(tabId);
      else if (message !== `Debugger is not attached to the tab with id: ${tabId}.` && message !== `No tab with given id ${tabId}.`)
        throw error;
    }
  }

  /** Our own debugger that Chrome would not let go of while another extension's frame was there: let go of it again. */
  async #letGoOfRefused(tabId) {
    if (!this.refusedDetach.delete(tabId)) return;
    // a refusal for the frame marks the tab again (#nativeDetach); another failure leaves the debugger unconfirmed gone
    await this.#nativeDetach(tabId).catch((error) => {
      this.refusedDetach.add(tabId);
      this.log('let go of a tab after its frame left', error);
    });
  }

  async #detach(attachment) {
    const { tabId, owner } = attachment;
    if (this.held.get(tabId) !== attachment) return;
    await this.#nativeDetach(tabId);
    if (this.held.get(tabId) === attachment) this.held.delete(tabId);
    owner.attached.delete(tabId);
    this.changed();
  }

  /**
   * Attaches; when another extension's frame blocks it, reloads the tab (once a minute) and attaches as the new page
   * commits, while the attachment is still `current`. Resolves true when the guard is already on the tab.
   */
  async #attachClear(tabId, version, current, retired) {
    await this.#letGoOfRefused(tabId);
    try {
      await this.#nativeAttach(tabId, version);
      return false;
    } catch (error) {
      if (!isForeignRefusal(error)) throw error;
      if (this.now() - (this.reloaded.get(tabId) ?? Number.NEGATIVE_INFINITY) < RELOAD_AGAIN_MS) throw this.#blocked(tabId);
      this.reloaded.set(tabId, this.now());
    }
    this.recovering.add(tabId);
    try {
      for (let i = 0; i < RELOADS; i++) {
        // a tab the user took back, or a turn that ended, is never reloaded
        if (!current()) throw retired();
        if (!(await reloadToCommit(this.chrome, tabId, this.log))) break;
        if (!current()) throw retired();
        await this.#letGoOfRefused(tabId);
        try {
          await this.#nativeAttach(tabId, version);
        } catch (error) {
          if (isForeignRefusal(error)) continue;
          throw error;
        }
        if (await guardTab(this.chrome, tabId, this.log)) return true;
        // the guard didn't land: a frame detached the debugger again, or the page refused it; let go before the next reload
        await this.#nativeDetach(tabId).catch((error) => this.log('let go of a tab the guard missed', error));
      }
    } finally {
      this.recovering.delete(tabId);
    }
    throw this.#blocked(tabId);
  }

  /** The error for an attach another extension's frame keeps out, said to whoever shows the user (the side panel). */
  #blocked(/** @type {number} */ tabId) {
    this.onBlocked?.(tabId);
    return new Error(BLOCKED);
  }

  /** Reserve the generation now: a queued request cannot acquire ownership after it was retired. */
  attach(owner, tabId, version, owns, membership) {
    let attachment = this.current.get(tabId);
    if (!attachment || attachment.owner !== owner || attachment.membership !== membership) {
      attachment = { owner, membership, tabId, pending: 0, retired: false };
      this.current.set(tabId, attachment);
    }
    const captured = attachment;
    const current = () => this.current.get(tabId) === captured && owns();
    const retired = () => new Error('This Chrome debugger attachment no longer belongs to the current chat session or turn.');
    captured.pending++;
    return this.#run(tabId, async () => {
      try {
        if (!current()) throw retired();
        const previous = this.held.get(tabId);
        if (previous && (previous !== captured || previous.retired)) await this.#detach(previous);
        if (!current()) throw retired();
        const guarded = await this.#attachClear(tabId, version, current, retired);
        captured.retired = !current();
        this.held.set(tabId, captured);
        if (captured.retired) {
          await this.#detach(captured).catch((error) => this.log('detach a retired attachment', error));
          throw retired();
        }
        owner.attached.add(tabId);
        this.changed();
        if (!guarded) await guardTab(this.chrome, tabId, this.log);
        return {};
      } finally {
        captured.pending--;
      }
    });
  }

  /** Native events belong only to this acknowledged attachment, never an old cleanup or a pending replacement. */
  ownsEvents(owner, tabId, membership) {
    const held = this.held.get(tabId);
    return Boolean(
      held &&
        this.current.get(tabId) === held &&
        held.owner === owner &&
        held.membership === membership &&
        !held.retired &&
        owner.attached.has(tabId),
    );
  }

  /** Retirement is synchronous; an unacknowledged attach retains its cleanup without blocking chat close. */
  release(owner, tabId) {
    const captured = [...new Set([this.current.get(tabId), this.held.get(tabId)])]
      .filter((a) => a !== undefined)
      .filter((a) => a.owner === owner);
    if (!captured.length) return Promise.resolve({});
    if (this.current.get(tabId)?.owner === owner) this.current.delete(tabId);
    owner.attached.delete(tabId);
    this.changed();
    const cleanup = this.#run(tabId, async () => {
      for (const attachment of captured) await this.#detach(attachment);
      return {};
    });
    if (captured.some((a) => a.pending)) {
      cleanup.catch((error) => this.log('detach a retired attachment', error));
      return Promise.resolve({});
    }
    return cleanup;
  }

  /** A stopped worker's native attachment uses the same serialized cleanup and retry ownership. */
  restore(owner, tabId) {
    this.held.set(tabId, { owner, membership: null, tabId, pending: 0, retired: false });
    return this.release(owner, tabId);
  }

  /**
   * A screenshot of a tab for the side panel's + menu, as a PNG's base64, in the tab's own queue: through the attachment
   * an agent holds there, else a short one of its own (no new permission to ask for: the debugger is this extension's).
   */
  capture(tabId) {
    return this.#run(tabId, async () => {
      const shot = async () => (await this.sendCommand({ tabId }, 'Page.captureScreenshot', { format: 'png' })).data;
      if (this.held.has(tabId)) return shot();
      await this.#nativeAttach(tabId, '1.3');
      try {
        return await shot();
      } finally {
        await this.#nativeDetach(tabId).catch((error) => this.log('let go of a tab after its screenshot', error));
      }
    });
  }

  /** Chrome ended the native attachment itself; a still-pending attach acknowledgement remains retired. */
  forget(tabId) {
    this.refusedDetach.delete(tabId);
    this.current.delete(tabId);
    const attachment = this.held.get(tabId);
    this.held.delete(tabId);
    if (attachment) attachment.owner.attached.delete(tabId);
  }
}
