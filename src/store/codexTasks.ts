// A Codex or ACP chat's background tasks in the store: polled while its work runs or its tasks pane is open, published to the tasks pane, stopped, and noted in the transcript as they settle.
// Codex lists shells and sub-agents; ACP has no task list of its own, so its sub-agents are read from the chat's turns.
import { ownTable } from '../../shared/ownTable.mjs';
import type { BackgroundTask } from './session/sessionState';
import type { StatusNoteItem, ThreadItem } from './types';
import { codexApi } from '../harness/adapters/codexApi';
import { backgroundTerminals, leftInBackground, runningTurnCommands, type BackgroundTerminal } from '../harness/codexTranslate';
import { buildCodexTasks, codexShellOutput, shellProcessId, taskEvent } from '../harness/codexTasks';
import { flattenTurns } from '../harness/codexAgentRun';
import { readCodexChildTurns, trackCodexAgent } from './codexAgents';
import { agentRunsIn, findAgentRun } from '../lib/findAgentRun';
import { agentStatus } from '../lib/agentRun';
import { agentThread, putAgentItems } from './agentThreads';
import { putAdapterTasks, type TaskStopper } from './backgroundTasks';
import { taskSourceOf, taskSourceKey, taskSource, taskSourceAt, TASK_SOURCE } from './chatFamily';
import { blockedReason } from './chats';
import { get as getState, patchTurn, toast } from './core';
import { terminateBackgroundTerminal } from './actions';
import { errorText } from '../lib/ignored';
import { visiblePoll } from '../lib/visiblePoll';
import { visibleChats } from './split';

/** How often a watched chat's tasks are read. */
export const POLL_MS = 3000;
/** How often a chat no pane shows is read: its dot and tasks marker settle without a read every tick. */
export const BACKGROUND_POLL_MS = 30_000;

const published = new Map<string, BackgroundTask[]>();
const stopped = new Map<string, Set<string>>();
const pollers = new Map<string, { count: number; stop: () => void }>();
const lastRead = new Map<string, number>();
const inFlight = new Map<string, { source: string }>();
const sources = new Map<string, string>();
const taskCurrent = (chatId: string, task: BackgroundTask) =>
  !task.source || JSON.stringify([task.source.kind, task.source.key]) === taskSourceKey(chatId);

/** The tasks last published for a chat. */
export const codexTasks = (chatId: string): BackgroundTask[] =>
  sources.get(chatId) === taskSourceKey(chatId) ? (published.get(chatId) ?? []) : [];

const isAcpChat = (chatId: string) => taskSourceOf(chatId) === 'turns';
const isCodexChat = (chatId: string) => taskSourceOf(chatId) === 'terminals' && !blockedReason(chatId, 'tasks');
/** Chats whose tasks are polled: Codex's, and an ACP chat's sub-agents. */
export function shouldPollTasks(chatId: string) {
  if (isCodexChat(chatId) || (isAcpChat(chatId) && !blockedReason(chatId, 'tasks'))) return true;
  if (taskSourceOf(chatId) !== 'main') return false;
  const s = getState();
  return agentRunsIn(s.runtime[chatId]?.turns, (turn) =>
    taskSourceAt(chatId, turn, s.segments?.[chatId], s.runtime[chatId]?.turnsAbove),
  ).some((run) => TASK_SOURCE[run.source!.kind] !== 'main');
}

/** This poll's background terminals, or null when the list couldn't be read (so no shell settles by mistake). */
async function readTerminals(chatId: string): Promise<BackgroundTerminal[] | null> {
  try {
    return backgroundTerminals(await codexApi.backgroundTerminals(chatId));
  } catch {
    return null;
  }
}

/** The tasks this window found on its first read of each chat: already there, so not news to the transcript. */
const known = new Map<string, Set<string>>();

