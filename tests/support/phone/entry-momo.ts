// Observable MoMo cache opener for the production entry test: counts opens and fails on demand.
export async function openMomoCache() {
  const w = globalThis as any;
  w.__momoOpens = (w.__momoOpens ?? 0) + 1;
  if (w.__momoOpenFails) throw new Error('storage unavailable');
  return { opened: w.__momoOpens };
}
