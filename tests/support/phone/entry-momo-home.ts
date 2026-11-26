// Observable MoMo home cache opener for the production entry test: counts opens and fails on demand.
export async function openMomoHomeCache() {
  const w = globalThis as any;
  w.__momoHomeOpens = (w.__momoHomeOpens ?? 0) + 1;
  if (w.__momoHomeOpenFails) throw new Error('storage unavailable');
  return { forget: async () => undefined, clear: async () => undefined };
}
export const momoHomeWasUsed = async () => !!(globalThis as any).__momoHomeUsed;
export const markMomoHomeUsed = async () => void ((globalThis as any).__momoHomeUsed = true);
