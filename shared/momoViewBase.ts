// MoMo's view contract, part 1 (re-exported from ./momoView.ts: import from there): the open-union helper and the machine reference every other part names.

/** A union that stays open: the known values, plus any string a newer sender may use. */
export type Open<T extends string> = T | (string & {});

/** Whether `v` is one of the values a client knows; the narrowing every switch over an `Open` union starts with. */
export function isKnown<T extends string>(known: readonly T[], v: string): v is T {
  return (known as readonly string[]).includes(v);
}

/** One machine, as it is shown and as it is addressed. */
export interface MomoMachineRef {
  machineId: string;
  name: string;
}
