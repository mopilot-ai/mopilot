// Claude Code's side of the agent page and tasks pane: a sub-agent's stored transcript and a background task's output.
import { native } from '../../lib/native';
import { noteIgnored } from '../../lib/ignored';
import { agentModelName, type AgentRun } from '../../lib/agentRun';
import type { AgentThreadLoader } from '../../store/agentThreads';
import type { BackgroundTask } from '../../store/session/sessionState';
import { get as getState } from '../../store/core';
import { claudeSessionId } from '../../harness/types';
import type { AgentItem } from '../../../shared/model/window';

/** The Claude sessions a chat ran on, newest first: a sub-agent ran in one of them. */
function claudeSessionsOf(chatId: string): string[] {
  const segs = getState().segments[chatId] ?? [];
  const ids = segs.filter((s) => s.harness === 'claude').map((s) => s.nativeId);
  if (!segs.length && chatId.startsWith('claude:')) ids.push(chatId);
  return ids.reverse().map(claudeSessionId);
}

/**
 * A finished (or not yet seen) sub-agent's transcript, from its sidecar file, as the items the main transcript
 * renders. The run's agentId comes from its Agent result (the trailer or the structured result).
 */
export const loadClaudeAgentThread: AgentThreadLoader = async (chatId, run) => {
  const agentId = (run as AgentRun & { agentId?: string | null }).agentId;
  if (!agentId) throw new Error('This agent left no transcript');
  const cwd = getState().threads[chatId]?.cwd ?? '';
  const sessions = run.source ? [claudeSessionId(run.source.key)] : claudeSessionsOf(chatId);
  for (const sessionId of sessions) {
    const read = await native.claude.subagentItems(sessionId, agentId, {
      chatId,
      cwd,
      settled: run.status !== 'running',
      dir: cwd || null,
    });
    if (read) {
      const { items, model, unread } = JSON.parse(new TextDecoder().decode(read)) as {
        items: AgentItem[];
        model: string | null;
        unread: number;
      };
      if (unread) noteIgnored("read a sub-agent's transcript", `${unread} unreadable lines skipped`);
      // a replayed run has no heartbeat to name its model: the transcript's own assistant messages do
      return { items, model: model === null ? null : agentModelName(model) };
    }
  }
  return [];
};

/** The latest output of a background task that writes to a file (a shell), or null when it has none. */
export async function readClaudeTaskOutput(task: BackgroundTask): Promise<string | null> {
  return task.output?.kind === 'file' ? native.claude.taskOutput(task.id, task.output.path) : null;
}
