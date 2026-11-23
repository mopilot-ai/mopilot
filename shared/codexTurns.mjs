// A Codex turn as the thread view holds it, from the app-server's `Turn` (thread/turns/list). The
// items already have the shape the view renders; main reads them with this too (the handoff record).

export function turnFromServer(t) {
  return {
    id: t.id,
    status: t.status,
    items: t.items ?? [],
    startedAt: t.startedAt,
    completedAt: t.completedAt,
    durationMs: t.durationMs,
    error: t.error,
    diff: t.diff,
    itemTimes: {},
  };
}
