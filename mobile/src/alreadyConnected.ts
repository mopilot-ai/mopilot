// Whether a pairing code is for the Mac this phone is connected to right now: pairing it again would drop a working connection to replace it, so the sheet says so instead.
import type { MobilePair, MobileSnapshot } from './contracts';

/** The code's Mac id, read without checking the rest: pairing itself checks the code and says what is wrong with it. */
function macIdOf(code: string): string | null {
  try {
    const value: unknown = JSON.parse(code);
    const macId = value && typeof value === 'object' ? (value as { macId?: unknown }).macId : null;
    return typeof macId === 'string' ? macId : null;
  } catch {
    return null;
  }
}

/** The connected pair the code is for, or null: a paired Mac that is away may be paired again (that is how a broken pairing is mended). */
export function connectedPairFor(
  code: string,
  state: Pick<MobileSnapshot, 'phase' | 'pairs' | 'selectedPair'> | undefined,
): MobilePair | null {
  const macId = macIdOf(code.trim());
  if (!macId || state?.phase !== 'online') return null;
  return state.pairs.find((pair) => pair.pairId === state.selectedPair && pair.macId === macId) ?? null;
}
