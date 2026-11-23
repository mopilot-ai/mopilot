// Harness-agnostic types: what the picker, the account menu and Settings need to know about Codex and Claude Code.
import type { ServiceTier } from './tiers';
import type { HarnessId, Segment } from '../../shared/model/harness';
export type {
  BasicHarness,
  HandoffMode,
  HarnessId,
  HarnessModel,
  HarnessState,
  HarnessStatus,
  PendingSwitch,
  Segment,
  Selection,
  UsageReason,
  UsageWindow,
} from '../../shared/model/harness';
export type { ServiceTier };
export const HARNESS_IDS: HarnessId[] = ['codex', 'claude'];
import { noteOwner, ownerOf } from './ownership';
import { isLoginRefused } from '../../shared/loginRefused.mjs';
// the labels are in shared/handoff.mjs, since main writes the handoff record's wording too
export { HARNESS_LABEL, HANDOFF_LABEL } from '../../shared/handoff.mjs';

/** Claude Code reports an expired or revoked login as an assistant message; `auth status` still says "logged in". */
export const isClaudeAuthError = (msg: string | null | undefined) =>
  /Failed to authenticate|Invalid API key|OAuth (access )?token has expired|authentication_failed|Re-authenticate to continue/i.test(
    msg ?? '',
  ) || isLoginRefused(msg); // a login the provider refuses is a login that has to be redone, too

export { FAST_BLOCKED_TEXT } from '../../shared/caps.mjs';

/** Claude chats are namespaced so ids never collide and routes say who owns them. */
const CLAUDE_ID = 'claude:';
export const claudeSessionId = (threadId: string) => threadId.slice(CLAUDE_ID.length);
/** The id the renderer gives a Claude session; it is noted as Claude-owned here, where it is made. */
export const claudeThreadId = (sessionId: string) => {
  const id = CLAUDE_ID + sessionId;
  noteOwner(id, 'claude');
  return id;
};
/** Basic-tier chats over ACP are 'acp:<harness>:<id>'. */
export const isAcpThread = (id: string | null | undefined) => !!id && id.startsWith('acp:');
/** Which list a chat belongs to: the list of that harness checks its saved rows (store/sidebarSnapshot.ts). */
export const isCodexThread = (id: string) => !isAcpThread(id) && ownerOf(id) === 'codex';
export const isClaudeThread = (id: string) => ownerOf(id) === 'claude';
/** Codex records a chat's pull request; Claude and ACP chats have none to show. */
export const hasThreadPullRequest = (id: string) => !isAcpThread(id) && ownerOf(id) === 'codex';
export const acpHarnessOf = (id: string | null | undefined) => (isAcpThread(id) ? id!.split(':')[1] : null);
/**
 * Whether a turn belongs to the chat's current segment. Edit (revert or rewind) only reaches back
 * inside it: earlier segments ran on another native session (D-40).
 */
export const inCurrentSegment = (segments: Segment[] | null | undefined, turnIndex: number) =>
  !segments?.length || turnIndex >= segments[segments.length - 1].start;
/** The id the harness's own CLI knows a native session by ('acp:kimi:<id>' → '<id>'). */
export const cliSessionId = (nativeId: string) =>
  isAcpThread(nativeId) ? nativeId.split(':').slice(2).join(':') : ownerOf(nativeId) === 'claude' ? claudeSessionId(nativeId) : nativeId;

/** "claude_max" + "default_claude_max_20x" → "Claude Max 20×" */
export function claudePlanLabel(subscriptionType: string | null | undefined, organizationType?: string | null, tier?: string | null) {
  let base = subscriptionType || organizationType || null;
  if (!base) return null;
  base = base.replace(/^claude[_ ]/i, '').replace(/_/g, ' ');
  base = /^claude /i.test(base) ? base : `Claude ${base[0].toUpperCase()}${base.slice(1)}`;
  const mult = /(\d+)x/i.exec(tier ?? '')?.[1];
  return mult ? `${base} ${mult}×` : base;
}

/* ------------------------------------------------------------------ */
/* Mid-chat switching (design §05)                                     */
/* ------------------------------------------------------------------ */
