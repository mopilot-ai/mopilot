// A button bound to a turn, tab, task or app the window showed: it acts only while that one is still live, and says so.
import { errorText, ignoring } from '../lib/ignored';

/** The one line a window shows when the turn, tab, task or app a button was for already ended or was replaced. */
export const ALREADY_ENDED = 'Already ended';
/** A message's button whose message is no longer in its chat (rewound, or the chat reloaded without it). */
export const MESSAGE_GONE = "That message isn't in this chat now";
/** An expired account's "Sign in again" when the account was removed since (main says the same, electron/identity/codexAccounts.cjs). */
export const ACCOUNT_REMOVED = 'That account was removed';
/** A chat's limit toast whose chat already moved to another harness since it showed. */
export const ALREADY_SWITCHED = 'This chat already switched harness';

/** What an id-taking action answers: true (or nothing) when it acted, false or 'retired' when its entity was gone. */
export type LiveResult = boolean | 'retired' | undefined | void;

/** The app's toast, loaded when a line is said: the store stays out of the components' import graph until then. */
const toast = (text: string, kind?: 'error') =>
  void import('./core').then((core) => core.toast(text, kind)).catch(ignoring('show a button’s outcome'));

/**
 * Awaits an action bound to an id captured at render time. When main (or the store) says that entity already ended
 * (false or 'retired'), says the shared line once through `say` and resolves false; nothing was done.
 */
export async function liveAction(call: LiveResult | Promise<LiveResult>, say: (text: string) => void = toast): Promise<boolean> {
  const r = await call;
  if (r === false || r === 'retired') {
    say(ALREADY_ENDED);
    return false;
  }
  return true;
}

/** For an action whose false already said why (a toast, the composer): only its 'retired' takes the shared line. */
export const onlyRetired = (r: unknown): LiveResult => (r === 'retired' ? r : undefined);

/** liveAction from a click handler: nothing to await, and a failure says so instead of going unhandled. */
export function liveClick(call: LiveResult | Promise<LiveResult>): void {
  liveAction(call).catch((e) => toast(`Couldn't do that: ${errorText(e)}`, 'error'));
}
