// The app's macOS microphone grant: its status, the first-use prompt, and the Privacy pane that turns it back on.
const MIC_SETTINGS = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone';

/**
 * @param {{ systemPreferences: any, shell: { openExternal(url: string): Promise<void> }, platform?: string }} o
 */
function createMicAccess({ systemPreferences, shell, platform = process.platform }) {
  const mac = platform === 'darwin';
  return {
    /** 'granted' | 'denied' | 'restricted' | 'not-determined' | 'unknown'; other platforms have no app-level grant */
    status() {
      if (!mac) return 'granted';
      try {
        return systemPreferences.getMediaAccessStatus('microphone');
      } catch {
        return 'unknown';
      }
    },
    /** Asks macOS only when it hasn't asked yet; answers the status afterwards. */
    async ask() {
      const before = this.status();
      if (before !== 'not-determined') return before;
      try {
        return (await systemPreferences.askForMediaAccess('microphone')) ? 'granted' : 'denied';
      } catch {
        return 'unknown';
      }
    },
    async openSettings() {
      if (mac) await shell.openExternal(MIC_SETTINGS);
    },
  };
}

module.exports = { createMicAccess, MIC_SETTINGS };
