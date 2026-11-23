// Types for shared/approvalRequest.mjs: an approval main holds as the request its card is built from.

export function approvalRequest(
  a: { method: string; params?: unknown },
  threadId: string | null,
  cwd: string | null,
): { method: string; params: Record<string, unknown> };