/**
 * A task's event card: updated where it stands when it has one (a running card settles in place), else added at
 * the end of the chat's latest turn if the task appeared after this window first read the chat. A task that was
 * already there (an opened chat's history) gets no card.
 */
function noteTask(chatId: string, task: BackgroundTask) {
  const turns = getState().runtime[chatId]?.turns ?? [];
  const id = `task-${task.id}`;
  const event = taskEvent(task);
  const home = turns.find((t) => t.items.some((i) => i.id === id));
  if (home) {
    const had = home.items.find((i) => i.id === id) as unknown as StatusNoteItem;
    if (had.task?.status === event.status) return;
    const note: StatusNoteItem = { ...had, text: task.description, task: event };
    return patchTurn(chatId, home.id, (t) => ({ items: t.items.map((i) => (i.id === id ? (note as unknown as ThreadItem) : i)) }));
  }
  const last = turns[turns.length - 1];
  if (!last || known.get(chatId)!.has(task.id)) return;
  const note: StatusNoteItem = { type: 'statusNote', id, kind: 'task', text: task.description, task: event };
  patchTurn(chatId, last.id, (t) => ({ items: [...t.items, note as unknown as ThreadItem] }));
}

/** How a child thread's last turn ended, as the collab status the parent's spawn item would carry. */
const ENDED: Record<string, string> = ownTable({ completed: 'completed', failed: 'errored', interrupted: 'interrupted' });

/**
 * A spawned agent whose child thread has finished its turn is no longer running. Codex only says so on the parent's
 * spawn item when the parent waits for it, so a chat that never waits showed "Running agent" for good: read it off
 * the child's last turn and put it on the spawn item, where the row, the page and the tasks tab all read it.
 */
function settleAgent(
  chatId: string,
  key: string,
  parentTurns: { id: string; items: unknown[] }[],
  turns: { status?: string; items: unknown[] }[],
) {
  const ended = ENDED[turns[turns.length - 1]?.status ?? ''];
  if (!ended) return;
  for (const t of parentTurns) {
    type Spawn = {
      id?: string;
      type?: string;
      tool?: string;
      receiverThreadIds?: unknown[];
      agentsStates?: Record<string, { status?: unknown } | undefined>;
    };
    const spawn = (t.items as Spawn[]).find(
      (i) => i.type === 'collabAgentToolCall' && i.tool === 'spawnAgent' && i.receiverThreadIds?.includes(key),
    );
    if (!spawn) continue;
    // already settled by the parent (a wait, a close): leave what it says
    const now = spawn.agentsStates?.[key]?.status;
    if (now !== undefined && agentStatus(now) !== 'running') return;
    const said = flattenTurns(turns as never).filter((i) => i.type === 'agentMessage' && String(i.text ?? '').trim());
    const message = said.length ? String(said[said.length - 1].text).trim() : null;
    patchTurn(chatId, t.id, (turn) => ({
      items: turn.items.map((i) =>
        (i as Spawn).id === spawn.id
          ? ({
              ...spawn,
              agentsStates: { ...spawn.agentsStates, [key]: { ...spawn.agentsStates?.[key], status: ended, message } },
            } as never)
          : i,
      ),
    }));
    return;
  }
}

/** Flag the command items whose process is a background terminal, so their transcript rows follow the task as a Claude background command does. */
function markBackground(chatId: string, parentTurns: { id: string; items: unknown[] }[], itemIds: string[]) {
  type Cmd = { id?: string; type?: string; background?: boolean };
  for (const t of parentTurns) {
    const ids = (t.items as Cmd[])
      .filter((i) => i.type === 'commandExecution' && !i.background && itemIds.includes(String(i.id)))
      .map((i) => i.id);
    if (ids.length)
      patchTurn(chatId, t.id, (turn) => ({
        items: turn.items.map((i) =>
          (i as Cmd).type === 'commandExecution' && ids.includes(i.id) ? ({ ...i, background: true } as never) : i,
        ),
      }));
  }
}

