// A wait with an end: a native call that never settles (the keychain of a fresh iOS 27.0 simulator, #3644) fails after a bound instead of leaving the screen loading forever.

/** How long a keychain read or write may take before it counts as failed; a healthy one answers in milliseconds. */
export const KEYCHAIN_WAIT_MS = 15_000;
export const KEYCHAIN_SILENT = "This phone's secure storage did not answer. Try again; if it keeps happening, restart the phone.";

/** `work`, or a rejection with `message` once `ms` passed first; the timer is cleared whichever settles. */
export function bounded<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/** A keychain call with the keychain's bound and words. */
export const keychain = <T>(work: Promise<T>) => bounded(work, KEYCHAIN_WAIT_MS, KEYCHAIN_SILENT);
