// New session while the Mac is away (#4603): offered when the phone follows machine chats itself and reaches a machine whose Host has an agent ready; it opens that machine's New chat, or the list of machines when more than one is reachable.
import type { MobileRuntime } from '../contracts';
import { useDirect } from './useDirect';

export function useAwayNewChat(
  runtime: MobileRuntime,
  away: boolean,
  openNewChat: (machineId: string) => void,
  openMachines: () => void,
): (() => void) | undefined {
  const direct = useDirect(runtime);
  if (!away || !direct || runtime.direct?.chat?.enabled() !== true) return undefined;
  const { facts } = direct;
  const reachable = facts.records.filter(
    (r) => facts.reachable(r.machineId) === true && facts.agents(r.machineId)?.some((a) => a.state === 'ready'),
  );
  if (!reachable.length) return undefined;
  return reachable.length === 1 ? () => openNewChat(reachable[0].machineId) : openMachines;
}
