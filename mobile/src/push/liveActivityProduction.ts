// Production wiring of the Live Activity controller: the native module's defaults for the switch, the runtime for the relay and the chat counts, the app's lifecycle for foreground and account changes.
import { chatPage, CHAT_PAGE } from '../chatPages';
import type { MobileRuntime } from '../contracts';
import { onForeground } from '../platform/lifecycle';
import { liveActivityNative } from '../platform/liveActivity';
import {
  createLiveActivity,
  parseLiveActivityPrefs,
  type ActivityCounts,
  type LiveActivityNative,
  type LiveActivityPrefs,
} from './liveActivityController';

/** The saved switch lives in the app's defaults (the native module), not the keychain: an uninstall removes it, so a reinstalled app starts with the switch off. Without the module there is nothing to keep. */
export const prefsStore = (native: LiveActivityNative | null = liveActivityNative()) => ({
  read: async () => parseLiveActivityPrefs((await native?.loadPrefs().catch(() => null)) ?? null),
  write: async (prefs: LiveActivityPrefs) => {
    await native?.savePrefs(JSON.stringify(prefs));
  },
});

/** The chats waiting for the person and running among the recent ones; null while no computer is connected, so nothing is decided on a guess. */
export async function countChats(runtime: Pick<MobileRuntime, 'snapshot' | 'request'>): Promise<ActivityCounts | null> {
  if (runtime.snapshot().phase !== 'online') return null;
  const { chats } = chatPage(await runtime.request('chats.recent', { limit: CHAT_PAGE }));
  return {
    needs: chats.filter((chat) => chat.state === 'waiting').length,
    running: chats.filter((chat) => chat.state === 'running').length,
  };
}

/** Calls back when the signed-in account or whether a computer is connected changes: not on every snapshot. */
export function accountEvents(runtime: Pick<MobileRuntime, 'snapshot' | 'subscribe'>) {
  return (listener: () => void) => {
    const key = () => `${runtime.snapshot().user?.id ?? ''}|${runtime.snapshot().phase === 'online'}`;
    let last = key();
    return runtime.subscribe(() => {
      const next = key();
      if (next === last) return;
      last = next;
      listener();
    });
  };
}

export function createProductionLiveActivity(runtime: MobileRuntime) {
  const native = liveActivityNative();
  return createLiveActivity({
    native,
    relay: { register: (token) => runtime.activityRegister(token), unregister: () => runtime.activityUnregister() },
    store: prefsStore(native),
    counts: () => countChats(runtime),
    signedIn: () => !!runtime.snapshot().user,
    foreground: onForeground,
    account: accountEvents(runtime),
  });
}
