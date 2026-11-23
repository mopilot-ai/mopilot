// The machines a screen names a Host chat's machine by: the Mac's live list, else the last one it sent for this pair, since the Mac sends none while it is away (which is when a Host chat says where it runs).
import { useMacLink, useMachines } from '../macLink';
import type { Machine } from './machines';

/** The last list each paired Mac sent, by pair: kept in memory only, and forgotten with the account. */
const kept = new Map<string, Machine[]>();

/** The live machines, else the last list this pair's Mac sent (null when it never sent one, or for another pair). */
export function useKnownMachines(): Machine[] | null {
  const machines = useMachines();
  const { pairId } = useMacLink();
  if (!pairId) return machines;
  if (machines) kept.set(pairId, machines);
  return machines ?? kept.get(pairId) ?? null;
}

/** Forgets every pair's list: an account leaving the phone takes its machines with it. */
export const forgetMachines = () => kept.clear();
