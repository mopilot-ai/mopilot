// The approval cards of a chat, built from main's SessionState `approvals` (electron/session/controller.cjs),
// so every window shows the same cards, including one opened after the request came in (A15).
import type { PendingRequest } from '../../shared/model/store';
import { approvalRequest } from '../../shared/approvalRequest.mjs';
import type { AcpPermissionOption, AcpToolCall, RequestBody } from '../../shared/model/requests';

export type { ClaudeMeta } from './requestParams';
import type { SessionApproval } from '../../shared/model/requests';
export type { SessionApproval } from '../../shared/model/requests';

/** A request's params as main holds them; the fields read here are named, the rest pass through. */
export type ApprovalParams = {
  toolName?: string;
  input?: {
    command?: string;
    questions?: { header?: string | null; question: string; options?: { label: string; description?: string }[]; multiSelect?: boolean }[];
  } & Record<string, unknown>;
  suggestions?: unknown[] | null;
  toolUseID?: string | null;
  description?: string | null;
  decisionReason?: string | null;
  blockedPath?: string | null;
  title?: string | null;
  toolCall?: AcpToolCall | null;
  options?: AcpPermissionOption[];
  claude?: unknown;
  serverName?: string;
  message?: string;
  mode?: string;
  url?: string | null;
  requestedSchema?: unknown;
} & Record<string, unknown>;

/** Sage's own cards (computer use, browser sites) have their own component. */
export const isSageApproval = (a: SessionApproval) => String(a.method).startsWith('sage/');

/** One approval as the card list shows it, in the shape each harness's card was always built from (shared/approvalRequest.mjs). */
export function toRequest(chatId: string, a: SessionApproval, cwd: string | null, receivedAt: number): PendingRequest | null {
  if (isSageApproval(a)) return null;
  // its method names its params' protocol type (requestParams.d.ts); main's SessionState holds it untyped, so this is
  // where it is typed
  const body = approvalRequest(a, chatId, cwd) as RequestBody;
  return { id: a.id, ...body, threadId: chatId, receivedAt, ...(a.sourceHarness !== undefined ? { sourceHarness: a.sourceHarness } : {}) };
}

/** The cards for a chat's approvals, keeping the receive time of the ones already shown. */
export function requestsOf(
  chatId: string,
  approvals: SessionApproval[],
  cwd: string | null,
  known: PendingRequest[],
  now: number,
): PendingRequest[] {
  const seen = new Map(known.map((r) => [r.id, r.receivedAt]));
  return approvals.flatMap((a) => toRequest(chatId, a, cwd, seen.get(a.id) ?? now) ?? []);
}
