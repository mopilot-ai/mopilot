// Owns attachment admission for local composers, including live draft-target checks after asynchronous file reads.
import { useEffect, useRef } from 'react';
import { useChatMachine } from '../lib/chatMachine';
import { hostOfChatNow, subscribeHostChats } from '../lib/hostChats';
import { get, useStore } from '../store/core';
import { currentCwdForNewChat, newChatHostPick } from '../store/projects';

export function useAttachmentTarget(threadId: string | null) {
  const { machine, pending } = useChatMachine(threadId);
  const draft = useStore((s) => (threadId ? null : newChatHostPick(s)));
  const why = pending
    ? 'Checking where this chat runs.'
    : machine || draft
      ? `Only images, files and folders can be attached to a chat on ${(machine ?? draft)!.name}. Local skills are unavailable.`
      : null;
  const revisions = useRef(new Map<string, { target: string; serial: number }>());
  const readers = useRef(new Map<string, () => unknown>());
  const read = () => {
    const state = get();
    const pick = threadId ? null : newChatHostPick(state);
    const owner = threadId ? hostOfChatNow(threadId) : (pick?.id ?? '');
    const target = JSON.stringify([
      owner,
      threadId,
      pick?.id,
      pick?.path,
      threadId ? state.threads[threadId]?.cwd : currentCwdForNewChat(),
      threadId ? null : state.newChatProjectId,
    ]);
    const blocked = owner !== '';
    const identity = JSON.stringify([target, blocked]);
    const slot = threadId ?? 'home';
    let revision = revisions.current.get(slot);
    if (revision?.target !== identity) {
      revision = { target: identity, serial: (revision?.serial ?? 0) + 1 };
      revisions.current.set(slot, revision);
    }
    return { key: JSON.stringify([target, revision.serial]), blocked, pending };
  };
  readers.current.set(threadId ?? 'home', read);
  read();
  useEffect(() => {
    const update = () => {
      for (const refresh of readers.current.values()) refresh();
    };
    const offStore = useStore.subscribe(update);
    const offHosts = subscribeHostChats(update);
    return () => {
      offStore();
      offHosts();
    };
  }, []);
  return { why, read };
}
