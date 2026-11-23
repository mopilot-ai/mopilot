// What an agent on a machine offers in its `/` menu (`host.commands` through the app's folder service, #4915): asked when the menu is wanted, kept for a short while per machine, agent and folder, and shared by every composer that asks the same. A failure is never kept: the next open asks again.
import { useEffect, useState } from 'react';
import { folderNotice } from './hostFolders';
import { ignoring } from './ignored';
import { native } from './native';
import type { HostCommand } from './native/host';

/** How long an answer is shown again without asking the machine. */
export const COMMANDS_FRESH_MS = 30_000;

export type CommandsAnswer =
  | { state: 'ready'; listed: boolean; commands: HostCommand[] }
  /** the machine's Host cannot list commands (it is older than the method, or has no source for it) */
  | { state: 'outdated' }
  | { state: 'unavailable'; notice: string };

const kept = new Map<string, { at: number; answer: CommandsAnswer }>();
const inflight = new Map<string, Promise<CommandsAnswer>>();

/** For tests: forget every answer. */
export const resetHostCommands = () => (kept.clear(), inflight.clear());

/** The agent's list on the machine for the folder: the kept answer while it is fresh, else one request shared by whoever asks meanwhile. `scope` is the chat asking (none: the new chat): a chat's own list is asked for again, since its agent may have learned more by running (terminal-only commands, skills) after the new chat's list was kept. */
export function askHostCommands(machineId: string, harness: string, folder: string, scope = '', now = Date.now()): Promise<CommandsAnswer> {
  const key = `${machineId}\n${harness}\n${folder}\n${scope}`;
  const have = kept.get(key);
  if (have && now - have.at < COMMANDS_FRESH_MS) return Promise.resolve(have.answer);
  const running = inflight.get(key);
  if (running !== undefined) return running;
  const asked = native.host
    .commands(machineId, { harness, ...(folder ? { cwd: folder } : {}) })
    .then(
      (r): CommandsAnswer =>
        r.error
          ? { state: 'unavailable', notice: folderNotice(r.error) }
          : r.value.outdated
            ? { state: 'outdated' }
            : { state: 'ready', listed: r.value.listed, commands: r.value.commands },
      (e): CommandsAnswer => (ignoring("list a machine's commands")(e), { state: 'unavailable', notice: 'Could not reach that machine.' }),
    )
    .then((answer) => {
      // only a list the agent gave is kept: one it could not give yet, or a failure, is asked for again
      if (answer.state === 'ready' && answer.listed) kept.set(key, { at: now, answer });
      return answer;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, asked);
  return asked;
}

/**
 * The commands of `harness` (`claude`, `codex`, `acp:<agent>`) in `folder` on `machineId`; null when there is no machine or agent to ask, `loading` until the machine answers. Nothing is asked until `want` (the menu is open), so a chat on a machine opens without a request.
 */
export function useHostCommands(
  machineId: string | null,
  harness: string | null,
  folder: string,
  want: boolean,
  scope = '',
): CommandsAnswer | { state: 'loading' } | null {
  const key = machineId && harness ? `${machineId}\n${harness}\n${folder}\n${scope}` : null;
  const [answers, setAnswers] = useState<Record<string, CommandsAnswer>>({});
  useEffect(() => {
    if (!key || !machineId || !harness || !want) return;
    let live = true;
    void askHostCommands(machineId, harness, folder, scope).then((answer) => live && setAnswers((all) => ({ ...all, [key]: answer })));
    return () => {
      live = false;
    };
  }, [key, machineId, harness, folder, want, scope]);
  if (!key) return null;
  return answers[key] ?? { state: 'loading' };
}
