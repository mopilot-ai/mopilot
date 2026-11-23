// The Background tasks tab's list: what the tab leads with (its sessions, TasksTab.tsx), then Running and Finished sections
// of task cards, each expanding to its command and live output.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { ChevronRight, Diamond, Spinner, Square } from '../ui/icons';
import { CodeBlock } from '../markdown/Markdown';
import { Collapse } from '../ui/Presence';
import { useSessionField } from '../../store/session/useSession';
import type { BackgroundTask } from '../../store/session/sessionState';
import { mergeTasks, stopBackgroundTask, taskOutputReader, useAdapterTasks, useStoppingIds } from '../../store/backgroundTasks';
import { openAgentPage } from '../../store/panes';
import { useStore } from '../../store/core';
import { liveClick, onlyRetired } from '../../store/liveAction';
import { agentModelName } from '../../lib/agentRun';
import { findAgentRun } from '../../lib/findAgentRun';
import { formatDuration } from '../../lib/format';
import { undismissTasks, useDismissedIds } from '../../lib/dismissedTasks';
import { Shimmer } from '../thread/items/presentation';
import { finishedOpenFor, setFinishedOpen } from '../../lib/finishedOpen';
import { observeBottom, ScrollFollowing } from '../../lib/streamScroll';
import {
  KIND_LABEL,
  OUTPUT_TAIL_CHARS,
  awaitsApproval,
  cardKind,
  formatTokens,
  isRunningTask,
  outputPollMs,
  outputRetryMs,
  statusWord,
  taskElapsed,
  taskSections,
  taskTitle,
  toolVerb,
  useTaskClock,
  type TaskNode,
} from '../../lib/tasks';

/** A chat's tasks as the tab shows them: main's and the adapter's, without housekeeping and cleared finished ones. */
export function useChatTasks(chatId: string): BackgroundTask[] {
  const session = useSessionField(chatId, (s) => ({ tasks: s.tasks }));
  const adapter = useAdapterTasks(chatId);
  const dismissed = useDismissedIds(chatId);
  const listed = useMemo(() => mergeTasks(session.tasks, adapter).filter((t) => !t.ambient), [session.tasks, adapter]);
  // an agent task is titled by the call that launched it, and shows its model and counts the harness reported on that call;
  // only those facts are read from the turns, so a streamed delta that changes none of them renders nothing
  const keys = useMemo(() => listed.map((t) => t.agentKey), [listed]);
  const facts = useStore(
    useShallow((s) =>
      keys.flatMap((key): unknown[] => {
        const run = key ? findAgentRun(s.runtime[chatId]?.turns, key) : null;
        return run ? [true, run.description, run.model, run.tokens, run.toolUses] : [false, null, null, null, null];
      }),
    ),
  );
  const all = useMemo(
    () =>
      listed.map((t, at) => {
        const [found, description, model, tokens, toolUses] = facts.slice(at * 5, at * 5 + 5) as [boolean, string, string, number, number];
        if (!found) return t;
        return {
          ...t,
          description: description || t.description,
          model: t.model ?? (model ? agentModelName(model) : null),
          tokens: t.tokens ?? tokens,
          toolUses: t.toolUses ?? (toolUses || null),
        };
      }),
    [listed, facts],
  );
  // a cleared task that runs again comes back
  const revived = all.filter((t) => isRunningTask(t) && dismissed.has(t.id)).map((t) => t.id);
  const revivedKey = revived.join('\n');
  useEffect(() => {
    if (revivedKey) undismissTasks(chatId, revivedKey.split('\n'));
  }, [chatId, revivedKey]);
  return useMemo(() => all.filter((t) => isRunningTask(t) || !dismissed.has(t.id)), [all, dismissed]);
}