/** An agent page open on a running (or just settled) agent whose child thread isn't loaded here: re-read it. */
async function refreshAgent(chatId: string, key: string, current: () => boolean) {
  const rt = getState().runtime[key];
  try {
    const turns = rt?.loaded ? rt.turns : await readCodexChildTurns(key);
    if (!current()) return;
    // A live child stream and the parent's native completion may have advanced during the read.
    const live = getState().runtime[key];
    if (!live?.loaded) putAgentItems(chatId, key, flattenTurns(turns));
    settleAgent(chatId, key, getState().runtime[chatId]?.turns ?? [], live?.loaded ? live.turns : turns);
  } catch (e) {
    console.warn('Could not read a sub-agent thread; the next poll tries again', e);
  }
}

/** Read a Codex chat's tasks once and publish them. */
export async function pollCodexTasks(chatId: string): Promise<void> {
  const source = taskSourceKey(chatId);
  if (inFlight.get(chatId)?.source === source || !shouldPollTasks(chatId)) return;
  if (sources.get(chatId) !== source) {
    sources.set(chatId, source);
    published.delete(chatId);
    known.delete(chatId);
    stopped.delete(chatId);
    putAdapterTasks(chatId, []);
  }
  const context = { source };
  lastRead.set(chatId, Date.now());
  inFlight.set(chatId, context);
  const current = () => inFlight.get(chatId) === context && taskSourceKey(chatId) === source;
  try {
    // ACP has no background terminals: only its sub-agents become tasks
    const read = isCodexChat(chatId) ? await readTerminals(chatId) : null;
    if (!current()) return;
    const s = getState();
    const terminals = read && leftInBackground(read, runningTurnCommands(s.runtime[chatId]));
    const parentTurns = s.runtime[chatId]?.turns ?? [];
    if (terminals) markBackground(chatId, parentTurns, terminals.map((t) => t.itemId).filter(Boolean));
    const built = buildCodexTasks({
      turns: parentTurns,
      terminals,
      prev: codexTasks(chatId),
      stopped: stopped.get(chatId) ?? new Set(),
      child: (key) => {
        const rt = s.runtime[key];
        const items = agentThread(chatId, key).items;
        // a child thread this window follows reports its own token usage
        return {
          thread: s.threads[key],
          turns: rt?.loaded ? rt.turns : items.length ? [{ items }] : null,
          tokens: rt?.tokenUsage?.total.totalTokens ?? null,
        };
      },
      now: Date.now(),
    });
    for (const task of built.tasks)
      task.source = task.agentKey
        ? (findAgentRun(parentTurns, task.agentKey, (turn) =>
            taskSourceAt(chatId, turn, s.segments?.[chatId], s.runtime[chatId]?.turnsAbove),
          )?.source ?? taskSource(chatId))
        : taskSource(chatId);
    // Claude jobs come from main's process-owned level, not from replaying historical agent calls.
    const tasks = built.tasks.filter((task) => TASK_SOURCE[task.source!.kind] !== 'main');
    const settled = built.settled.filter((task) => tasks.includes(task));
    published.set(chatId, tasks);
    putAdapterTasks(chatId, tasks);
    if (!known.has(chatId)) known.set(chatId, new Set(tasks.map((t) => t.id)));
    // a shell gets its card as it starts; an agent has its row in the group card and gets one as it settles
    for (const t of tasks) if (t.status === 'running' && !t.agentKey) noteTask(chatId, t);
    for (const t of settled) noteTask(chatId, t);
    const agents = tasks.filter((t) => t.agentKey && (t.status === 'running' || settled.includes(t)));
    for (const t of agents) {
      // an ACP sub-agent's steps arrive with its call, not from a child thread
      if (!current()) break;
      if (TASK_SOURCE[t.source!.kind] !== 'terminals') continue;
      trackCodexAgent(chatId, t.agentKey!);
      await refreshAgent(chatId, t.agentKey!, current);
    }
  } finally {
    if (inFlight.get(chatId) === context) inFlight.delete(chatId);
  }
}

