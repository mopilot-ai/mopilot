import type { ThreadItem } from '../src/protocol/v2/ThreadItem';
import type { HookRunSummary } from '../src/protocol/v2/HookRunSummary';

export function hookRunNote(run: {
  event?: string | null;
  name?: string | null;
  outcome?: string | null;
  exitCode?: number | null;
  detail?: string | null;
}): string | null;
export function codexHookItem(run: HookRunSummary | null | undefined): Extract<ThreadItem, { type: 'hookPrompt' }> | null;
