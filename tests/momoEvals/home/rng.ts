// Deterministic pseudo-random numbers for the MoMo home fault evals: a seed always replays the same schedule.
/** mulberry32: a tiny seeded generator; returns floats in [0, 1). @param seed any 32-bit integer */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Pick one element with the seeded generator. */
export const pick = <T>(rand: () => number, items: readonly T[]): T => items[Math.floor(rand() * items.length)];
