// A folder on a machine named so it never reads as a folder of this Mac, and the words a control that stays here says for it.

const SEP = '\0';

/** The key of a folder: its plain path on this Mac (no machine id), else the machine's id and the path, so one path on two machines (or on this Mac) is three folders. */
export const machineFolderKey = (machineId: string, path: string): string => (machineId ? `${machineId}${SEP}${path}` : path);

/** The machine and the path a key from `machineFolderKey` names; null for a plain path of this Mac. A machine id never holds the separator, so the first one splits. */
export function machineFolderOf(key: string): { machineId: string; path: string } | null {
  const at = key.indexOf(SEP);
  return at > 0 ? { machineId: key.slice(0, at), path: key.slice(at + 1) } : null;
}

/** The short reason a control that opens a folder here is greyed for a folder on a machine. */
export const onMachineHint = (machineName: string): string => `On ${machineName}`;

/** The longer reason, for a tooltip. */
export const folderOnMachine = (machineName: string): string => `This folder is on ${machineName}, not on this Mac`;
