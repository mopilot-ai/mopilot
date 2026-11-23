// Codex collaboration events that create parent-child thread relations, shared by native routing and agent views.
export function isCodexAgentSpawn(item: unknown): boolean;
export function isCodexChildThreadId(id: unknown, parent: unknown): boolean;
export function canLinkCodexChild(child: unknown, parent: unknown, parents: ReadonlyMap<string, string>): boolean;
