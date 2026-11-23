// A paired computer's own name: read from its hello once connected, kept with the pair in the vault, and shown in the list.
import { cleanComputerName } from '../../shared/remote/computerName.mjs';
import type { MobilePair } from './contracts';

/** The pair as the list sees it: its ids and, once the computer has said hello, its name. */
export function pairView(pair: { pairId: string; macId: string; name?: unknown }): MobilePair {
  const name = cleanComputerName(pair.name);
  return { pairId: pair.pairId, macId: pair.macId, ...(name ? { name } : {}) };
}

/** The vault's update for a pair: the name stored, and whether it changed (an unchanged name writes nothing new to show). */
export function nameSaved<P extends { name?: string }>(pair: P, name: string): { pair: P; value: boolean } {
  return pair.name === name ? { pair, value: false } : { pair: { ...pair, name }, value: true };
}

/**
 * Reads the computer's name from its hello and keeps it. An older computer sends none and a failed read leaves the wording
 * the list already has; a name that arrives after the connection was replaced is dropped.
 */
export async function learnComputerName(o: {
  hello: () => Promise<unknown>;
  save: (name: string) => Promise<boolean>;
  current: () => boolean;
  saved: () => Promise<void>;
}) {
  const hello = await o.hello().catch(() => null);
  const name = cleanComputerName((hello as { name?: unknown } | null)?.name);
  if (!name || !o.current()) return;
  if (await o.save(name)) await o.saved();
}
