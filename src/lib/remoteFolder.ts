// The React side of a chat's folder on a machine: the context that tells the chat's links which machine they open files on; the path helpers live in remotePaths.ts.
import { createContext, useContext } from 'react';
import { remoteCwd } from './remotePaths';

export { parseRemoteCwd, remoteCwd, remotePathOf } from './remotePaths';

/** Set where a chat on a machine is drawn (the thread view, the plan pane): its links read it to open files on the machine. */
export const RemoteFolderContext = createContext<{ machineId: string; folder: string } | null>(null);

/** The folder a link resolves against: the chat's own `cwd` on this Mac, a `remoteCwd` where the chat is on a machine. */
export function useLinkCwd<T extends string | null | undefined>(cwd: T): T | string {
  const remote = useContext(RemoteFolderContext);
  return remote ? remoteCwd(remote.machineId, remote.folder) : cwd;
}
