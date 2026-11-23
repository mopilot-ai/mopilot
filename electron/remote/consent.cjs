// Main owns Mobile Remote consent and blocks access when persistence cannot be acknowledged.
const { accountScope } = require('./accountScope.cjs');
const { STATE_VERSION } = require('../platform/chatRecord.cjs');

function createConsent(live, readState, patchPrefsSync, stateFile) {
  let blocked = false;
  let warning = false;
  const scope = () => accountScope(live.mopilot);
  const enabled = () => {
    const state = readState();
    const key = scope();
    return (
      !blocked &&
      !(typeof state.stateVersion === 'number' && state.stateVersion > STATE_VERSION) &&
      !!key &&
      state.prefs?.mobileRemoteOwner === key
    );
  };
  const set = (value) => {
    const key = scope();
    if (value && !key) throw new Error('Sign in to MoPilot first');
    blocked = true;
    try {
      const saved = patchPrefsSync(stateFile(), { mobileRemoteOwner: value ? key : null }, []);
      if (!saved) throw new Error('Consent was not saved');
      blocked = false;
      warning = false;
    } catch (error) {
      warning = true;
      // Never leave a failed opt-in queued for the write-behind retry.
      if (value) {
        try {
          patchPrefsSync(stateFile(), { mobileRemoteOwner: null }, []);
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            'Phone access could not be saved or cleared. Restore disk access and try again.',
          );
        }
      }
      throw error;
    }
  };
  return {
    scope,
    enabled,
    set,
    get warning() {
      return warning;
    },
  };
}
module.exports = { createConsent };
