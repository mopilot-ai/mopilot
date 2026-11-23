// How the phone reaches each machine (X3): its own enrollment with the Host (Direct), the Mac's path (Through <Mac>), or neither. A client is a view: the reach is derived from what is enrolled and what the Mac lists, never remembered.
import { reachWord } from '../../../shared/host/directWords.mjs';

export type Reach = 'direct' | 'through' | 'none';
/** Where setting up direct access stands for one machine. */
export type DirectSetup = 'idle' | 'working' | 'failed' | 'update';

/** Direct when the phone holds an enrollment; else Through the Mac while the Mac lists the machine and its link is up; else neither. */
export function reachOf(o: { enrolled: boolean; listedByMac: boolean; macOnline: boolean }): Reach {
  if (o.enrolled) return 'direct';
  return o.listedByMac && o.macOnline ? 'through' : 'none';
}

/** The word beside a machine, or null for none. */
export const reachLabel = (reach: Reach, macName: string, down = false): string | null => reachWord(reach, macName, down);

/**
 * Whether the page may offer "Use without your Mac": the phone has no enrollment, the Mac lists the machine online (it must be there once), and nothing is under way.
 */
export const canSetUpDirect = (o: { reach: Reach; setup: DirectSetup }) => o.reach === 'through' && o.setup !== 'working';

/** The machine's own line: the Host's when the path is direct and it has answered, else the one the Mac gave. */
export const lineFor = (o: { reach: Reach; macLine: string; hostLine: string | null }) =>
  o.reach === 'direct' && o.hostLine ? o.hostLine : o.macLine;
