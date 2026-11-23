// What each machine chat waits for, as its Host says (main: attentionLane.cjs): read once, then every change. With `host.unattended` off, or from an older Host that sends none, every chat has none and nothing new shows.
import { useEffect, useSyncExternalStore } from 'react';
import { native } from './native';
import type { HostAttention } from './native/host';
import { ignoring } from './ignored';
import { useFlag } from './flags';

let held: ReadonlyMap<string, HostAttention> = new Map();
let started = false;
const listeners = new Set<() => void>();
const publish = (next: ReadonlyMap<string, HostAttention>) => {
  held = next;
  for (const l of listeners) l();
};

/** Starts reading once; called by the first hook that needs it. */
function start() {
  if (started) return;
  started = true;
  native.host.onAttention(({ chatId, attention }) => {
    const next = new Map(held);
    if (attention) next.set(chatId, attention);
    else next.delete(chatId);
    publish(next);
  });
  void Promise.resolve(native.host.attentions()).then(
    (all) => publish(new Map(Object.entries(all ?? {}))),
    ignoring('read what machine chats wait for'),
  );
}

/** The chat's attention, null for none; always null while the flag is off. */
export function useChatAttention(chatId: string | null): HostAttention | null {
  const on = useFlag('host.unattended');
  useEffect(() => {
    if (on) start();
  }, [on]);
  const all = useSyncExternalStore(
    (cb) => (listeners.add(cb), () => void listeners.delete(cb)),
    () => held,
  );
  return on && chatId ? (all.get(chatId) ?? null) : null;
}

/** Forgets what was read (tests). */
export function resetChatAttention() {
  held = new Map();
  started = false;
}
