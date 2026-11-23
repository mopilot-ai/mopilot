// A chat's call to MoPilot's scheduled-task tools (electron/capabilities/tools/scheduledTasks.cjs) that worked, read from the tool call item whichever harness made it, for the thread's "Scheduled task created" card.
import { ownTable } from '../../shared/ownTable.mjs';
import { toolInvocation } from '../../shared/toolInvocation.mjs';
import { toolOutput } from './toolOutput';

/** What the tool answered about a task (its summary()). */
export interface ScheduledTaskSummary {
  id: string;
  name: string;
  schedule: string;
  /** the schedule as a sentence */
  when?: string;
  status: string;
  harness: string;
  cwd: string | null;
  worktree: boolean;
  nextRun: string | null;
  runsIn: string[];
  computerControl?: boolean;
  onApproval?: string;
}

export type ScheduledTaskCall =
  | { action: 'created' | 'updated'; task: ScheduledTaskSummary }
  | { action: 'ran'; taskId: string; chatId: string };

const ACTION: Record<string, 'created' | 'updated' | 'ran'> = ownTable({
  create_scheduled_task: 'created',
  update_scheduled_task: 'updated',
  run_scheduled_task: 'ran',
});

/**
 * The call's tool and the server it names: a bare tool with its server (Codex), "mcp__<server>__<tool>" (Claude
 * Code), "<server>/<tool>"-style titles or MoPilot's server and tool joined by "_" (basic harnesses: opencode's
 * "sage_3f880302123f_momo_memory_search").
 */
export function nameOf(item: { tool?: unknown; server?: unknown }): { server: string; tool: string } | null {
  if (typeof item.tool !== 'string' || !item.tool) return null;
  const mcp = /^mcp__(.+?)__(.+)$/.exec(item.tool) ?? (item.server ? null : /^(sage_[0-9a-f]{12})_(.+)$/.exec(item.tool));
  if (mcp) return { server: mcp[1], tool: mcp[2] };
  const parts = item.tool.split(/[./:]/);
  const tool = parts.pop() as string;
  return { server: typeof item.server === 'string' ? item.server : parts.join('.'), tool };
}

const isTask = (t: unknown): t is ScheduledTaskSummary => {
  const x = t as ScheduledTaskSummary | null;
  return !!x && typeof x.id === 'string' && typeof x.schedule === 'string' && typeof x.harness === 'string' && Array.isArray(x.runsIn);
};

/** The scheduled-task call an item is, when it is one of MoPilot's that finished without an error; else null. */
export function scheduledTaskCall(item: unknown): ScheduledTaskCall | null {
  item = toolInvocation(item);
  const it = item as {
    type?: string;
    tool?: unknown;
    server?: unknown;
    status?: string;
    error?: unknown;
    result?: { isError?: boolean } | null;
    arguments?: unknown;
  } | null;
  if (!it || (it.type !== 'mcpToolCall' && it.type !== 'dynamicToolCall')) return null;
  const name = nameOf(it);
  const action = name && ACTION[name.tool];
  // MoPilot's tool server is sage_<nonce>; another server's tool of the same name is not ours
  if (!action || (name.server && !/^sage(_|$)/i.test(name.server))) return null;
  if (it.status !== 'completed' || it.error || it.result?.isError) return null;
  let out: unknown;
  try {
    out = JSON.parse(toolOutput(it).text);
  } catch {
    return null;
  }
  if (action === 'ran') {
    const chatId = (out as { chatId?: unknown })?.chatId;
    const taskId = (it.arguments as { id?: unknown } | null)?.id;
    return typeof chatId === 'string' && typeof taskId === 'string' ? { action, taskId, chatId } : null;
  }
  return isTask(out) ? { action, task: out } : null;
}
