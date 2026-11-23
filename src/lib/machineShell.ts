// The shell of a chat on a machine (audit turn:T63): `ssh` into the chat's folder there, in a terminal tab like any other shell; a machine with no ssh from this Mac has none, and says so.
import { isWin } from './platform';
import { sshTarget } from '../../shared/host/sshDestination.mjs';

/** The terminal tab of a shell on a machine (the panel's Tab, which this lower layer may not import). */
export type MachineShellTab = { id: string; cwd: string; title: string; where: string; command: string[] };

/** A chat's machine and the folder the chat works in on it. */
export type ShellMachine = { id: string; name: string; folder: string };

/** The chat's machine with the folder the chat works in there; null for a chat on this Mac. */
export const shellMachineOf = (machine: { id: string; name: string } | null, folder: string | undefined): ShellMachine | null =>
  machine ? { id: machine.id, name: machine.name, folder: folder ?? '' } : null;

/**
 * The machine the bottom terminal opens a shell on: the focused chat's machine with its folder; with no chat open (the new-chat screen), the machine and folder the draft picked (the composer's machine chip), the folder '' while none is picked there; else null (this Mac).
 * @param focused whether a chat is focused
 */
export const terminalMachineOf = (
  focused: boolean,
  chat: { id: string; name: string } | null,
  chatFolder: string | undefined,
  draft: { id: string; name: string; path: string } | null,
): ShellMachine | null => (focused ? shellMachineOf(chat, chatFolder) : draft ? shellMachineOf(draft, draft.path) : null);

/** The ssh target of a machine added over ssh (`ssh:<target>`); null for one that is reached another way (added by command, a cloud machine). */
export const sshTargetOf = (machineId: string): string | null => (machineId.startsWith('ssh:') ? machineId.slice(4) : null);

/** One word for the shell: single quotes, the quote itself closed and escaped. */
const quoted = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The words after the target: change into the chat's folder, then stay in the person's own login shell there. The remote shell expands `$SHELL`, not this Mac. */
export const remoteShellCommand = (folder: string) => (folder ? `cd ${quoted(folder)} && exec "$SHELL" -l` : 'exec "$SHELL" -l');

/** Where a tab of this shell runs, so a chat on the same machine and folder finds its tab again. */
export const shellWhere = (m: ShellMachine) => `${m.id}\n${m.folder}`;

/** A new terminal tab on the chat's machine, titled with its name, or null when this Mac has no ssh to it. `home` is where the local ssh starts. */
export function machineShellTab(m: ShellMachine, home: string, win = isWin): MachineShellTab | null {
  const target = sshTargetOf(m.id);
  if (!target) return null;
  return {
    id: `term-${crypto.randomUUID()}`,
    cwd: home,
    title: m.name,
    where: shellWhere(m),
    // a machine added as host:2222 is `-p 2222 host`, never the host name "host:2222"
    command: [win ? 'ssh.exe' : '/usr/bin/ssh', '-t', ...sshTarget(target).args, sshTarget(target).target, remoteShellCommand(m.folder)],
  };
}
