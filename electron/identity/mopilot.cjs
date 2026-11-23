// The MoPilot account main holds: the private one (electron/private/service/account.cjs) where this build has the
// MoPilot service, else one that is never signed in and tells the windows the service is not in this build.
const path = require('node:path');
const { optionalPrivate } = require('../platform/optionalPrivate.cjs');

const UNAVAILABLE = 'MoPilot accounts are not part of this build.';

/**
 * What main and the windows read of the account, in either build (the private account has more).
 * @typedef {{ id: string, email: string, name?: string | null, image?: string | null, internal?: boolean, features?: string[] }} MoPilotUser
 * @typedef {{ signedIn: boolean, signingIn: boolean, user: MoPilotUser | null, balanceMicros: number | null,
 *   shareUsageData: boolean | null, modelCaps: Record<string, MoPilotModelCaps> | null, checkedAt: number | null, unavailable?: true }} MoPilotStatus
 * @typedef {{ refreshToken: string, gatewayKey: string, user: MoPilotUser, deviceId: string }} MoPilotCreds
 * @typedef {{ fast: boolean, wires: string[], service_tiers: string[], drops: string[] }} MoPilotModelCaps
 */

/** The account in a build without the MoPilot service (the open-source edition): it holds nothing and calls nothing. */
class NoMoPilotAccount {
  /** @param {{ userData: string, broadcast: (status: ReturnType<NoMoPilotAccount["status"]>) => void, onConsent?: (account: boolean|null) => void }} o */
  constructor(o) {
    this.o = o;
    /** @type {MoPilotCreds | null} */
    this.creds = null;
    /** @type {'disabled' | null} */
    this.relayRefusal = null;
  }

  /** @returns {MoPilotStatus} */
  status() {
    return {
      signedIn: false,
      signingIn: false,
      user: null,
      balanceMicros: null,
      shareUsageData: null,
      modelCaps: null,
      checkedAt: null,
      // the windows hide what needs the account
      unavailable: true,
    };
  }

  /** @returns {string | null} */
  gatewayKey() {
    return null;
  }

  /** @returns {Promise<Record<string, MoPilotModelCaps> | null>} */
  async modelCaps() {
    return null;
  }

  /** @returns {Promise<{ ok: boolean, error?: string }>} */
  async signIn() {
    return { ok: false, error: UNAVAILABLE };
  }

  cancelSignIn() {
    /* no sign-in to cancel */
  }

  async signOut() {
    /* never signed in */
  }

  /** @param {boolean} [_force] @returns {Promise<string | null>} */
  async accessToken(_force) {
    return null;
  }

  /** @param {boolean} [_force] @returns {Promise<string | null>} */
  async relayToken(_force) {
    return null;
  }

  /** @param {string} _pathname @param {RequestInit} [_init] @returns {Promise<Response | null>} */
  async api(_pathname, _init) {
    return null;
  }

  /**
   * Tells main the account is signed out, as the private account's first status read does: what an earlier private build
   * left in this data folder for a MoPilot sign-in (Codex's MoPilot credits account and its key) is taken away then.
   */
  async refreshStatus() {
    this.o.broadcast(this.status());
    return this.status();
  }

  /** @param {boolean} _shareUsageData */
  async setConsent(_shareUsageData) {
    /* no account to tell */
  }

  /** @param {string} [_pathname] @returns {Promise<void>} */
  async openWeb(_pathname) {
    throw new Error(UNAVAILABLE);
  }

  /** @param {import('electron').IpcMain} ipcMain */
  register(ipcMain) {
    ipcMain.handle('mopilot:status', () => this.status());
    ipcMain.handle('mopilot:refresh', () => this.refreshStatus());
    ipcMain.handle('mopilot:signIn', () => this.signIn());
    ipcMain.handle('mopilot:cancelSignIn', () => this.cancelSignIn());
    ipcMain.handle('mopilot:signOut', () => this.signOut());
    ipcMain.handle('mopilot:openWeb', () => this.openWeb());
  }
}

const service = optionalPrivate(path.join(__dirname, '../private/service/account.cjs'));
/** The private account where the build has it, typed by what both have (tests/mopilotAccountShape.private.test.ts compares them). */
const MoPilotAccount = /** @type {typeof NoMoPilotAccount} */ (service?.MoPilotAccount ?? NoMoPilotAccount);

module.exports = { MoPilotAccount, NoMoPilotAccount, UNAVAILABLE };
