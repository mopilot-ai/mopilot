// The agent page body: one sub-agent's model, prompt and transcript, shown in the tasks tab (the chrome is the tab's).
import { useEffect, useRef, useState } from 'react';
import { agentModelName, type AgentRun } from '../../lib/agentRun';
import { agentStatsLine, agentToolCalls, findNestedAgentRun } from '../../lib/findAgentRun';
import { markFollowing, observeBottom, ScrollFollowing } from '../../lib/streamScroll';
import { taskSourceAt } from '../../store/chatFamily';
import { useStore } from '../../store/core';
import { agentThread, useAgentThread, useAgentThreadsVersion } from '../../store/agentThreads';
import { FoldedText } from '../ui/FoldedText';
import { Markdown } from '../markdown/Markdown';
import { BlockItem, buildBlocks, StepGroup, type DisplayItem } from '../thread/Items';
import { foldPolls } from '../thread/items/pollRuns';
import { PollRow } from '../thread/items/PollRow';
import { AgentChatContext } from './AgentGroup';
import type { ThreadItem } from '../../store/types';

/** Props the tasks tab passes: the chat and the agent's AgentRun key; the page finds the run in the chat's turns. */
export interface AgentPageProps {
  chatId: string;
  agentKey: string;
  cwd: string;
}

export function AgentPage({ chatId, agentKey, cwd }: AgentPageProps) {
  const turns = useStore((s) => s.runtime[chatId]?.turns);
  const segments = useStore((s) => s.segments?.[chatId]);
  const turnsAbove = useStore((s) => s.runtime[chatId]?.turnsAbove);
  // a nested agent is found in its parent's transcript, so any transcript changing can change this page's run
  useAgentThreadsVersion();
  const run = findNestedAgentRun(
    turns,
    agentKey,
    (r) => agentThread(chatId, r.key).items,
    (turn) => taskSourceAt(chatId, turn, segments, turnsAbove),
  );
  const source = run?.source;
  return (
    <AgentTranscript
      key={JSON.stringify([chatId, agentKey, source?.kind, source?.key])}
      chatId={chatId}
      agentKey={agentKey}
      cwd={cwd}
      run={run}
    />
  );
}

/** Follow state belongs to one agent in one chat and native session, including reused agent keys after a switch. */
function AgentTranscript({ chatId, agentKey, cwd, run }: AgentPageProps & { run: AgentRun | null }) {
  const thread = useAgentThread(chatId, run);
  const scroll = useRef<HTMLDivElement>(null);
  const column = useRef<HTMLDivElement>(null);
  const running = run?.status === 'running';
  // follow a running agent's newest step until the user scrolls up
  const stick = useRef(new ScrollFollowing());
  const follow = (on: boolean) => {
    stick.current.set(scroll.current, on);
    markFollowing(scroll.current, on);
  };
  useEffect(() => {
    if (!running || !scroll.current || !column.current) return;
    const el = scroll.current;
    markFollowing(el, stick.current.following);
    const stop = observeBottom(
      el,
      column.current,
      () => stick.current.following,
      () => stick.current.set(el, stick.current.following),
    );
    // a settled agent's page no longer follows: the browser anchors it again
    return () => {
      stop();
      markFollowing(el, false);
    };
  }, [running]);
  const onScroll = () => {
    const el = scroll.current!;
    const on = stick.current.scrolled(el);
    // while it follows, the browser's scroll anchoring must not move the page off the bottom (streamScroll)
    follow(on);
  };

  return (
    <AgentChatContext.Provider value={chatId}>
      <div
        className="agent-page"
        data-agent={agentKey}
        tabIndex={0}
        role="region"
        aria-label="Agent transcript"
        ref={scroll}
        onScroll={onScroll}
        onWheel={(event) => {
          const on = stick.current.wheel(event.currentTarget, event);
          if (on !== null) follow(on);
        }}
        onKeyDown={(event) => {
          const on = stick.current.key(event.currentTarget, event);
          if (on !== null) follow(on);
        }}
      >
        <div className="agent-page-column" ref={column}>
          {run ? (
            <AgentRunBody
              run={run}
              items={thread.items as unknown as DisplayItem[]}
              loading={thread.loading}
              storedModel={thread.model}
              error={thread.error}
              cwd={cwd}
            />
          ) : (
            <Placeholder>Loading…</Placeholder>
          )}
        </div>
      </div>
    </AgentChatContext.Provider>
  );
}

function Placeholder({ children }: { children: string }) {
  return <div className="agent-page-placeholder">{children}</div>;
}

