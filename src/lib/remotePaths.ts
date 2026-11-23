// A chat's folder when it is on a machine, in the one string the folder travels as through Markdown links, pane tabs and message paths (#4062); pure, with no React, so store code can use it.

const PREFIX = 'host:';

/** The folder `folder` on machine `machineId`, as the string passed where a chat's folder goes. */
export const remoteCwd = (machineId: string, folder: string) => `${PREFIX}${machineId}\n${folder}`;

/** The machine and the folder a `remoteCwd` names, or null for this Mac's own folder (or none). */
export function parseRemoteCwd(cwd: string | null | undefined): { machineId: string; folder: string } | null {
  if (!cwd?.startsWith(PREFIX)) return null;
  const at = cwd.indexOf('\n');
  return at < 0 ? null : { machineId: cwd.slice(PREFIX.length, at), folder: cwd.slice(at + 1) };
}

/**
 * The absolute path on the machine that a link names: an absolute path stays, a relative one is taken from the folder; `.` and `..` are resolved (the Host checks the real path against its roots anyway). Null for `~`, which means the machine's own home and cannot be said here.
 */
export function remotePathOf(path: string, folder: string): string | null {
  if (path === '~' || path.startsWith('~/')) return null;
  const segments: string[] = [];
  for (const part of (path.startsWith('/') ? path : `${folder}/${path}`).split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') segments.pop();
    else segments.push(part);
  }
  return `/${segments.join('/')}`;
}
