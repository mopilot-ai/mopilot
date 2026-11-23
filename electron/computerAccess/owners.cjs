// Computer access (#1364): the remote owners on this Mac. A chat on a paired device that uses this Mac's tools runs
// them as an owner of its own, keyed by (device, the client's stable chat id). It is not a chat: it never enters the
// chat store, its grants live only here for as long as the device's connection, it never runs at Full access and it
// never inherits the global "Always allow" lists. The control plane asks `get(id)` wherever it would read a chat.
const { identityKey } = require('../../shared/identityKey.mjs');
const { noteIgnored } = require('../ignored.cjs');
const { anchorOf } = require('../capabilities/contract/policy.cjs');

/** The permission anchors, least to most. A remote owner is never above `ask`. */
const ANCHORS = ['readOnly', 'ask', 'auto', 'full'];
const CEILING = 'ask';
/** An anchor, or a permission mode read as one ('read-only' → readOnly, 'full-access' → full; unknown → ask). */
const rankOf = (a) => {
  const i = ANCHORS.indexOf(/** @type {any} */ (a));
  return i >= 0 ? i : ANCHORS.indexOf(anchorOf({ permission: typeof a === 'string' ? a : null }));
};

/**
 * The anchor a remote owner runs under: the stricter of the client chat's and this Mac's default, and never above Ask.
 * @param {unknown} client @param {unknown} host
 * @returns {'readOnly' | 'ask'}
 */
function remoteAnchor(client, host) {
  return /** @type {any} */ (ANCHORS[Math.min(rankOf(client), rankOf(host), rankOf(CEILING))]);
}

/**
 * @typedef {{ id: string, deviceId: string, deviceName: string, clientChat: string, harness: string, model: string | null,
 *   anchor: 'readOnly' | 'ask', human: boolean, hostOnlyApprovals: boolean, appGrants: { bundleId: string, name: string, level: string, at: number }[] }} RemoteOwner
 */

class RemoteOwners {
  constructor() {
    /** @type {Map<string, RemoteOwner>} */
    this.owners = new Map();
    /** @type {Set<(owner: RemoteOwner, why: string) => void>} */
    this.closeListeners = new Set();
    /** @type {Set<(owner: RemoteOwner) => void>} */
    this.openListeners = new Set();
    /** @type {((owner: RemoteOwner) => unknown) | null} tells the owner's device to stop its chat's turn */
    this.stopper = null;
  }

  /** @param {((owner: RemoteOwner) => unknown) | null} fn */
  setStopper(fn) {
    this.stopper = fn;
  }

  /**
   * Esc, the tray's Stop or a refusal that pauses: the owner's device is told to stop its chat's turn, and the owner
   * goes away here whatever the device answers, so nothing it held keeps running on this Mac.
   * @param {string} id
   */
  async stop(id) {
    const owner = this.get(id);
    if (!owner) return false;
    try {
      await this.stopper?.(owner);
    } catch (error) {
      // the device may be gone; the owner is closed below either way
      noteIgnored("tell a device to stop its chat's turn", error);
    }
    this.close(id, 'stopped');
    return true;
  }

  /** The owner id for a device's chat. */
  static idOf(deviceId, clientChat) {
    return identityKey('remote', deviceId, clientChat);
  }

  /**
   * The owner for a device's chat, made or brought up to date for a call: what the client says now about its chat
   * (its harness, model, mode and whether a person started the turn), under this Mac's default mode.
   * @param {{ deviceId: string, deviceName: string, clientChat: string, harness?: unknown, model?: unknown, anchor?: unknown,
   *   human?: unknown, hostAnchor: unknown, hostOnlyApprovals?: boolean }} o
   * @returns {RemoteOwner}
   */
  enter(o) {
    const id = RemoteOwners.idOf(o.deviceId, o.clientChat);
    const prev = this.owners.get(id);
    /** @type {RemoteOwner} */
    const owner = {
      id,
      deviceId: o.deviceId,
      deviceName: o.deviceName,
      clientChat: o.clientChat,
      harness: typeof o.harness === 'string' && o.harness ? o.harness.slice(0, 40) : 'remote',
      model: typeof o.model === 'string' && o.model ? o.model.slice(0, 120) : null,
      anchor: remoteAnchor(o.anchor, o.hostAnchor),
      human: o.human === true,
      hostOnlyApprovals: o.hostOnlyApprovals === true,
      appGrants: prev?.appGrants ?? [],
    };
    this.owners.set(id, owner);
    if (!prev) this.#tell(this.openListeners, owner);
    return owner;
  }

  /** The remote owner with this id, or null for anything else (a chat). */
  get(id) {
    return (typeof id === 'string' && this.owners.get(id)) || null;
  }

  /**
   * A remote owner's model (its client chat's, which has no record here), else `fallback(id)` for a chat.
   * @param {string} id @param {(id: string) => string | null} fallback
   */
  modelOr(id, fallback) {
    const owner = this.get(id);
    return owner ? owner.model : fallback(id);
  }

  /** What the control overlay says while a remote owner holds this Mac: who, and how to stop it. */
  indicatorLabel(id) {
    const owner = this.get(id);
    return owner ? `${owner.deviceName} is using your computer · Esc to stop` : null;
  }

  /** The owners of one device. */
  ofDevice(deviceId) {
    return [...this.owners.values()].filter((o) => o.deviceId === deviceId);
  }

  list() {
    return [...this.owners.values()];
  }

  /**
   * Calls `fn(owner)` whenever an owner starts: what an earlier owner of the same id left behind (a card withdrawn as
   * it closed settles after the close) is cleared before the new one runs. Returns a function that stops it.
   */
  onOpen(fn) {
    this.openListeners.add(fn);
    return () => this.openListeners.delete(fn);
  }

  /** @param {Set<(owner: RemoteOwner, why: string) => void>} listeners @param {RemoteOwner} owner @param {string} [why] */
  #tell(listeners, owner, why = '') {
    for (const fn of listeners) {
      try {
        fn(owner, why);
      } catch (error) {
        // one listener's failure must not keep the others from their part
        noteIgnored('tell a listener about a remote owner', error);
      }
    }
  }

  /** Calls `fn(owner, why)` whenever an owner goes away; returns a function that stops it. */
  onClose(fn) {
    this.closeListeners.add(fn);
    return () => this.closeListeners.delete(fn);
  }

  /**
   * The owner is gone (its turn ended, the device was revoked or disconnected, access was turned off): its grants
   * go with it, and listeners stop what it held.
   * @param {string} id @param {string} why
   */
  close(id, why) {
    const owner = this.owners.get(id);
    if (!owner) return false;
    this.owners.delete(id);
    this.#tell(this.closeListeners, owner, why);
    return true;
  }

  /** Closes every owner of a device; returns how many. */
  closeDevice(deviceId, why) {
    const ids = this.ofDevice(deviceId).map((o) => o.id);
    for (const id of ids) this.close(id, why);
    return ids.length;
  }

  /** Closes every owner; returns how many. */
  closeAll(why) {
    const ids = [...this.owners.keys()];
    for (const id of ids) this.close(id, why);
    return ids.length;
  }
}

module.exports = { RemoteOwners, remoteAnchor, ANCHORS };