/** `lead`: what the list starts with (the chat's sessions); with one, the list is never empty. */
export function TaskList({ chatId, lead = null }: { chatId: string; lead?: ReactNode }) {
  const tasks = useChatTasks(chatId);
  const { running, finished } = taskSections(tasks);
  const [open, setOpen] = useState(() => finishedOpenFor(chatId));
  const clock = useTaskClock(tasks.some(isRunningTask));
  if (!tasks.length && !lead)
    return (
      <div className="tasks-empty">
        <Diamond size={20} strokeWidth={1.6} className="tasks-empty-mark" aria-hidden />
        Background tasks appear here
      </div>
    );
  return (
    <div className="tasks-scroll">
      <div className="tasks-column">
        {lead}
        {running.length > 0 && (
          <section className="tasks-section">
            <h3 className="tasks-section-head">Running</h3>
            <div className="tasks-cards">
              {running.map((n) => (
                <TaskCard key={n.task.id} node={n} chatId={chatId} now={clock} />
              ))}
            </div>
          </section>
        )}
        {finished.length > 0 && (
          <section className="tasks-section">
            <h3 className="tasks-section-head">
              <button
                className="tasks-finished-toggle"
                aria-expanded={open}
                onClick={() => {
                  setFinishedOpen(chatId, !open);
                  setOpen(!open);
                }}
              >
                <span>Finished</span>
                <span>{finished.length}</span>
                <ChevronRight size={12} className="tasks-caret" />
              </button>
            </h3>
            <Collapse open={open}>
              <div className="tasks-cards">
                {finished.map((n) => (
                  <TaskCard key={n.task.id} node={n} chatId={chatId} now={clock} />
                ))}
              </div>
            </Collapse>
          </section>
        )}
      </div>
    </div>
  );
}

function TaskCard({ node, chatId, now }: { node: TaskNode; chatId: string; now: number }) {
  const { task: t, children } = node;
  const [expanded, setExpanded] = useState(false);
  const stopping = useStoppingIds(chatId).has(t.id);
  const running = isRunningTask(t);
  const approvals = useSessionField(chatId, (s) => s.approvals);
  const waiting = running && awaitsApproval(approvals, t);
  const kind = cardKind(t.type);
  const title = taskTitle(t);
  const word = statusWord(t.status);
  const elapsed = taskElapsed(t, now);
  const shell = kind === 'shell';
  // every card opens: a shell shows its command and output, an agent opens its page, any other task its summary
  const opensPage = !shell && !!t.agentKey;
  const v = (s: string) => (running ? <span className="task-v">{s}</span> : s);
  return (
    <div className={`task-card ${running ? 'running' : 'finished'} ${expanded ? 'open' : ''} expandable`}>
      <div className="task-card-main">
        <div className="task-card-head">
          <div className="task-title">
            <button
              className="task-opener"
              aria-expanded={opensPage ? undefined : expanded}
              onClick={() => (opensPage ? openAgentPage(chatId, t.agentKey!, title) : setExpanded(!expanded))}
            >
              {running ? <Shimmer>{title}</Shimmer> : title}
            </button>
            <span className="task-caret-box">
              <ChevronRight size={12} className="tasks-caret" />
            </span>
          </div>
          {running && (
            <button
              className="task-stop task-secondary"
              aria-label={stopping ? 'Stopping…' : `Stop ${title}`}
              title={t.stoppable === false ? "This task can't be stopped from here" : stopping ? 'Stopping…' : 'Stop this task'}
              aria-busy={stopping || undefined}
              disabled={stopping || t.stoppable === false}
              onClick={() => liveClick(stopBackgroundTask(chatId, t).then(onlyRetired))}
            >
              {stopping ? <Spinner size={12} /> : <Square size={10} fill="currentColor" strokeWidth={0} />}
            </button>
          )}
        </div>
        <div className="task-meta">
          <div className="task-meta-line">
            <span className="task-type">{KIND_LABEL[kind]}</span>
            {word && <span className={t.status === 'failed' ? 'task-failed' : undefined}>{word}</span>}
            {waiting && <span className="task-waiting">Waiting for approval</span>}
            {elapsed != null && <span className="task-time">{formatDuration(elapsed)}</span>}
          </div>
          {kind === 'agent' && (
            <div className="task-meta-line">
              {t.model && <span>{v(t.model)}</span>}
              {t.tokens != null && <span>{v(formatTokens(t.tokens))}</span>}
              {t.toolUses != null && (
                <span>
                  {v(String(t.toolUses))} {t.toolUses === 1 ? 'tool use' : 'tool uses'}
                </span>
              )}
              {running && t.latestTool && <span>{v(toolVerb(t.latestTool))}</span>}
              {t.agentKey && (
                <button className="task-link task-secondary" onClick={() => openAgentPage(chatId, t.agentKey!, title)}>
                  View transcript
                </button>
              )}
            </div>
          )}
        </div>
      </div>
      <Collapse open={expanded}>
        <div className="task-body">
          {shell && t.command && <CodeBlock code={`$ ${t.command}`} lang="bash" showHeader={false} maxHeight={200} />}
          {shell ? (
            <TaskOutput key={JSON.stringify([chatId, t.id, t.source?.kind, t.source?.key])} chatId={chatId} task={t} running={running} />
          ) : (
            <div className="task-summary">{t.summary || 'No further details yet.'}</div>
          )}
        </div>
      </Collapse>
      {children.length > 0 && (
        <div className="task-children">
          {children.map((c) => (
            <TaskCard key={c.task.id} node={c} chatId={chatId} now={now} />
          ))}
        </div>
      )}
    </div>
  );
}

