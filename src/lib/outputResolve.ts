// Finds a chat's generated output where it is: this Mac's disk for a local chat, the machine's Host file read for a chat on a machine; both open the same file tab.
import { hostOfChatNow } from './hostChats';
import { native } from './native';
import { remoteCwd, remotePathOf } from './remotePaths';

/** The file tab's path and folder for an output that exists, null when it is gone (or `~`, which a machine's home cannot be said as). */
export type OutputTarget = { path: string; cwd: string };

/** Whether the chat's place is known: a read of a file there must wait until it is, and never fall back to this Mac. */
export const outputPlaceKnown = (chat: string) => hostOfChatNow(chat) !== null;

export async function resolveOutput(chat: string, path: string, cwd: string): Promise<OutputTarget | null> {
  const machine = hostOfChatNow(chat);
  if (machine) {
    const there = remotePathOf(path, cwd);
    if (!there) return null;
    // one byte is enough to know the file is there; the pane reads the text itself
    const reply = await native.host.fsRead(machine, { path: there, limit: 1 });
    return reply.error ? null : { path: there, cwd: remoteCwd(machine, cwd) };
  }
  const found = await native.fs.messagePath(path, cwd);
  return found?.kind === 'file' ? { path: found.path, cwd } : null;
}
