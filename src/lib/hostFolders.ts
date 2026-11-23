// What the window needs to browse, clone and make worktrees on a remote machine (package 2.7): the short notice for each refusal, a clone's default folder, POSIX joins for the machine's paths, and one key per attempt.
import { errorText } from './ignored';
import { native } from './native';
import type { HostListing, HostPlace, HostReply } from './native/host';

/** The Host's refusals, as the one line the picker shows; any other failure shows its own message. */
const NOTICES: Record<string, string> = {
  outside_roots: 'That folder is outside what this machine shares.',
  directory_missing: 'That folder is not on this machine.',
  not_a_directory: 'That is not a folder.',
  invalid_path: 'Pick a folder by its full path.',
  worktree_failed: 'The worktree could not be made.',
  request_interrupted: 'The machine restarted during that. Try again.',
  unknown_machine: 'That machine is not in your list.',
  not_allowed: 'Host is not available.',
  no_mac_signin: 'This Mac has no sign-in for that address.',
  not_a_file: 'That is not a file.',
  read_timed_out: 'The machine took too long to read that folder.',
  write_timed_out: 'The machine took too long to change that folder.',
  not_a_repository: 'This folder is not a git repository.',
  host_outdated: 'Update the Host on that machine.',
  hello_required: 'The connection to that machine was not ready. Try again.',
};

const SIGN_IN_FAILED =
  /could not read (Username|Password)|Authentication failed|Permission denied \(publickey|Host key verification|Repository not found|could not read from remote|error: 40[13]/i;

/** The host of an https address, or '' for any other (only https can borrow this Mac's sign-in). */
export function httpsHostOf(url: string): string {
  try {
    const u = new URL(url.trim());
    return u.protocol === 'https:' ? u.host : '';
  } catch {
    return '';
  }
}

/** Whether a failed clone was the machine being unable to sign in, so this Mac's sign-in may be offered. */
export function cloneNeedsSignIn(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'clone_failed' && SIGN_IN_FAILED.test(errorText(error));
}

/** Why a clone failed, from the last line git printed on the machine: the cause in words, else that line. */
function cloneNotice(said: string): string {
  if (SIGN_IN_FAILED.test(said)) return 'This machine can’t sign in to that repository.';
  if (/Could not resolve host|Failed to connect|Connection (timed out|refused)|SSL/i.test(said))
    return 'This machine can’t reach that address.';
  if (/No space left|Disk quota/i.test(said)) return 'This machine is out of disk space.';
  return said.replace(/^(fatal|error):\s*/i, '') || 'The clone failed.';
}

/** The notice for a failed Host request: a known refusal by its code, else the error's own sentence. */
export function folderNotice(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 'clone_failed') return cloneNotice(errorText(error));
  if (code === 'feature_missing' && /cloneCredential/.test(errorText(error)))
    return 'Update Host on that machine to use this Mac’s sign-in.';
  return (typeof code === 'string' && NOTICES[code]) || errorText(error);
}

/** The folder a repository address clones into by default: its last segment without `.git` (`git@host:org/app.git` → `app`); '' when there is none. */
export function repoFolderName(url: string): string {
  const parts = url
    .trim()
    .replace(/[/\\]+$/, '')
    .split(/[/:]/);
  return parts[parts.length - 1].replace(/\.git$/, '');
}

/** `name` inside `dir` on the machine (its paths are POSIX). */
export const joinRemote = (dir: string, name: string) => `${dir.replace(/\/+$/, '')}/${name}`;

/** The folder above `dir`, or null at the filesystem root. */
export function parentRemote(dir: string): string | null {
  const trimmed = dir.replace(/\/+$/, '');
  if (!trimmed) return null;
  const cut = trimmed.lastIndexOf('/');
  return cut <= 0 ? '/' : trimmed.slice(0, cut);
}

/** A key for one clone or worktree attempt: the Host runs a key once, so a new attempt needs a new one. */
export const attemptKey = () => `app:${crypto.randomUUID()}`;

/** A folder call's answer as a value, or an Error that carries the refusal's `code` (folderNotice reads it). */
export async function unwrap<T>(reply: Promise<HostReply<T>>): Promise<T> {
  const r = await reply;
  if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code });
  return r.value;
}

/** Browse, clone and make worktrees on a remote machine (main: electron/host/folders.cjs). */
export const hostFolders = {
  list: (hostId: string, q: { path?: string }): Promise<HostListing> => unwrap(native.host.fsList(hostId, q)),
  clone: (hostId: string, q: { key: string; url: string; dest: string; useMacSignIn?: boolean }): Promise<HostPlace> =>
    unwrap(native.host.clone(hostId, q)),
  worktree: (hostId: string, q: { key: string; repo: string; branch: string; from?: string }): Promise<HostPlace> =>
    unwrap(native.host.worktree(hostId, q)),
};
