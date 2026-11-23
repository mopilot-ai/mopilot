// The dev switch for the fixture seam (localStorage 'momo.homeUi'): explicit, off unless it names 'ipc' (the home main serves), '1' or a fixture scenario, and honored only in a dev run (homeSeam.ts asks main). "0", "false" and an empty value are off.
const KEY = 'momo.homeUi';
const OFF = new Set(['', '0', 'false', 'off']);

/** The switch's value, or null when it is not set or says off. */
export function momoHomeScenario(): string | null {
  try {
    const v = globalThis.localStorage?.getItem(KEY)?.trim() ?? '';
    return OFF.has(v.toLowerCase()) ? null : v;
  } catch {
    return null;
  }
}
