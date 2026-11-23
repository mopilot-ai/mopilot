// The folder a New chat last used on each machine, by pair and machine: offered again the next time that machine is picked, kept in memory only and forgotten with the account.
const kept = new Map<string, string>();
const key = (pairId: string | null, host: string) => `${pairId ?? ''}\u0000${host}`;

export const lastFolder = (pairId: string | null, host: string): string | null => kept.get(key(pairId, host)) ?? null;
export const rememberFolder = (pairId: string | null, host: string, folder: string) => void kept.set(key(pairId, host), folder);
/** An account leaving the phone takes its folders with it. */
export const forgetFolders = () => kept.clear();
