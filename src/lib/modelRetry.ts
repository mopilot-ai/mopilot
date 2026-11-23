// Clearing a turn's retry notice once fresh model output shows its interrupted stream recovered.

/** Only fresh model output for this turn proves that its interrupted stream recovered. */
export function retryAfterModelProgress(
  runtime: { retry: string | null; activeTurnId: string | null },
  method: string,
  params: { turnId?: string; item?: { type?: string } },
): string | null {
  if (!runtime.retry || !runtime.activeTurnId || runtime.activeTurnId !== params.turnId) return runtime.retry;
  const modelProgress =
    method === 'item/agentMessage/delta' ||
    method === 'item/plan/delta' ||
    method === 'item/reasoning/summaryPartAdded' ||
    method === 'item/reasoning/summaryTextDelta' ||
    method === 'item/reasoning/textDelta' ||
    (method === 'item/started' && ['agentMessage', 'reasoning', 'plan'].includes(params.item?.type ?? ''));
  return modelProgress ? null : runtime.retry;
}
