// The next steps for MoPilot's own Chrome extension (Add to Chrome, Allow, Connect), run the same way from Settings and the welcome page (#2034).
import { native } from '../lib/native';
import type { NativeSetupAction } from '../lib/native';
import type { ChromePairResult } from '../lib/native/availability';
import { toast, toastFailure } from '../store/core';

/** What Connect tells the user, by what main did (electron/capabilities/browser/chromeExtension.cjs pair). */
export const PAIR_RESULT: Record<ChromePairResult, [string, 'info' | 'error']> = {
  opened: ['Opened in Chrome. If MoPilot then asks, click Allow in MoPilot.', 'info'],
  connected: ['Already connected.', 'info'],
  missing: ['The extension isn’t installed in this Chrome profile.', 'error'],
  off: ['Turn the extension on in chrome://extensions, then try again.', 'error'],
  unreadable: ['Couldn’t read the saved pairing. Restart MoPilot, then try again.', 'error'],
  unavailable: ['This build of MoPilot doesn’t use its Chrome extension.', 'error'],
};

export type ChromeExtensionAction = Extract<NativeSetupAction, { kind: 'chromePair' | 'chromeAllow' | 'chromeInstall' }>;

export const isChromeExtensionAction = (a: NativeSetupAction): a is ChromeExtensionAction =>
  a.kind === 'chromePair' || a.kind === 'chromeAllow' || a.kind === 'chromeInstall';

/** Runs one; the extension's row changes on its own once the extension connects (availability:changed). */
export function runChromeExtensionAction(a: ChromeExtensionAction): void {
  if (a.kind === 'chromePair')
    native.availability.chromePair().then((r) => {
      const [text, kind] = PAIR_RESULT[r] ?? PAIR_RESULT.unavailable;
      toast(text, kind);
    }, toastFailure("Couldn't open the extension's pairing page"));
  // "Allow Chrome to connect?" (chromePairOffers.cjs)
  else if (a.kind === 'chromeAllow') native.availability.chromeAllow(true).catch(toastFailure("Couldn't allow Chrome"));
  // the store page opens in Chrome; the row turns Connected once the extension is added and allowed
  else native.availability.chromeInstall().catch(toastFailure("Couldn't open the Chrome Web Store"));
}