/**
 * Poll a chat's tasks while something needs them: the integrator starts one for the tasks pane being open
 * and one while the chat has running work, and stops each when it ends. Counted, so either can end first.
 */
export function startCodexTaskPoller(chatId: string) {
  const p = pollers.get(chatId);
  if (p) return void p.count++;
  // parked while the window is hidden; one read when it shows again
  pollers.set(chatId, { count: 1, stop: visiblePoll(`codex-tasks:${chatId}`, POLL_MS, () => tickPoll(chatId)) });
  void pollCodexTasks(chatId);
}

/** Whether a pane of this window shows the chat, or its side pane does (the notifications' idea of on screen). */
function shownNow(chatId: string) {
  const s = getState();
  return visibleChats(s).includes(chatId) || s.paneTabs.some((t) => t.threadId === chatId);
}

/** One timer tick: a chat a pane shows is read now, any other once per BACKGROUND_POLL_MS (a window waking from hidden reads it too). */
function tickPoll(chatId: string) {
  if (!shownNow(chatId) && Date.now() - (lastRead.get(chatId) ?? 0) < BACKGROUND_POLL_MS) return;
  void pollCodexTasks(chatId);
}

/**
 * Release one holder; the last one stops the timer after one more read, so work a turn left behind as it ended (a
 * command it left running) is listed, and its running task keeps the chat polled (components/tasks/TaskPolling.tsx).
 */
export function stopCodexTaskPoller(chatId: string) {
  const p = pollers.get(chatId);
  if (!p) return;
  if (--p.count > 0) return;
  p.stop();
  pollers.delete(chatId);
  lastRead.delete(chatId);
  void pollCodexTasks(chatId);
}

/** Stop a spawned agent by interrupting its child thread's running turn: 'retired' when none runs, false (and a toast) on failure. */
async function stopCodexAgent(chatId: string, key: string): Promise<boolean | 'retired'> {
  const source = taskSourceKey(chatId);
  try {
    const running = (await readCodexChildTurns(key)).find((t) => t.status === 'inProgress');
    if (taskSourceKey(chatId) !== source) return false;
    // its turn ended already: the shared line says so (liveAction)
    if (!running) return 'retired';
    await codexApi.turnInterrupt(key, String(running.id));
  } catch (e) {
    if (taskSourceKey(chatId) !== source) return false;
    toast(`Couldn't stop the agent: ${errorText(e)}`, 'error');
    return false;
  }
  if (taskSourceKey(chatId) !== source) return false;
  await pollCodexTasks(chatId);
  return true;
}

/** Stops a Codex task: a shell is terminated, a sub-agent has its running turn interrupted. */
export const stopCodexTask: TaskStopper = async (chatId, task) => {
  if (task.stoppable === false) return false;
  // a shell from a segment the chat switched away from is gone with it: nothing to stop
  if (!task.agentKey && !taskCurrent(chatId, task)) return 'retired';
  if (task.agentKey) return stopCodexAgent(chatId, task.agentKey);
  const source = taskSourceKey(chatId);
  const processId = shellProcessId(task);
  if (!processId) return false;
  const terminated = await terminateBackgroundTerminal(chatId, processId);
  if (terminated !== true) return terminated;
  if (taskSourceKey(chatId) !== source) return false;
  stopped.set(chatId, new Set(stopped.get(chatId)).add(task.id));
  await pollCodexTasks(chatId);
  return true;
};

/** A shell task's output so far (its command item's aggregated output), or null when the chat has none. */
export function codexTaskOutput(chatId: string, task: BackgroundTask): string | null {
  if (!taskCurrent(chatId, task) || task.output?.kind !== 'process') return null;
  return codexShellOutput(getState().runtime[chatId]?.turns ?? [], task.output.id);
}
