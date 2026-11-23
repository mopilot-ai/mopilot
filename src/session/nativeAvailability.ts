// The per-harness native-control status from main (electron/capabilities/nativeAvailability.cjs), shared by
// the Browser and Computer use settings and the Claude in Chrome note, so every place reads one answer.
import { useEffect, useState } from 'react';
import { native, type ChromeLinkEntry, type NativeAvailabilityStatus } from '../lib/native';
import { ignoring } from '../lib/ignored';
import { HARNESS_TRAITS } from '../harness/family';
import { createLatestLoader } from '../lib/latestLoader';

/**
 * The status, reloaded when main finds a change, when the window is focused, and when the browser channel
 * changes; null until the first answer. `refresh`: probe again first (a settings page was opened).
 */
export function useNativeAvailability(refresh = false): NativeAvailabilityStatus | null {
  const [status, setStatus] = useState<NativeAvailabilityStatus | null>(null);
  useEffect(() => {
    const loader = createLatestLoader(
      (_current, again: boolean) => native.availability.status(again),
      setStatus,
      // the last answer stays; focus or the next change asks again
      ignoring('read the native-control status'),
    );
    void loader.load(refresh);
    const load = () => void loader.load(false);
    const offChanged = native.availability.onChanged(load);
    const offChannel = native.browser.onChannelChanged(load);
    const onFocus = load;
    window.addEventListener('focus', onFocus);
    return () => {
      loader.stop();
      offChanged();
      offChannel();
      window.removeEventListener('focus', onFocus);
    };
  }, [refresh]);
  return status;
}

/** Whether the harness whose sessions run Claude in Chrome themselves (Claude Code) has it ready: login, switch and extension. */
export function claudeRunsClaudeInChrome(status: NativeAvailabilityStatus | null): boolean {
  return status?.harnesses.find((h) => HARNESS_TRAITS[h.harness].nativeChrome)?.chrome.state === 'native';
}

/**
 * What reaches the user's Chrome for the harness whose sessions would run Claude in Chrome, without it: Your Chrome
 * while it is the browser channel (which hides the chrome_* tools), MoPilot's own channel while main says it can
 * serve sessions (`chromeTools`) and that harness's row can use it, else nothing (#1631). The note and Settings read
 * this one answer.
 */
export function chromeRouteOf(status: NativeAvailabilityStatus | null, browserChannel: string): 'yourChrome' | 'own' | 'none' {
  if (browserChannel === 'chrome') return 'yourChrome';
  const row = status?.harnesses.find((h) => HARNESS_TRAITS[h.harness].nativeChrome)?.chrome;
  return status?.chromeTools && row && row.state !== 'unavailable' ? 'own' : 'none';
}

/**
 * Claude in Chrome's live link in each Claude Code session that runs it (electron/harness/claude/chromeLink.cjs):
 * read again by each session when the hook starts, then reloaded when main says one changed; null until the
 * first answer, or while `on` is false.
 */
export function useChromeLinks(on: boolean): ChromeLinkEntry[] | null {
  const [links, setLinks] = useState<ChromeLinkEntry[] | null>(null);
  useEffect(() => {
    if (!on) return setLinks(null);
    const loader = createLatestLoader(
      (_current, refresh: boolean) => native.availability.chromeLinks(refresh),
      setLinks,
      // the last answer stays; the next change asks again
      ignoring("read Claude in Chrome's session links"),
    );
    void loader.load(true);
    const off = native.availability.onChromeLinksChanged(() => void loader.load(false));
    return () => {
      loader.stop();
      off();
    };
  }, [on]);
  return on ? links : null;
}

export interface ChromeLinkSummary {
  /** sessions whose link was read: connected, and not */
  connected: number;
  down: number;
  /** the browser a connected session uses, when the CLI names it */
  browser: string | null;
  text: string;
}

const chats = (n: number) => (n === 1 ? '1 chat' : `${n} chats`);

/** What the Claude Code row says about the live links; null when no open chat has read one. */
export function chromeLinkSummary(links: ChromeLinkEntry[] | null): ChromeLinkSummary | null {
  const read = (links ?? []).flatMap((l) => (l.link ? [l.link] : []));
  if (!read.length) return null;
  const down = read.filter((l) => !l.connected).length;
  const connected = read.length - down;
  const browser = read.find((l) => l.connected && l.browser)?.browser ?? null;
  const parts: string[] = [];
  if (connected) parts.push(`Connected${browser ? ` to ${browser}` : ''} in ${chats(connected)}.`);
  if (down) parts.push(`Disconnected in ${chats(down)}.`);
  return { connected, down, browser, text: parts.join(' ') };
}
