// Whether a message sent while the chat's turn runs can go into it, for the composer's Send label and running-turn hint: main's `steer` capability for the chat.
import { useRef } from 'react';
import type { CapView } from '../../store/session/useCaps';

/**
 * Main's word on whether the chat's agent takes a message into its running turn (a machine's Claude Code or Codex chat
 * steers on its Host). While main is asked again (a turn starts, an agent's usage arrives) the chat's last answer
 * stands, so the label doesn't flicker; before any answer for this chat, its tier: a first-tier chat steers.
 * @param steer the chat's `steer` capability, or null while it is not loaded
 * @param basic the chat's basic harness, or null for a first-tier chat
 */
export function useComposerSteers(threadId: string | null, steer: CapView | null, basic: string | null): boolean {
  const known = useRef<{ chat: string | null; steers: boolean } | null>(null);
  if (steer) known.current = { chat: threadId, steers: steer.state === 'native' };
  return known.current?.chat === threadId ? known.current.steers : !basic;
}
