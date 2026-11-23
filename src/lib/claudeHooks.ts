// The hooks in a Claude settings.json, for the read-only list in Settings → Claude Code → Extensions.

export interface ClaudeHook {
  event: string;
  matcher: string | null;
  type: string;
  /** the command, URL or prompt the hook runs */
  run: string;
}

/** Flatten `hooks: { Event: [{ matcher, hooks: [{ type, command }] }] }`. Anything else is ignored. */
export function claudeHooksFrom(settings: unknown): ClaudeHook[] {
  const hooks = (settings as { hooks?: unknown } | null)?.hooks;
  if (!hooks || typeof hooks !== 'object') return [];
  const out: ClaudeHook[] = [];
  for (const [event, groups] of Object.entries(hooks as Record<string, unknown>)) {
    if (!Array.isArray(groups)) continue;
    for (const g of groups) {
      const list = (g as { hooks?: unknown })?.hooks;
      if (!Array.isArray(list)) continue;
      const matcher =
        typeof (g as { matcher?: unknown }).matcher === 'string' && (g as { matcher: string }).matcher
          ? (g as { matcher: string }).matcher
          : null;
      for (const h of list) {
        const x = h as { type?: unknown; command?: unknown; url?: unknown; prompt?: unknown };
        const type = typeof x.type === 'string' ? x.type : 'command';
        const run = [x.command, x.url, x.prompt].find((v) => typeof v === 'string') as string | undefined;
        out.push({ event, matcher, type, run: run ?? '' });
      }
    }
  }
  return out;
}

/** Parse a settings.json body; null when it isn't JSON. */
export function parseClaudeHooks(text: string | null | undefined): ClaudeHook[] | null {
  if (!text?.trim()) return [];
  try {
    return claudeHooksFrom(JSON.parse(text));
  } catch {
    return null;
  }
}
