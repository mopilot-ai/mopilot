// Which home the phone reads: the Mac's, whenever a Mac answers, and its own only when none does (the Mac is asleep, off or out of reach), for an account a Mac last said may see MoMo, with at least one Host of its own to look at. Nothing else changes: the screens read the same view either way.

export type Source = {
  /** What the Mac's hello says of this account: true or false once it answered, null while it has not (or cannot). */
  macAllowed: boolean | null;
  /** The Mac was asked and gave no answer in its time, or the phone is away from it. */
  macSilent: boolean;
  /** A Mac once said this account may see MoMo (kept sealed on the phone). */
  invited: boolean;
  /** How many Hosts the phone holds an enrollment with. */
  hosts: number;
};

export const phoneHomeNow = (s: Source): boolean => s.macAllowed === null && s.macSilent && s.invited && s.hosts > 0;
