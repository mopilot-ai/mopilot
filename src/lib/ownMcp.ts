// The user's own MCP servers in a basic harness's chats (#1575): when they crowd the model's context, and the choice that
// turns them off for MoPilot's chats only (prefs acpMcp; electron/harness/acp/ownMcp.cjs applies it).
import type { Prefs } from '../../shared/model/store';
import { compactionLoop } from './turnStall';

/**
 * Share of the model's window the fixed context (tools and instructions, before any conversation) must pass to read as
 * crowded: past half, every turn has less room than what the harness loads, and it compacts early and often (#1575 saw
 * 158k of fixed context in a 200k window compact after every step).
 */
export const CROWDED_SHARE = 0.5;

/** What is no work of the turn's own: a turn with nothing else held little but the fixed context and one exchange. */
const NOT_WORK = new Set<string>(['userMessage', 'agentMessage', 'reasoning', 'contextCompaction', 'statusNote', 'plan', 'hookPrompt']);

export type Crowding =
  | { kind: 'loop'; count: number }
  | { kind: 'full'; used: number; size: number; after: 'compacting' | 'reply' }
  | { kind: 'tools'; max: number }
  | null;

/**
 * How providers say a request carries more tools than the model takes: the cap is the number the sentence gives, found
 * within a clause that names tools (an opencode/Zen "Invalid value for 'tools': maximum number of items is 128", OpenAI's
 * "Invalid 'tools': array too long. Expected an array with maximum length 128"), never a limit on something else.
 */
const TOOL_CAP = /\btools\b[^;]{0,100}?(?:maximum number of items is|maximum length|at most)\s+(\d[\d,]*)/i;

/**
 * The number of tools a model takes per request, when the turn failed because the chat sent more (#1679): every message
 * of such a chat is refused until some tools go, and the provider's sentence is all the user would see.
 */
export function toolCap(error: { message: string; additionalDetails?: string | null } | null | undefined): number | null {
  const text = `${error?.message ?? ''} ${error?.additionalDetails ?? ''}`;
  const n = Number(TOOL_CAP.exec(text)?.[1]?.replace(/,/g, ''));
  return n > 0 ? n : null;
}

/**
 * Whether what the harness loads before the conversation crowds the model's context, judged from the chat's latest turn:
 * it compacts again and again without getting further, or once it ended, the context still in use reads as mostly fixed.
 * That is after a compaction (the history it held is gone) or after a turn that only replied (no work of its own).
 * @param usage the context the harness last reported (ACP usage_update): used and the model's window, in tokens
 */
export function crowding(
  turn:
    | { status: string; items: readonly { type: string }[]; error?: { message: string; additionalDetails?: string | null } | null }
    | null
    | undefined,
  usage: { used: number | null; size: number | null } | null | undefined,
): Crowding {
  if (!turn) return null;
  const max = turn.status === 'failed' ? toolCap(turn.error) : null;
  if (max) return { kind: 'tools', max };
  const count = compactionLoop(turn.items);
  if (count) return { kind: 'loop', count };
  if (turn.status !== 'completed' || !usage?.used || !usage.size || usage.used < usage.size * CROWDED_SHARE) return null;
  if (turn.items.some((i) => i.type === 'contextCompaction'))
    return { kind: 'full', used: usage.used, size: usage.size, after: 'compacting' };
  if (turn.items.every((i) => NOT_WORK.has(i.type))) return { kind: 'full', used: usage.used, size: usage.size, after: 'reply' };
  return null;
}

type Choices = Prefs['acpMcp'];

/** The choices with a harness's own servers loading or not. */
export function withLoad(all: Choices | undefined, harness: string, load: boolean): Choices {
  const c = all?.[harness] ?? {};
  return { ...all, [harness]: { ...c, load } };
}

/** The choices with one of a harness's servers turned off for MoPilot's chats, or on again. */
export function withServer(all: Choices | undefined, harness: string, name: string, off: boolean): Choices {
  const c = all?.[harness] ?? {};
  const rest = (c.off ?? []).filter((n) => n !== name);
  return { ...all, [harness]: { ...c, off: off ? [...rest, name] : rest } };
}

/** "158k": a token count as the note says it. */
export const kTokens = (n: number) => `${Math.round(n / 1000)}k`;
