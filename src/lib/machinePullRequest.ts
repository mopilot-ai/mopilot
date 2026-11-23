// Where the PR reader finds the branch of a chat's folder on a machine: its Host's git.status (branch and a sanitized `origin`), read at most once in a while per folder, never per row. This Mac's own `gh` then looks the PR up by repository and branch.
import { ignoring } from './ignored';
import { machineFolderOf } from './machineFolder';
import { native } from './native';

/** What a folder's repository on a machine says of its checkout: the branch and the repository `gh` takes (`github.com/<owner>/<repo>`). */
export type MachineBranch = { branch: string; repo: string };

/** How long a Host's answer stands: the rows of a list and the menu opened on them share one read (a switched branch shows within it). */
export const MACHINE_BRANCH_TTL = 30_000;

/** The repository `gh --repo` takes (`<host>/<owner>/<repo>`) from the address a Host sent for its `origin` (https, ssh or scp form); null for any other address, and for one that names no owner and repository. */
export function repoOfRemote(remote: string | null | undefined): string | null {
  if (!remote) return null;
  const scp = /^[\w.-]+@([\w.-]+):(.+)$/.exec(remote);
  let host: string;
  let path: string;
  if (scp) [, host, path] = scp;
  else {
    let url: URL;
    try {
      url = new URL(remote);
    } catch {
      return null;
    }
    if (!['https:', 'http:', 'ssh:'].includes(url.protocol) || !url.hostname) return null;
    host = url.hostname;
    path = url.pathname;
  }
  const parts = path
    .replace(/^\/+|\/+$/g, '')
    .replace(/\.git$/, '')
    .split('/');
  return parts.length === 2 && parts.every(Boolean) ? `${host.toLowerCase()}/${parts.join('/')}` : null;
}

const reads = new Map<string, { at: number; read: Promise<MachineBranch | null | undefined> }>();

/** Forgets every answer (tests). */
export const resetMachineBranches = () => reads.clear();

/** The branch and repository of the folder a machine key names; null for a folder with neither, and for one that cannot be read now (offline, an older Host, a refusal), which is not remembered. `now` is the clock (tests). */
export function machineBranch(key: string, now = Date.now): Promise<MachineBranch | null> {
  const folder = machineFolderOf(key);
  if (!folder) return Promise.resolve(null);
  const kept = reads.get(key);
  if (kept && now() - kept.at < MACHINE_BRANCH_TTL) return kept.read.then((answer) => answer ?? null);
  const entry = { at: now(), read: ask(folder.machineId, folder.path) };
  reads.set(key, entry);
  return entry.read.then((answer) => {
    // a read that could not answer says nothing about the folder: the next one asks again
    if (answer === undefined && reads.get(key) === entry) reads.delete(key);
    return answer ?? null;
  });
}

/** One read of the machine's git.status; undefined when it could not answer (never rejects). */
async function ask(machineId: string, path: string): Promise<MachineBranch | null | undefined> {
  try {
    const reply = await native.host.gitStatus(machineId, { path });
    if (reply.error) return undefined;
    const status = reply.value;
    const repo = status.isRepo ? repoOfRemote(status.remote) : null;
    return status.isRepo && status.branch && repo ? { branch: status.branch, repo } : null;
  } catch (error) {
    ignoring("read a machine's branch for a chat's pull request")(error);
    return undefined;
  }
}
