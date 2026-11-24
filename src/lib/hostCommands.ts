// Catalog requests for a machine's slash menu and draft, cached per machine, agent, folder and chat scope.
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

/** A draft can request the catalog before the menu opens. Opening the menu can refresh that answer. */
export type CatalogRequest = boolean | 'draft';

const kept = new Map<string, { at: number; answer: CommandsAnswer }>();
const inflight = new Map<string, Promise<CommandsAnswer>>();
type CommandListener = (answer: CommandsAnswer | undefined) => void;
const listeners = new Map<string, Set<CommandListener>>();
const publish = (key: string, answer: CommandsAnswer | undefined) => {
  listeners.get(key)?.forEach((receive) => receive(answer));
};
const freshCommands = (key: string, now = Date.now()) => {
  const have = kept.get(key);
  return have && now - have.at < COMMANDS_FRESH_MS ? have.answer : undefined;
};

/** For tests: forget every answer. */
export const resetHostCommands = () => (kept.clear(), inflight.clear());

/** The agent's list on the machine for the folder: the kept answer while it is fresh, else one request shared by whoever asks meanwhile. `scope` is the chat asking (none: the new chat): a chat's own list is asked for again, since its agent may have learned more by running (terminal-only commands, skills) after the new chat's list was kept. */
export function askHostCommands(machineId: string, harness: string, folder: string, scope = '', now = Date.now()): Promise<CommandsAnswer> {
  const key = `${machineId}\n${harness}\n${folder}\n${scope}`;
  const have = freshCommands(key, now);
  if (have) {
    publish(key, have);
    return Promise.resolve(have);
  }
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
      publish(key, answer);
      return answer;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, asked);
  publish(key, undefined);
  return asked;
}

/**
 * The commands of `harness` (`claude`, `codex`, `acp:<agent>`) in `folder` on `machineId`; null when there is no machine or agent to ask, `loading` until the machine answers. The composer requests them when its slash menu opens or its draft needs command presentation.
 */
export function useHostCommands(
  machineId: string | null,
  harness: string | null,
  folder: string,
  want: CatalogRequest,
  scope = '',
): CommandsAnswer | { state: 'loading' } | null {
  const key = machineId && harness ? `${machineId}\n${harness}\n${folder}\n${scope}` : null;
  const [saved, setSaved] = useState(() => ({ key, want, answer: key && want ? freshCommands(key) : undefined }));
  let current = saved;
  if (saved.key !== key || saved.want !== want) {
    // An opening menu can only offer a cached list that is still fresh.
    const answer = key && want ? freshCommands(key) : saved.key === key ? saved.answer : undefined;
    current = { key, want, answer };
    setSaved(current);
  }
  useEffect(() => {
    if (!key || !machineId || !harness || !want) return;
    const receive: CommandListener = (answer) => setSaved({ key, want, answer });
    const active = listeners.get(key) ?? new Set<CommandListener>();
    active.add(receive);
    listeners.set(key, active);
    void askHostCommands(machineId, harness, folder, scope);
    return () => {
      active.delete(receive);
      if (!active.size) listeners.delete(key);
    };
  }, [key, machineId, harness, folder, want, scope]);
  if (!key) return null;
  return current.answer ?? { state: 'loading' };
}
