import type { TurnState } from './model/store';
import type { HandoffMode, HarnessId } from './model/harness';
import type { HarnessKind } from './model/harness';

export const HARNESS_LABEL: Record<HarnessId, string>;
export const HANDOFF_LABEL: Record<HandoffMode, string>;
export const DIVIDER_BACK: string;
export const SUMMARY_PROMPT: string;
export const estimateTokens: (text: string) => number;
/** The target model's context window as far as the picker knows it. */
export function targetWindow(model: string): number;
/** The most tokens the handoff may take of the target model's context window. */
export const handoffBudget: (model: string) => number;
export function dividerText(
  from: HarnessKind,
  to: HarnessKind,
  modelLabel: string,
  mode: HandoffMode,
  tokens: number,
  fromLabel?: string,
  toLabel?: string,
): string;
/** The divider when a chat comes back to a harness it used before. */
export function backDivider(label: string, n: number, other: string): string;
/** The conversation within a token budget: newest turns verbatim, older ones as one-liners. */
export function renderConversation(turns: TurnState[], budgetTokens: number, firstNumber?: number): { text: string; condensed: number };
export function turnMessageTexts(turn: TurnState): { user: string; reply: string };
/** Who hands the chat over: a first-tier harness by its id, or a basic one by its kind and name. */
export type HandoffSource = { from: HarnessId; fromLabel?: undefined } | { from: string; fromLabel: string };
export type HandoffParts = HandoffSource & {
  /** the model the source segment ran, for the first line */
  fromModel: string | null | undefined;
  mode: HandoffMode;
  /** the turns to hand over (the chat's history from `since` on) */
  turns: TurnState[];
  /** the number of turns before `turns` */
  since: number;
  targetModel: string;
  /** the source harness's own handoff note (mode 'summary') */
  note?: string | null;
  /** the "## Workspace" section */
  workspace: string;
  /** the "## Tabs and targets this chat holds" section (heldText), when it holds any */
  held?: string;
};
/** The <sage-handoff> block placed before the user's next message on the new segment. */
export function composeHandoff(o: HandoffParts): string;
/** The "## Workspace" section: the directory, its branch and uncommitted changes. */
export function workspaceText(
  cwd: string,
  info: { branch: string } | null | undefined,
  status: { files?: { code: string; path: string; added: number; removed: number }[] } | null | undefined,
): string;
/** One target a chat holds (electron/capabilities/targetLeases.cjs Lease). */
export interface HeldTarget {
  surface: string;
  id: string;
  origin: string;
  openedBy?: string;
  mark?: string | null;
  takenOver?: boolean;
  userTook?: boolean;
  site?: string | null;
  label?: string;
  popup?: boolean;
}
/** The "## Tabs and targets this chat holds" section, or '' when the chat holds nothing. */
export function heldText(leases: HeldTarget[] | null | undefined, harness?: string | null): string;
/** Each segment's slice of its native history (a session may carry several segments). */
export function sliceSegments<T, S extends { nativeId: string; count: number | null }>(
  segs: S[],
  history: Map<string, T[]>,
  keyOf?: (segment: S) => string,
): T[][];
/** The message that sets the goal again: Codex takes it as an option, Claude Code as its own /goal command. */
export function goalAgain(to: HarnessId, objective: string): { text: string; opts: Record<string, unknown> };
