// Computer access (#1364): what this install keeps: its identity key, whether access is on, the devices paired with
// this Mac and the computers this install can use.
//
// The whole store is one file encrypted with safeStorage (the login keychain), so its keys stay secret and a process
// that can write the file still can't add a device of its own: a file that doesn't decrypt or doesn't validate
// trusts no device and is never written over until the person resets it. Without safeStorage nothing is saved and
// access can't be turned on (never a plaintext key, never a host that forgets its devices on restart).
const crypto = require('node:crypto');
const { fs } = require('../platform/ports/fs.cjs');
const path = require('node:path');
const { writePrivate } = require('../platform/fsutil.cjs');
const { canEncrypt } = require('../platform/encryptedStore.cjs');
const { noteIgnored } = require('../ignored.cjs');
const { newKeyPair, isKeyPair, isKey, deviceName } = require('./handshake.cjs');

const VERSION = 1;
/** A device unused this long must pair again. */
const IDLE_MS = 30 * 24 * 60 * 60 * 1000;
/** What a paired device may use on this Mac. */
const SCOPES = ['browser', 'chrome', 'apps', 'files'];
/** Until the person picks: the built-in browser only. */
const DEFAULT_SCOPES = Object.freeze({ browser: true, chrome: false, apps: false, files: false });
const ID = /^[0-9a-f]{16}$/;
/** Where a client reaches a host: a host name, an IPv4 address or a bracketed IPv6 one. */
const ADDRESS = /^([A-Za-z0-9.-]{1,253}|\[[0-9A-Fa-f:.]{2,45}\])$/;

class StoreError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const isTime = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const isPort = (v) => Number.isInteger(v) && v >= 1 && v <= 65535;

/** @param {any} v */
function scopesOf(v) {
  const o = v && typeof v === 'object' ? v : {};
  return Object.fromEntries(SCOPES.map((k) => [k, o[k] === true]));
}

/** @param {any} d */
const validDevice = (d) =>
  !!d &&
  ID.test(d.id) &&
  typeof d.name === 'string' &&
  isKey(d.key) &&
  isTime(d.pairedAt) &&
  (d.lastSeen == null || isTime(d.lastSeen)) &&
  !!d.scopes &&
  typeof d.scopes === 'object';

/** @param {any} h */
const validHost = (h) =>
  !!h && ID.test(h.id) && typeof h.name === 'string' && isKey(h.key) && ADDRESS.test(h.address) && isPort(h.port) && isTime(h.pairedAt);

/** @param {any} d */
function valid(d) {
  return (
    !!d &&
    d.v === VERSION &&
    isKeyPair(d.identity) &&
    typeof d.enabled === 'boolean' &&
    typeof d.lan === 'boolean' &&
    Array.isArray(d.devices) &&
    d.devices.every(validDevice) &&
    Array.isArray(d.hosts) &&
    d.hosts.every(validHost)
  );
}

const empty = () => ({ v: VERSION, identity: newKeyPair(), enabled: false, lan: false, devices: [], hosts: [] });
const newId = () => crypto.randomBytes(8).toString('hex');

class AccessStore {
  /**
   * @param {{ file: string, safeStorage: { isEncryptionAvailable(): boolean, encryptString(s: string): Buffer, decryptString(b: Buffer): string },
   *           now?: () => number }} o
   */
  constructor(o) {
    this.file = o.file;
    this.safe = o.safeStorage;
    this.now = o.now ?? Date.now;
    /** @type {any} the store as last read or written; undefined until first read */
    this.data = undefined;
    /** @type {string | null} why the saved store can't be used (it is kept on disk, and nothing is trusted) */
    this.error = null;
  }

  /** Whether this Mac can keep the store at all (safeStorage encrypts). */
  get available() {
    return canEncrypt(this.safe);
  }

