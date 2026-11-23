// Whether git can sign in on a machine, shown as one short line: on the machine's row (read once per online machine, never polled) and in a Host chat whose agent's git failed for a missing sign-in (the Host's own line in a tool result, host/src/gitSignIn.mjs).
import { useEffect, useRef, useState } from 'react';
import { ignoring } from './ignored';
import { native } from './native';
import { useHostSignins } from './hostSignin';
import { GIT_LOGIN } from '../../shared/host/gitLogin.mjs';
import { toolOutput } from './toolOutput';
import type { HostMachineRow } from './hostMachines';
export { GIT_HOST } from '../../shared/host/gitLogin.mjs';

/** The repository host the machine row asks about (the same list main reads, electron/host/gitSignInRead.cjs). */
import { GIT_HOST } from '../../shared/host/gitLogin.mjs';
export type GitSignIn = 'yes' | 'no' | 'unknown';

/** What the hover says to do: the fix is on the machine; "Use this Mac's sign-in" lends a credential to one clone only, so a pull or push has nothing to borrow. */
export const GIT_SIGNIN_HINT = 'Sign in on that machine, for example with gh auth login.';

/** The row's line for a machine whose git has no sign-in. */
export const gitSignInRowNote = (host: string) => `Git isn’t signed in to ${host}`;

/** The chat's line. */
export const gitSignInChatNote = (host: string, machine: string) => `Git isn’t signed in to ${host} on ${machine}`;

// the whole line with its address: text that only talks about the line (the Host's own source, a doc) names no address
const MARKER = /MoPilot: git has no sign-in on this machine for https?:\/\/([A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?(?::\d{1,5})?)/;

/** The repository host the Host's "git has no sign-in" line names in a turn's tool results, or null when no result carries the line. */
export function gitSignInHostIn(items: readonly unknown[]): string | null {
  for (const item of items) {
    const said = (item as { aggregatedOutput?: unknown } | null)?.aggregatedOutput;
    const m = MARKER.exec(`${typeof said === 'string' ? said : ''}\n${toolOutput(item).text}`);
    if (m) return m[1];
    // gh's own signed-out diagnostic has no URL. Other failures (permissions, transport, SSH keys) do not imply this sign-in.
    if (/To get started with GitHub CLI, please run:\s+gh auth login/.test(toolOutput(item).text + (typeof said === 'string' ? said : '')))
      return GIT_HOST;
  }
  return null;
}

/**
 * Git's sign-in for each machine that is online, read from its Host once when the machine is listed online (and again when it comes back), never on a timer.
 * A machine that cannot say, or an older Host, is 'unknown' (nothing shown).
 */
export function useGitSignIn(machines: readonly HostMachineRow[]): ReadonlyMap<string, GitSignIn> {
  const signins = useHostSignins();
  const [seen, setSeen] = useState<ReadonlyMap<string, GitSignIn>>(new Map());
  // the read each machine's answer must belong to: one that is asked again, or whose machine went away, drops a late answer of the older read
  const asked = useRef(new Map<string, number>());
  const reads = useRef(0);
  const verified = useRef(new Map<string, string | undefined>());
  const credentials = JSON.stringify(
    [...signins.values()]
      .filter((v) => v.harness === GIT_LOGIN && v.state === 'signed-in')
      .map((v) => [v.hostId, v.attemptId] as const)
      .sort(),
  );
  // a machine's id and status: a change of either (a machine coming online, or back from needing attention) is the only thing that reads again
  const online = machines
    .filter((m) => m.status !== 'offline')
    .map((m) => `${m.id}\t${m.status}`)
    .sort()
    .join('\n');
  useEffect(() => {
    const signedIn = new Map<string, string | undefined>(JSON.parse(credentials));
    const now = online ? online.split('\n').map((line) => line.split('\t')[0]) : [];
    const gone = [...asked.current.keys()].filter((id) => !now.includes(id));
    for (const id of gone) asked.current.delete(id);
    if (gone.length) setSeen((was) => new Map([...was].filter(([id]) => !gone.includes(id))));
    for (const id of now) {
      if (signedIn.has(id) && (!verified.current.has(id) || verified.current.get(id) !== signedIn.get(id))) {
        verified.current.set(id, signedIn.get(id));
        // A verified login retires the cached row answer and any read that began before credential installation.
        asked.current.delete(id);
      }
      if (asked.current.has(id)) continue;
      const read = ++reads.current;
      asked.current.set(id, read);
      native.host
        .gitSignIn(id)
        .then((r) => {
          if (asked.current.get(id) !== read) return;
          const state = r?.[GIT_HOST] ?? 'unknown';
          // a machine that could not say is asked again when it next changes, not kept as an answer
          if (state === 'unknown') asked.current.delete(id);
          else setSeen((was) => new Map(was).set(id, state));
        })
        .catch(ignoring('read a machine’s git sign-in'));
    }
  }, [online, credentials]);
  return seen;
}
