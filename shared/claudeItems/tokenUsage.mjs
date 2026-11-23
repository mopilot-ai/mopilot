// A Claude Code `result` message's token usage as the thread's: the last request, the running total and the context window.

export function tokenUsage(m, prev) {
  const u = m.usage ?? {};
  const it = (u.iterations ?? []).slice(-1)[0] ?? u;
  const ctx =
    Object.values(m.modelUsage ?? {})
      .map((x) => x?.contextWindow)
      .find(Boolean) ?? null;
  const last = {
    inputTokens: (it.input_tokens ?? 0) + (it.cache_read_input_tokens ?? 0) + (it.cache_creation_input_tokens ?? 0),
    cachedInputTokens: it.cache_read_input_tokens ?? 0,
    cacheWriteInputTokens: it.cache_creation_input_tokens ?? 0,
    outputTokens: it.output_tokens ?? 0,
    reasoningOutputTokens: u.output_tokens_details?.thinking_tokens ?? 0,
    totalTokens: 0,
  };
  last.totalTokens = last.inputTokens + last.outputTokens;
  const p = prev?.total;
  const total = p ? Object.fromEntries(Object.entries(last).map(([k, v]) => [k, p[k] + v])) : { ...last };
  return { total, last, modelContextWindow: ctx };
}