  #read() {
    if (this.data !== undefined) return this.data;
    let text;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch (error) {
      if (/** @type {any} */ (error)?.code !== 'ENOENT') {
        this.error = 'The computer access settings could not be read';
        noteIgnored('read the computer access store', error);
      }
      return (this.data = null);
    }
    try {
      const outer = JSON.parse(text);
      const inner = JSON.parse(this.safe.decryptString(Buffer.from(String(outer?.data), 'base64')));
      if (outer?.v !== VERSION || !valid(inner)) throw new Error('invalid computer access store');
      return (this.data = inner);
    } catch (error) {
      noteIgnored('decrypt the computer access store', error);
      this.error = 'The computer access settings could not be read on this Mac';
      return (this.data = null);
    }
  }

  /** @param {any} next */
  #write(next) {
    if (!this.available) throw new StoreError('unavailable', "This Mac can't keep computer access keys encrypted");
    const data = this.safe.encryptString(JSON.stringify(next)).toString('base64');
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    writePrivate(this.file, JSON.stringify({ v: VERSION, data }));
    this.data = next;
    return next;
  }

  /** The store, or a new one (not saved yet) when there is none; null when the saved one can't be used. */
  #current() {
    const d = this.#read();
    if (this.error) return null;
    return d ?? empty();
  }

  /** @param {(d: any) => any} change */
  #update(change) {
    const d = this.#current();
    if (!d) throw new StoreError('unreadable', `${this.error}. Reset computer access to start over.`);
    return this.#write(change(structuredClone(d)));
  }

  /** Why the saved store can't be used, or null. */
  problem() {
    this.#read();
    return this.error;
  }

  /** This install's identity key pair, made and saved on first use. */
  identity() {
    const d = this.#read();
    if (d) return d.identity;
    return this.#update((x) => x).identity;
  }

  /** Whether the person turned access to this Mac on (false when the store can't be read). */
  enabled() {
    return this.#current()?.enabled === true;
  }

  /** @param {boolean} on */
  setEnabled(on) {
    this.#update((d) => ({ ...d, enabled: on === true }));
  }

  /** Whether other computers on the network may connect (false: loopback only). */
  lan() {
    return this.#current()?.lan === true;
  }

  /** @param {boolean} on */
  setLan(on) {
    this.#update((d) => ({ ...d, lan: on === true }));
  }

  /** @param {any} d */
  #expired(d) {
    return this.now() - (d.lastSeen ?? d.pairedAt) > IDLE_MS;
  }

  /** The devices paired with this Mac, each with its scopes and whether it has to pair again. */
  devices() {
    return (this.#current()?.devices ?? []).map((d) => ({ ...d, scopes: scopesOf(d.scopes), expired: this.#expired(d) }));
  }

  /** The paired, unexpired device with this key, or null. */
  deviceByKey(key) {
    const d = (this.#current()?.devices ?? []).find((x) => x.key === key);
    return d && !this.#expired(d) ? { ...d, scopes: scopesOf(d.scopes) } : null;
  }

  /**
   * A device the person allowed: a new id each time, so a device paired again gets none of the old one's grants.
   * A device paired before under the same key is replaced.
   * @param {{ name: string, key: string, scopes?: any }} o
   */
  addDevice(o) {
    if (!isKey(o?.key)) throw new StoreError('bad_device', 'Not a device key');
    const device = {
      id: newId(),
      name: deviceName(o.name),
      key: o.key,
      scopes: scopesOf(o.scopes ?? DEFAULT_SCOPES),
      pairedAt: this.now(),
      lastSeen: null,
      hostOnlyApprovals: false,
    };
    this.#update((d) => ({ ...d, devices: [...d.devices.filter((x) => x.key !== o.key), device] }));
    return { ...device, expired: false };
  }

  /** Removes a device: its key stops working. True when it was there. */
  revokeDevice(id) {
    const d = this.#current();
    if (!d?.devices.some((x) => x.id === id)) return false;
    this.#update((x) => ({ ...x, devices: x.devices.filter((y) => y.id !== id) }));
    return true;
  }

  /**
   * What the person changed about a device: its scopes, or whether only this Mac can approve its actions.
   * @param {string} id @param {{ scopes?: any, hostOnlyApprovals?: boolean }} patch
   */
  setDevice(id, patch) {
    this.#update((d) => {
      const i = d.devices.findIndex((x) => x.id === id);
      if (i < 0) throw new StoreError('no_device', 'That device is not paired');
      const x = d.devices[i];
      d.devices[i] = {
        ...x,
        ...(patch.scopes ? { scopes: scopesOf(patch.scopes) } : {}),
        ...(typeof patch.hostOnlyApprovals === 'boolean' ? { hostOnlyApprovals: patch.hostOnlyApprovals } : {}),
      };
      return d;
    });
  }

  /** The device connected now: its idle time starts again. */
  touchDevice(id) {
    this.#update((d) => ({ ...d, devices: d.devices.map((x) => (x.id === id ? { ...x, lastSeen: this.now() } : x)) }));
  }

  /** The computers this install paired with, to use their browser, apps and files. */
  hosts() {
    return (this.#current()?.hosts ?? []).map((h) => ({ ...h }));
  }

  /**
   * A computer this install paired with. One paired before with the same key is replaced.
   * @param {{ name: string, key: string, address: string, port: number }} o
   */
  addHost(o) {
    if (!isKey(o?.key) || !ADDRESS.test(o?.address) || !isPort(o?.port)) throw new StoreError('bad_host', 'Not a computer to pair with');
    const host = { id: newId(), name: deviceName(o.name), key: o.key, address: o.address, port: o.port, pairedAt: this.now() };
    this.#update((d) => ({ ...d, hosts: [...d.hosts.filter((x) => x.key !== o.key), host] }));
    return { ...host };
  }

  /** Forgets a computer. True when it was there. */
  removeHost(id) {
    const d = this.#current();
    if (!d?.hosts.some((x) => x.id === id)) return false;
    this.#update((x) => ({ ...x, hosts: x.hosts.filter((y) => y.id !== id) }));
    return true;
  }

  /**
   * Starts over: a new identity, access off, no devices and no computers. The unreadable file is kept beside it as
   * `<file>.unreadable` for support; an earlier copy there is kept, as readStoreFile keeps one.
   */
  reset() {
    // read first: a reset before anything read the file must still keep the copy it can't use
    this.#read();
    if (this.error) {
      try {
        fs.copyFileSync(this.file, `${this.file}.unreadable`, fs.constants.COPYFILE_EXCL);
      } catch (error) {
        // EEXIST: the first unreadable copy is kept
        noteIgnored('keep the unreadable computer access store', error, ['EEXIST']);
      }
    }
    this.error = null;
    this.data = undefined;
    return this.#write(empty());
  }
}

module.exports = { AccessStore, StoreError, SCOPES, DEFAULT_SCOPES, IDLE_MS };