function AgentRunBody({
  run,
  items,
  loading,
  storedModel,
  error,
  cwd,
}: {
  run: AgentRun;
  items: DisplayItem[];
  loading: boolean;
  storedModel: string | null;
  error: string | null;
  cwd: string;
}) {
  const running = run.status === 'running';
  const arriving = useResultHold(run);
  const summaryOnly = run.transcript === 'summary';
  // repeated checks fold into one row as in a turn; the running group stays out
  const blocks = foldPolls(buildBlocks(items as ThreadItem[]), running);
  const lastText = [...items].reverse().find((i) => i.type === 'agentMessage') as { text?: string | null } | undefined;
  // the report is the agent's last message for most harnesses: don't show it twice
  const report = run.report?.trim() && run.report.trim() !== lastText?.text?.trim() ? run.report : null;
  return (
    <>
      <div className="agent-page-head">
        {(run.model || storedModel) && (
          <p className="agent-page-model">
            Model <span className="agent-page-model-value">{run.model ? agentModelName(run.model) : storedModel}</span>
          </p>
        )}
        {run.prompt?.trim() && <PromptBubble key={run.prompt} text={run.prompt} />}
        {!summaryOnly && !error && !items.length && <Placeholder>{loading ? 'Loading…' : 'No activity yet'}</Placeholder>}
      </div>
      {summaryOnly && <div className="agent-page-note">This harness doesn't share the agent's steps.</div>}
      {error && <div className="agent-page-error">Couldn't load the agent's steps: {error}</div>}
      {blocks.length > 0 && (
        <div className="agent-page-entries">
          {blocks.map((b, i) =>
            b.kind === 'block' ? (
              <BlockItem key={b.item.id} item={b.item} cwd={cwd} running={running && i === blocks.length - 1} />
            ) : b.kind === 'poll' ? (
              <PollRow key={b.checks[0].items[0].id} block={b} cwd={cwd} />
            ) : (
              <StepGroup key={b.items[0].id} items={b.items} cwd={cwd} active={running && i === blocks.length - 1} hideTime />
            ),
          )}
        </div>
      )}
      {running || arriving ? (
        <SparkSpinner />
      ) : (
        <>
          {report ? (
            <div className="agent-page-report">
              <Markdown text={report} cwd={cwd} />
            </div>
          ) : (
            // an agent whose transcript ends with its own message has said its result there (Codex hands back none of its own)
            !run.report?.trim() && !lastText?.text?.trim() && <div className="agent-page-note">{noResult(run.status)}</div>
          )}
          <div className="agent-page-stats">{agentStatsLine({ ...run, toolUses: agentToolCalls(run, items) })}</div>
        </>
      )}
    </>
  );
}

/** How long the spinner stays after an agent settles without its report: the report may still be on its way. */
export const RESULT_HOLD_MS = 2500;

/** True for 2.5 s after a run this page watched settle while it had no report yet (a finished one opened later has none to wait for). */
function useResultHold(run: AgentRun): boolean {
  const [held, setHeld] = useState(false);
  const was = useRef(run.status);
  useEffect(() => {
    const settledNow = was.current === 'running' && run.status !== 'running';
    was.current = run.status;
    if (!settledNow || run.report?.trim()) return;
    setHeld(true);
    const t = setTimeout(() => setHeld(false), RESULT_HOLD_MS);
    return () => clearTimeout(t);
  }, [run.status, run.report]);
  return held && !run.report?.trim();
}

const noResult = (status: AgentRun['status']) =>
  status === 'failed' ? 'No result — the agent failed' : status === 'stopped' ? 'No result — the agent was stopped' : 'No result';

/** The agent's prompt as a right-aligned bubble; a long one folds with a fade and "Show more". */
export function PromptBubble({ text }: { text: string }) {
  return (
    <div className="agent-page-prompt">
      <div className="agent-page-bubble">
        <FoldedText text={text} />
      </div>
    </div>
  );
}

/** Claude Desktop's running spark: 18 px, 9 frames of 90 ms; static under reduced motion. */
export function SparkSpinner() {
  return (
    <div className="agent-spark" role="status">
      <svg viewBox="-9 -9 18 18" width={18} height={18} aria-hidden>
        {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
          <rect key={i} x={-0.9} y={-8} width={1.8} height={5.5} rx={0.9} transform={`rotate(${i * 45})`} />
        ))}
      </svg>
      <span className="agent-spark-label">Thinking…</span>
    </div>
  );
}
