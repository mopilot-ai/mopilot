// Chat-owned permission guides survive activity cleanup; only a current successful retry or recheck clears them.
const { noteIgnored } = require('../../ignored.cjs');
const { ComputerHold } = require('./computerHold.cjs');
const { mayAct, unguarded } = require('../contract/actionGuard.cjs');
const { INPUT } = require('../contract/desktopPolicy.cjs');

// Local/fallback/cleanup successes are not attempts to use a required macOS permission.
const RETRY_TOOLS = new Set([
  ...[...INPUT].filter((action) => action !== 'left_mouse_up').map((action) => `desktop_${action}`),
  'desktop_screenshot',
  'desktop_zoom',
  'desktop_batch',
]);
const permissionRetry = (tool) =>
  tool.startsWith('computer_') || (tool.startsWith('desktop_app_') && tool !== 'desktop_app_release') || RETRY_TOOLS.has(tool);

/** @typedef {InstanceType<typeof import('./computer.cjs').ComputerUse>} ComputerUse */
/** @typedef {{ app: string, state: 'active' | 'reading' | 'takeover' | 'waiting' | 'permission', holder?: string | null, permission?: string, read?: object }} Activity */
/** @typedef {{ lifecycle: object, revision: object | undefined }} PermissionOwner */

class ComputerPermissions extends ComputerHold {
  /** @param {(chatId: string, activity: Activity | null) => void} [onActivity] */
  constructor(
    onActivity = () => {
      /* no activity listener */
    },
  ) {
    super();
    /** The visible permission guide for each blocked chat. */
    /** @type {Map<string, Activity>} */
    this.blocked = new Map();
    /** Retain a revision after clearing a guide, so an older no-guide snapshot never becomes current again. */
    this.permissionRevisions = new Map();
    this.permissionChecks = new Map();
    // One native prompt per permission while this coordinator is alive, shared across chats.
    this.permissionRequests = new Map();
    /** Shutdown retires permission publication as well as native control. */
    this.closed_ = false;
    this.permissionLifecycle = {};
    // Keep control/indicator callbacks running even while the permission guide owns the visible activity.
    this.onActivity = (chatId, activity) => onActivity(chatId, this.closed ? null : (this.blocked.get(chatId) ?? activity));
  }

  get closed() {
    return this.closed_;
  }

  set closed(value) {
    if (value && !this.closed_) {
      this.closed_ = true;
      this.permissionLifecycle = {};
      const chats = [...this.blocked.keys()];
      this.blocked.clear();
      this.permissionRevisions.clear();
      this.permissionChecks.clear();
      this.permissionRequests.clear();
      for (const chatId of chats) this.onActivity(chatId, null);
    } else this.closed_ = value;
  }

  /** @param {string} chatId @returns {PermissionOwner} */
  permissionOwner(chatId) {
    return { lifecycle: this.permissionLifecycle, revision: this.permissionRevisions.get(chatId) };
  }

  /** @param {object} lifecycle */
  permissionLive(lifecycle) {
    return !this.closed && this.permissionLifecycle === lifecycle;
  }

  /** @param {string} chatId @param {PermissionOwner} owner */
  permissionCurrent(chatId, owner) {
    return this.permissionLive(owner.lifecycle) && this.permissionRevisions.get(chatId) === owner.revision;
  }

  /** A native side effect also requires the initiating call to remain live. */
  permissionMayAct(chatId, owner) {
    return mayAct() && this.permissionCurrent(chatId, owner);
  }

  /** @param {string} chatId */
  hasPermissionGuide(chatId) {
    return this.blocked.has(chatId);
  }

  /** @this {ComputerUse} @param {string} chatId @param {string} permission @param {PermissionOwner} [owner] */
  showPermissionGuide(chatId, permission, owner = this.permissionOwner(chatId)) {
    if (!this.permissionCurrent(chatId, owner)) return;
    /** @type {Activity} */
    const guide = { app: this.app || 'your Mac', state: 'permission', permission };
    this.permissionRevisions.set(chatId, {});
    this.blocked.set(chatId, guide);
    const next = this.permissionOwner(chatId);
    this.onActivity(chatId, guide);
    return next;
  }

  /** @this {ComputerUse} @param {string} chatId @param {PermissionOwner} owner */
  clearPermissionGuide(chatId, owner) {
    if (!this.permissionCurrent(chatId, owner)) return false;
    if (this.blocked.delete(chatId)) {
      this.permissionRevisions.set(chatId, {});
      this.onActivity(chatId, this.controlling === chatId ? { app: this.app, state: 'active' } : null);
    }
    return true;
  }

