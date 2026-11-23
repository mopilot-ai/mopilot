// What a chat's Remote Control switch shows and does, by the chat's harness: Claude Code links the chat's session to claude.ai,
// Codex links the whole app-server to the user's devices. Only harnesses with a link get a switch in the rail.
import { useRef } from 'react';
import { whyText } from '../harness/caps';
import { remoteControlScope } from '../harness/family';
import { useStore } from '../store/core';
import { navigate } from '../store/panes';
import { codexRemoteControlRow, remoteControlRow, type RemoteControlRow } from './remoteControlRow';
import { setCodexRemoteControl, useCodexRemoteControl } from './harness/codexRemoteControl';
import { setRemoteControl } from './harness/claude/remoteControl';
import type { HarnessKind } from '../harness/adapter';
import { useChatCaps } from '../store/session/useCaps';
import { useSession } from '../store/session/useSession';

export interface RemoteControlSwitch extends RemoteControlRow {
  /** Show the switch for a supported harness, including when its account needs attention. */
  visible: boolean;
  /** Turn the link on or off. */
  set: (on: boolean) => unknown;
  /** Where the link's devices and pairing are managed (Settings), for a link that is the computer's. */
  manage?: () => void;
  /** Turning it on exposes more than the chat (the whole computer), so the user is asked first. */
  confirmOn: boolean;
}

/** The switch before the chat's capabilities have been read: it cannot be pressed and says nothing. */
const UNKNOWN: RemoteControlSwitch = {
  visible: false,
  on: false,
  disabled: true,
  note: null,
  url: null,
  set: () => undefined,
  confirmOn: false,
};

/** Settings > Connections, where Codex's Remote Control has its devices. */
const openConnections = () => navigate({ name: 'settings', section: 'connections' });

export function useRemoteControlRow(threadId: string): RemoteControlSwitch {
  const rc = useSession(threadId).remoteControl;
  const hasRun = useStore((s) => (s.runtime[threadId]?.turns.length ?? 0) > 0);
  const caps = useChatCaps(threadId);
  // capabilities read again on every session patch (useChatCaps answers "not loaded" meanwhile): the last answer for this chat stands until the next one
  const known = useRef<{ chat: string; kind: string; why: Parameters<typeof whyText>[0] | undefined } | null>(null);
  if (caps.loaded) known.current = { chat: threadId, kind: caps.kind, why: caps.caps.remoteControl.why };
  const mine = known.current?.chat === threadId ? known.current : null;
  const computerWide = !!mine && remoteControlScope(mine.kind as HarnessKind) === 'computer';
  const computer = useCodexRemoteControl(computerWide);
  if (!mine) return UNKNOWN;
  const why = mine.why ? whyText(mine.why, { semantic: 'remoteControl' }) : null;
  const visible = mine.why?.code !== 'harness.noRemoteControl';
  if (computerWide)
    return { ...codexRemoteControlRow(computer, why), visible, set: setCodexRemoteControl, confirmOn: true, manage: openConnections };
  return { ...remoteControlRow(rc, why, hasRun), visible, set: (on) => setRemoteControl(threadId, on), confirmOn: false };
}
