// The usage-data sharing choice made in Settings → Privacy: stored, applied to uploads, and sent to the account.
import { native } from '../../lib/native';
import { setPrefs, toastFailure } from '../../store/core';

/** The user's own choice: stored, applied to uploads, and sent to the MoPilot account. */
export function chooseShareUsageData(v: boolean) {
  setPrefs({ shareUsageData: v });
  // main applies it to uploads: say so when it didn't get there (Settings → Privacy sets it again)
  native.telemetry.setConsent(v).catch(toastFailure("Couldn't apply your usage data choice"));
}
