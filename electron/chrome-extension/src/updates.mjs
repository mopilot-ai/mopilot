// Extension updates (#1986): one Chrome downloaded is applied once no agent holds a tab, as ChatGPT's reloads when idle, and Update extension asks Chrome for one now.
//
// The connection's keepalive keeps the service worker from ever going idle, so without this Chrome would hold a
// downloaded update until the browser restarts. A reload in the middle of an agent's turn would drop its tabs, so it
// waits for the last held tab to be let go (`idle`), checked again with each reconnect alarm.

/** What Update extension says when Chrome has nothing newer to install yet. */
export const NO_UPDATE = 'No newer version is available yet. Chrome checks every few hours; try again later.';

export class Updates {
  /**
   * @param {{ chrome: any, idle: () => boolean, log: (what: string, error: unknown) => void }} o idle: no agent holds a tab
   */
  constructor(o) {
    this.o = o;
    /** an update Chrome downloaded is waiting to be applied */
    this.pending = false;
    o.chrome.runtime.onUpdateAvailable.addListener(() => {
      this.pending = true;
      this.apply();
    });
  }

  /** Applies a downloaded update now when no agent holds a tab; true when it reloads. */
  apply() {
    if (!this.pending || !this.o.idle()) return false;
    this.o.chrome.runtime.reload();
    return true;
  }

  /**
   * Update extension: asks Chrome for a newer version now. Resolves with what to tell the user, or null while Chrome
   * downloads one (it is applied as it lands: onUpdateAvailable).
   * @returns {Promise<string | null>}
   */
  async check() {
    if (this.apply()) return null;
    let answer;
    try {
      answer = await this.o.chrome.runtime.requestUpdateCheck();
    } catch (error) {
      // an unpacked extension has no update URL to check
      this.o.log('check for an extension update', error);
      return NO_UPDATE;
    }
    return answer?.status === 'update_available' ? null : NO_UPDATE;
  }
}
