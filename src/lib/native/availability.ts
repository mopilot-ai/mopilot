// window.native.availability's types (native browser and computer control availability), merged into NativeApi; the calls are declared in electron/bridge/availability.cjs.
import type { ChromeLinkEntry, ChromeLinkResult, NativeAvailabilityStatus, PairedBrowser } from '../native';

/**
 * What Pair did: opened the page; connected (nothing to pair); missing or off (not on in the profile it pairs in);
 * unreadable (the saved pairing can't be read); unavailable (main doesn't serve the extension).
 */
export type ChromePairResult = 'opened' | 'connected' | 'missing' | 'off' | 'unreadable' | 'unavailable';

declare module '../native' {
  interface NativeApi {
    /** Which native browser and computer control each harness gets on this Mac (electron/capabilities/nativeAvailability.cjs). */
    availability: {
      /** refresh: probe again first (the settings page was opened) */
      status(refresh?: boolean): Promise<NativeAvailabilityStatus>;
      /** what was found on this Mac changed (checked again when a window is focused) */
      onChanged(cb: () => void): () => void;
      /** Installs Codex Computer Use again after a failure, and forgets a permission it reported missing; answers the new status */
      retry(): Promise<NativeAvailabilityStatus>;
      /** Claude in Chrome's live link in each Claude Code session that runs it */
      /** refresh: each session reads its link again first (the settings page was opened) */
      chromeLinks(refresh?: boolean): Promise<ChromeLinkEntry[]>;
      onChromeLinksChanged(cb: () => void): () => void;
      /** Reconnects one chat's session, or with no chat every session whose link is down */
      chromeReconnect(chatId?: string | null): Promise<ChromeLinkResult[]>;
      chromeBrowsers(): Promise<PairedBrowser[]>;
      /** Every connected session switches to this browser */
      chromeSelect(id: string): Promise<ChromeLinkResult[]>;
      /** Opens MoPilot's own extension's pairing page in the user's Chrome (Settings → Browser's Pair) */
      chromePair(): Promise<ChromePairResult>;
      /** "Allow Chrome to connect?" answered; true when Allow offered the pairing. */
      chromeAllow(allow: boolean, name?: string): Promise<boolean>;
      /** "Add to Chrome": the extension's store page, in Chrome when it can open (else another browser). */
      chromeInstall(): Promise<'chrome' | 'browser' | 'unavailable'>;
    };
  }
}
