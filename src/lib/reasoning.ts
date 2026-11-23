// Which reasoning ("thinking") items a thread shows, per Settings → Show reasoning.

/** The text of a reasoning item: Codex summaries, else the raw reasoning (Claude thinking arrives as a summary). */
export function reasoningText(item: unknown): string {
  const it = item as { summary?: string[] | null; content?: unknown[] | null } | null | undefined;
  const sum = (it?.summary ?? []).filter(Boolean).join('\n\n');
  if (sum.trim()) return sum;
  return (it?.content ?? [])
    .map((c) => (typeof c === 'string' ? c : ((c as { text?: string } | null)?.text ?? '')))
    .filter(Boolean)
    .join('\n\n');
}

/** Steps that get a row: reasoning only when it is shown and has text; never the unknown 'other' kind. */
export function visibleSteps<S extends { kind: string; item: unknown }>(steps: S[], showReasoning: boolean): S[] {
  return steps.filter((s) => (s.kind === 'reasoning' ? showReasoning && !!reasoningText(s.item).trim() : s.kind !== 'other'));
}
