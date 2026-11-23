// Computer History test doubles (#1363): a reversible stand-in for safeStorage that never stores plain text, and manual interval timers.
export { deferred } from './async-scenarios.ts';

/** A stand-in for Electron safeStorage: reversible, and never the plain text. */
export const fakeSafe = (available = true) => ({
  isEncryptionAvailable: () => available,
  encryptString: (s: string) => Buffer.from(`enc:${Buffer.from(s).toString('hex')}`),
  decryptString: (b: Buffer) => {
    const t = b.toString();
    if (!t.startsWith('enc:')) throw new Error('bad ciphertext');
    return Buffer.from(t.slice(4), 'hex').toString();
  },
});

/** Interval timers a test fires by hand. */
export function manualTimers() {
  const live = new Map<number, () => void>();
  let next = 1;
  return {
    live,
    setInterval: ((fn: () => void) => {
      const id = next++;
      live.set(id, fn);
      return id;
    }) as unknown as typeof setInterval,
    clearInterval: ((id: number) => void live.delete(id)) as unknown as typeof clearInterval,
    /** Runs every live interval once. */
    fire() {
      for (const fn of [...live.values()]) fn();
    },
  };
}