  /** Native tool success only requests proof; it does not itself establish permission recovery. @this {ComputerUse} */
  async recoverPermissionGuide(chatId, owner, tool, helper) {
    if (!this.blocked.has(chatId) || !this.permissionMayAct(chatId, owner) || !permissionRetry(tool) || !helper.running) return false;
    return this.checkPermissionGuide(chatId, owner, () => helper.permissionStatus({ noLaunch: true }), mayAct);
  }

  /**
   * All status reads share latest-request ownership, including an explicit retry overlapping a tool.
   * @this {ComputerUse}
   * @param {string} chatId
   * @param {PermissionOwner} owner
   * @param {() => unknown | Promise<unknown>} read
   * @param {() => boolean} [live]
   */
  async checkPermissionGuide(chatId, owner, read, live = () => true) {
    if (!this.permissionCurrent(chatId, owner) || !live()) return false;
    const check = {};
    this.permissionChecks.set(chatId, check);
    /** @type {unknown} */
    let status = null;
    try {
      status = await read();
    } catch (error) {
      noteIgnored('recheck the macOS permissions for computer use', error);
      return false;
    }
    if (!this.permissionCurrent(chatId, owner) || this.permissionChecks.get(chatId) !== check || !live()) return false;
    if (!status || typeof status !== 'object' || Array.isArray(status)) return false;
    if (!('accessibility' in status) || !('screenRecording' in status)) return false;
    const { accessibility, screenRecording } = status;
    if (typeof accessibility !== 'boolean' || typeof screenRecording !== 'boolean') return false;
    const missing = !accessibility ? 'accessibility' : !screenRecording ? 'screenRecording' : null;
    if (missing) {
      if (this.blocked.has(chatId)) this.showPermissionGuide(chatId, missing);
      return false;
    }
    return this.clearPermissionGuide(chatId, owner);
  }

  /**
   * Asks macOS for `permission` once while this coordinator lives, shared by every chat and tool family; resolves
   * the helper's status after the user answers, or null when macOS could not be asked (the next call asks again).
   * @this {ComputerUse} @param {string} permission
   */
  askPermission(permission) {
    if (!this.permissionRequests.has(permission)) {
      // shared with other chats' calls: not refused because the call that asked first was stopped
      const request = (async () => unguarded(() => this.helper.requestPermission(permission)))().catch((error) => {
        noteIgnored('ask macOS for a computer-use permission', error);
        if (this.permissionRequests.get(permission) === request) this.permissionRequests.delete(permission);
        return null;
      });
      this.permissionRequests.set(permission, request);
    }
    return this.permissionRequests.get(permission);
  }

  /**
   * True when `permission` is granted after the prompt. Only the call that raised the prompt waits for the user (bounded);
   * a later miss shows the card and fails at once, so the user is never made to wait twice for a prompt already answered.
   * @this {ComputerUse} @param {string} chatId @param {PermissionOwner} refusal @param {string} permission
   */
  async awaitGrant(chatId, refusal, permission) {
    const first = !this.permissionRequests.has(permission);
    const status = await this.askPermission(permission);
    // no status: macOS could not be asked, so there is nothing to wait for (the next call asks again)
    return !!status && (status[permission] === true || (first && (await this.waitForPermission(chatId, refusal, permission))));
  }

  /**
   * Waits, bounded, for the user to grant `permission` after the prompt: true once the helper reports it (or the
   * guide was cleared by Try again), false on timeout, a Try again that found it still off, a stopped call or shutdown. Never lets the call outlive its turn.
   * @this {ComputerUse} @param {string} chatId @param {PermissionOwner} owner @param {string} permission
   */
  async waitForPermission(chatId, owner, permission, { timeoutMs = 60000, everyMs = 2000 } = {}) {
    const until = Date.now() + timeoutMs;
    while (mayAct() && this.permissionLive(owner.lifecycle) && Date.now() < until) {
      if (!this.hasPermissionGuide(chatId)) return true;
      // Try again that still reads it off re-raised the card: the user has done what they can, so the call answers now
      if (this.permissionRevisions.get(chatId) !== owner.revision) return false;
      try {
        // only Screen Recording needs a new helper process to read a grant; reading the rest never relaunches it
        const status = await (permission === 'screenRecording' && this.helper.freshPermissionStatus
          ? this.helper.freshPermissionStatus(() => !this.controlling && !this.closed)
          : this.helper.permissionStatus());
        if (status?.[permission] === true) return true;
      } catch (error) {
        noteIgnored('wait for a computer-use permission grant', error);
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, everyMs));
    }
    return false;
  }

  /** "Try again" may refresh the helper: a Screen Recording grant can need a new process. @this {ComputerUse} */
  recheck(chatId) {
    return this.checkPermissionGuide(chatId, this.permissionOwner(chatId), () =>
      this.helper.freshPermissionStatus
        ? this.helper.freshPermissionStatus(() => !this.controlling && !this.closed)
        : this.helper.permissionStatus(),
    );
  }
}

module.exports = { ComputerPermissions };
