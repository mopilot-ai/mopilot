// The phone v2 flag as the support pages read it: bound once by the entry, false until then, so no screen or test reaches the keychain.
let flag: () => boolean = () => false;

/** The entry binds `phoneUi() === 'v2'` once. */
export const bindSupportFlag = (read: () => boolean): void => {
  flag = read;
};

/** Whether this launch draws the rebuilt support pages. */
export const supportV2 = (): boolean => flag();
