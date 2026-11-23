// A development build that talks to a dev host pairs from a link, `mopilot://pair?code=<the pairing code, URL-encoded>`, so a script can pair an emulator without typing a 300-character code. The pairing runs as from the form; the Mac still approves it after comparing the safety number.
import edition from '../config/edition.json' with { type: 'json' };
import type { MobileRuntime } from './contracts';

/** The part of React Native's Linking this needs. */
export type Links = {
  getInitialURL(): Promise<string | null | undefined>;
  addEventListener(type: 'url', listener: (event: { url: string }) => void): { remove(): void };
};

const PREFIX = `${edition.scheme}://pair?code=`;

/** The pairing code a pairing link carries, or null for any other link. */
export function pairingCodeOf(url: string | null | undefined): string | null {
  if (!url?.startsWith(PREFIX)) return null;
  try {
    return decodeURIComponent(url.slice(PREFIX.length)) || null;
  } catch {
    return null;
  }
}

/** Whether a pairing code's own expiry (`exp`, ms) has passed; a code without a readable expiry is left to the pairing itself. */
export function expired(code: string, now: number): boolean {
  try {
    const exp = (JSON.parse(code) as { exp?: unknown }).exp;
    return typeof exp === 'number' && exp < now;
  } catch {
    return false;
  }
}

/** The runtime can take a pairing: signed in, a computer not being added, no attempt or cleanup under way. */
const ready = (s: ReturnType<MobileRuntime['snapshot']>) =>
  !!s.user && ['ready', 'offline', 'online'].includes(s.phase) && !s.pendingPair && !s.pairingCommit && !s.pairCleanup;

export type DevPairLinkOptions = {
  /** Leave the link that opened the app alone: it was already handled in this JavaScript process (a reload would replay it). */
  skipInitial?: boolean;
  now?: () => number;
  report?: (message: string) => void;
};

/**
 * Pairs with the code of a pairing link: the one that opened the app and those that arrive while it runs. The newest code waits until the runtime
 * is signed in and idle (a cold start opens the link before the account is read), and one pairing runs at a time. An expired code is dropped, since
 * starting a pairing disconnects the phone. Only a build with a dev host listens (`dev`): a store build ignores such links, so no web page or app
 * can start a pairing on a person's phone. Returns the stop function.
 */
export function watchDevPairLink(
  runtime: Pick<MobileRuntime, 'pair' | 'snapshot' | 'subscribe'>,
  name: string,
  dev: boolean,
  links: Links,
  { skipInitial = false, now = Date.now, report = console.warn }: DevPairLinkOptions = {},
): () => void {
  if (!dev) return () => undefined;
  let live = true;
  let waiting: string | null = null;
  let running = false;
  const attempt = () => {
    if (!live || running || waiting === null || !ready(runtime.snapshot())) return;
    const code = waiting;
    waiting = null;
    running = true;
    runtime
      .pair(code, name)
      .catch((e: unknown) => report(`pairing link: ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => {
        running = false;
        attempt();
      });
  };
  const receive = (url: string | null | undefined) => {
    const code = pairingCodeOf(url);
    if (!code || !live) return;
    if (expired(code, now())) return report('pairing link: the code has expired');
    waiting = code;
    attempt();
  };
  if (!skipInitial) void links.getInitialURL().then(receive, () => undefined);
  const subscription = links.addEventListener('url', ({ url }) => receive(url));
  const unsubscribe = runtime.subscribe(attempt);
  return () => {
    live = false;
    subscription.remove();
    unsubscribe();
  };
}
