// Connects the agent page and tasks pane to each harness: which loader, stopper and output reader a chat's current harness uses, and when Codex tasks are polled.
import { useEffect } from 'react';
import { loadCodexAgentThread } from './codexAgents';
import { agentThread, setAgentThreadLoaderResolver, type AgentThreadLoader } from './agentThreads';
import {
  setAdapterTaskSourceResolver,
  setTaskOutputReaderResolver,
  setTaskStopperResolver,
  type TaskStopper,
  type TaskOutputReader,
} from './backgroundTasks';
import { codexTaskOutput, shouldPollTasks, startCodexTaskPoller, stopCodexTask, stopCodexTaskPoller } from './codexTasks';
import { taskSourceKey, taskSourceAt, type Family } from './chatFamily';
import { chatFamily } from './chats';
import { findNestedAgentRun } from '../lib/findAgentRun';
import { toast, useStore, get as getState } from './core';
import { runtime } from './runtime';

/** The reader for a chat's tasks: Claude reads the task's output file, Codex the shell command's output so far; ACP has none. */
const READERS: Record<Family, (chatId: string) => TaskOutputReader | null> = {
  claude: () => (task) => runtime().readClaudeTaskOutput(task),
  codex: (chatId) => async (task) => codexTaskOutput(chatId, task),
  acp: () => null,
};

/** Point the agent page and tasks pane at the chat's current harness. Called once at boot. */
export function wireAgentSurfaces() {
  // the harness modules through the runtime main installs, read each time one is called
  const loaders: Record<Family, AgentThreadLoader> = {
    claude: (chatId, run) => runtime().loadClaudeAgentThread(chatId, run),
    codex: loadCodexAgentThread,
    acp: (chatId, run) => runtime().loadAcpAgentThread(chatId, run),
  };
  const stoppers: Record<Family, TaskStopper | null> = {
    claude: (chatId, task) => runtime().stopClaudeTask(chatId, task),
    codex: stopCodexTask,
    acp: null,
  };
  setAdapterTaskSourceResolver(taskSourceKey);
  setAgentThreadLoaderResolver((chatId, run) => {
    const s = getState();
    const owned = findNestedAgentRun(
      s.runtime[chatId]?.turns,
      run.key,
      (parent) => agentThread(chatId, parent.key).items,
      (turn) => taskSourceAt(chatId, turn, s.segments[chatId], s.runtime[chatId]?.turnsAbove),
    );
    const source = run.source ?? owned?.source;
    const load = loaders[source?.kind ?? chatFamily(chatId)];
    return (chatId, run) => load(chatId, { ...run, source });
  });
  setTaskStopperResolver((chatId, source) => stoppers[source?.kind ?? chatFamily(chatId)]);
  setTaskOutputReaderResolver((chatId, source) => READERS[source?.kind ?? chatFamily(chatId)](chatId));
}

/**
 * Keep a Codex or ACP chat's background tasks fresh while they matter: the poller runs while the chat has work in
 * flight or its tasks pane is open. Claude's own tasks arrive from main; historical Codex/ACP agents still need polling.
 */
export function useTaskPolling(chatId: string, wanted: boolean) {
  // A switch can keep the same chat id and wanted state: subscribe to its selected segment.
  useStore((s) => s.segments[chatId]);
  const source = taskSourceKey(chatId);
  // read in the selector: the answer is a boolean, so a streamed delta that adds no foreign agent renders nothing
  const polled = useStore(() => shouldPollTasks(chatId));
  useEffect(() => {
    if (!wanted || source !== taskSourceKey(chatId) || !polled) return;
    startCodexTaskPoller(chatId);
    return () => stopCodexTaskPoller(chatId);
  }, [chatId, wanted, source, polled]);
}

const MOVERS: Record<Family, ((chatId: string) => Promise<boolean>) | null> = {
  claude: (chatId) => runtime().claudeMoveToBackground(chatId),
  codex: null,
  acp: null,
};

/**
 * Move what a chat runs in the foreground to the background (Ctrl+B). Claude Code can; Codex and ACP have no way to
 * detach a running command or agent, and the shortcut says so instead of doing nothing.
 */
export async function moveToBackground(chatId: string): Promise<boolean> {
  const move = MOVERS[chatFamily(chatId)];
  if (move) return move(chatId);
  toast("This chat's harness can't move running work to the background");
  return false;
}
