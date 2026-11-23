// ACP chat rows and the agent's session id, which its CLI resumes by independently of MoPilot's chat key.
import type { Thread } from '../protocol/v2/Thread';

const ids = new Map<string, string>();

/** Note the agent's session id for a chat (main's list, or a session it just opened or loaded). */
export function noteAcpSession(chatKey: string, sessionId: string | null | undefined) {
  if (sessionId) ids.set(chatKey, sessionId);
}

/** The agent's session id for a chat, or null before MoPilot has seen one. */
export const acpSessionOf = (chatKey: string): string | null => ids.get(chatKey) ?? null;

/** The renderer shows both basic harnesses and machine chats using ACP's chat rows. */
export function acpThread(o: {
  id: string;
  cwd: string;
  preview?: string;
  name?: string | null;
  createdAt: number;
  updatedAt: number;
}): Thread {
  return {
    id: o.id,
    name: o.name ?? null,
    preview: o.preview ?? '',
    cwd: o.cwd,
    createdAt: Math.floor(o.createdAt / 1000),
    updatedAt: Math.floor(o.updatedAt / 1000),
    status: { type: 'notLoaded' },
    gitInfo: null,
    projectId: null,
    parentThreadId: null,
    forkedFromId: null,
    ephemeral: false,
    turns: [],
  } as unknown as Thread;
}