/** A shell's output: read through the chat's adapter, again while it runs (slower as it grows), tailing unless the user looks back. */
function TaskOutput({ chatId, task, running }: { chatId: string; task: BackgroundTask; running: boolean }) {
  // undefined: loading; null: unavailable
  const [out, setOut] = useState<string | null | undefined>(undefined);
  const latest = useRef(task);
  latest.current = task;
  const source = task.source;
  useEffect(() => {
    const read = taskOutputReader(chatId, source);
    if (!read) {
      setOut(null);
      return;
    }
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    const tick = async () => {
      let text: string | null;
      try {
        text = await read(latest.current);
        failures = 0;
      } catch {
        text = null;
        failures++;
      }
      if (!alive) return;
      setOut((prev) => (text === null && prev ? prev : text));
      if (running) timer = setTimeout(tick, failures ? outputRetryMs(failures) : outputPollMs(text?.length ?? 0));
    };
    void tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [chatId, running, source]);

  const pre = useRef<HTMLPreElement>(null);
  const stick = useRef(new ScrollFollowing());
  const canFollow = useCallback((el: HTMLPreElement) => {
    const sel = window.getSelection();
    return pre.current === el && stick.current.following && !(sel && !sel.isCollapsed && sel.anchorNode && el.contains(sel.anchorNode));
  }, []);
  const hasOutput = !!out;
  useEffect(() => {
    if (!hasOutput) return;
    const el = pre.current!;
    return observeBottom(
      el,
      el,
      () => canFollow(el),
      () => stick.current.set(el, stick.current.following),
    );
  }, [hasOutput, canFollow]);
  useLayoutEffect(() => {
    const el = pre.current;
    if (!out || !el || !canFollow(el)) return;
    el.scrollTop = el.scrollHeight;
    stick.current.set(el, true);
  }, [out, canFollow]);

  if (out === undefined) return <div className="task-output-note">Loading output…</div>;
  if (out === null) return <div className="task-output-note">Output unavailable</div>;
  if (!out) return <div className="task-output-note">{running ? 'No output yet' : 'No output captured.'}</div>;
  return (
    <pre
      ref={pre}
      className="task-output"
      aria-label={`Output for ${taskTitle(task)}`}
      onScroll={(e) => {
        stick.current.scrolled(e.currentTarget, 16);
      }}
    >
      {out.length > OUTPUT_TAIL_CHARS ? out.slice(-OUTPUT_TAIL_CHARS) : out}
    </pre>
  );
}
