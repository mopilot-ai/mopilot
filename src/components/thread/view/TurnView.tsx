// One turn’s messages, work blocks, narration, errors and final response.
import { StatusCounts } from '../../tasks/SessionsCount';
import { replyIsStreaming } from '../../../lib/textPacer';
import { memo, useCallback, useMemo, useRef } from 'react';
import { Collapse, COLLAPSE_MS, usePresence } from '../../ui/Presence';
import { useStore } from '../../../store/core';
import { endCard as turnEndCard, presentItems, turnCard } from '../../../harness/codexTranslate';
import { useAuthRecovery } from '../../../session/machineAgent';
import { drawsErrorBox } from '../../../session/machineAuthBox';
import type { TurnState } from '../../../store/types';
import { buildBlocks, StepGroup, BlockItem, useNow, ReplyText, type DisplayItem } from '../Items';
import { agentRunOf } from '../../../lib/agentRun';
import { AsyncQuestions } from '../AsyncQuestions';
import { hasAsyncQuestions, splitTurn, splitWorkChunks } from '../../../lib/asyncQuestions';
import { reasoningText } from '../../../lib/reasoning';
import { narrationContexts, type NarrationContext } from '../../../lib/agentNarration';
import { Enter, Reveal } from '../arrival';
import { formatDuration } from '../../../lib/format';
import { ChevronRight, ChevronDown, AlertTriangle } from '../../ui/icons';
import { turnDiffFiles } from '../../../lib/turnDiff';
import { InStatusSlot } from '../statusSlot';
import { ThinkingLine } from './ThinkingLine';
import { type ActivityUx } from '../../../session/activityUx';
import { foldTaskEvents } from '../../../lib/taskEvents';
import { UserMessage, type UserMessageItem } from './UserMessage';
import { TurnCardView, EditedCard, type FileChangeItem } from './TurnCards';
import { MessageActions } from './MessageActions';
import { RoutineOffer } from '../RoutineOffer';
import { isBareRateLimit, sameWords } from './friendlyError';
import { TurnErrorHelp } from './TurnErrorHelp';
import { SignInWaiting } from '../../accounts/SignInWaiting';
import { RequestLogLink } from './RequestLogLink';
import { useKeptUnfold } from './keptUnfold';
import { CompactionLoopNote } from '../TurnStall';
import { FailedTurnRetry } from '../FailedTurnRetry';
import { isLoginRefused } from '../../../../shared/loginRefused.mjs';
import { TurnTimingContext } from '../items/turnTiming';
import { stoppedByYou } from '../../../store/stoppedByYou';
import { turnProposals } from '../../../lib/sessionToolCall';
import { toolCard, republished } from '../items/stepModel';
import { foldPolls } from '../items/pollRuns';
import { joinSessionCards, type TurnBlock } from '../items/sessionRuns';
import { SessionStack } from '../SessionStack';
import { PollRow } from '../items/PollRow';
import { TurnSuggestions } from '../TaskProposalCard';
import { useWholeReplies } from '../../momo/shell/wholeReplies';
import { OptionChips } from '../../momo/OptionChips';
import { isMomoChat } from '../../../lib/momoChats';
import { dayStamp } from '../../../lib/dayDivider';
import { turnElapsed } from '../../../lib/turnElapsed';
import { PullRequestReferenceTime } from '../../markdown/prReferenceTime';
const FRESH_MS = 10_000;

/** In MoMo's whole-bubble chat (the shell on), a note still arriving waits for its end: it is not drawn yet. */
const heldBack = (b: TurnBlock, running: boolean, times: TurnState['itemTimes']) =>
  b.kind === 'block' && b.item.type === 'agentMessage' && replyIsStreaming(running, times[b.item.id]?.end);

/**
 * Whether a block stays in view when the work folds: a session the turn started (its card, as Claude Desktop keeps it in
 * the turn), a page it published on claude.ai (what the turn made), or steps holding an agent that has not settled or a
 * command whose background task still runs.
 */
const KEPT_CARDS = new Set(['session', 'artifact']);
const runsOn = (b: TurnBlock, calls: ReadonlySet<string>): boolean =>
  b.kind === 'sessions' ||
  (b.kind === 'poll' && b.checks.some((c) => runsOn({ kind: 'steps', items: c.items }, calls))) ||
  (b.kind === 'block' && KEPT_CARDS.has(toolCard(b.item)?.kind ?? '')) ||
  (b.kind === 'steps' &&
    b.items.some(
      (i) =>
        agentRunOf(i)?.status === 'running' ||
        (i.type === 'commandExecution' && (i as { background?: boolean }).background === true && calls.has(i.id)),
    ));

const NO_CHIPS: readonly string[] = [];

/**
 * Memoized: a turn re-renders only when its own props change. The thread passes props that keep their identity
 * while another turn streams (each turn's own answers, priors and arrival scope), and a finished turn keeps its object.
 */
export const TurnView = memo(function TurnView({
  turn,
  cwd,
  threadId,
  ux,
  isLast,
  live,
  readOnly,
  questionAnswers,
  dockedQuestion,
  narration,
  runningCalls: calls,
}: {
  turn: TurnState;
  cwd: string;
  threadId: string;
  ux: ActivityUx;
  isLast: boolean;
  /** the chat's running turn (src/lib/liveTurn.ts): only it draws live; another turn left running draws as settled */
  live: boolean;
  readOnly: boolean;
  /** the submitted answers to this turn's own questions */
  questionAnswers: ReadonlyMap<string, Record<number, string>>;
  /** this turn's questions that wait docked above the composer: not drawn here until answered */
  dockedQuestion?: string;
  /** the app bindings earlier turns left in Codex's computer-use kernel */
  narration?: NarrationContext;
  /** the tool calls whose background task still runs in this chat */
  runningCalls: ReadonlySet<string>;
}) {
  const auth = useAuthRecovery(threadId, turn.error?.message);
  // MoMo's chat with the shell on: a reply is drawn whole, once it is complete, never token by token
  const whole = useWholeReplies();
  // the sign-in those buttons started, while it waits on a login elsewhere
  const waiting = useStore((s) => auth?.waiting?.text(s) ?? null);
  const running = live && turn.status === 'inProgress';
  // kept while the turn is a placeholder in a long thread, so it comes back as it was left
  const [expanded, setExpanded] = useKeptUnfold(turn.id);
  const now = useNow(running);
  const observedStart = useRef(now);
  // MoMo's chats leave the CLI's own records ("No response requested.") out: they are no reply of MoMo's (shared/modelFraming.mjs)
  const momo = useStore((st) => isMomoChat(st.momoChats, threadId));
  // MoMo's thread stamps its days and long quiets (the design's grey "Today 3:17 AM")
  const previousStart = useStore((st) => {
    const turns = momo ? st.runtime[threadId]?.turns : undefined;
    const i = turns ? turns.findIndex((t) => t.id === turn.id) : -1;
    return i > 0 ? turns![i - 1].startedAt : null;
  });
  const stamp = momo ? dayStamp(turn.startedAt, previousStart, now) : null;
  const items = useMemo(() => foldTaskEvents(presentItems(turn.items, momo)), [turn.items, momo]);
  // each step group narrates with the bindings the programs before it left (in this turn and earlier ones)
  const groupNarration = useMemo(() => {
    const before = narrationContexts(items, narration);
    return new Map(items.map((item, i) => [item.id, before[i]]));
  }, [items, narration]);
  const narrationOf = useCallback((id: string) => groupNarration.get(id), [groupNarration]);
  // UserMessage renders only userMessage items of this turn, so each has an index here
  const userIndexes = useMemo(
    () => new Map(items.filter((item) => item.type === 'userMessage').map((item, index) => [item.id, index])),
    [items],
  );
  // a plan or an inline review's result ends the turn as a card, in place of a plain reply
  const card = useMemo(() => turnCard(items, !!turn.planMode, running), [items, turn.planMode, running]);
  // a plan approved mid-turn (Claude's ExitPlanMode) is carried out in the same turn: it stays where it was
  // approved, so the work that follows shows below it instead of above it
  const endCard = turnEndCard(card, items);
  const inlinePlan = card && !endCard ? card.item.id : undefined;
  // the sessions this turn proposed: one suggestion card after its reply, as Claude Desktop ends a turn with them
  const proposals = useMemo(() => turnProposals(items), [items]);
  const {
    users,
    work,
    final: reply,
  } = useMemo(() => splitTurn(endCard ? items.filter((i) => i.id !== endCard.item.id) : items, running), [items, endCard, running]);
  // the CLI's own words for a failure ("Your organization has disabled…") arrive as its reply and again as the turn's error: the error box says it once
  const final = reply && turn.error && !running && sameWords((reply as { text?: string }).text, turn.error.message) ? undefined : reply;
  const chips = (final as { options?: string[] } | null)?.options ?? NO_CHIPS;
  // MoMo's question waits for its answer: its chips show, and no action row under it
  const asking = momo && isLast && !running && !readOnly && chips.length > 0;
  // User messages, status notes, async questions and an in-turn plan stay visible when the work is collapsed.
  // a page published again later in the turn is one card, at its latest version, wherever the turn's chunks split
  // repeated checks with waits between them fold into one row; the running group stays out, so its live line holds its place
  const chunks = useMemo(() => {
    const superseded = republished(work);
    const parts = splitWorkChunks(work, inlinePlan);
    return parts.map((c, ci) =>
      c.kind === 'head'
        ? c
        : {
            kind: 'work' as const,
            blocks: joinSessionCards(foldPolls(buildBlocks(c.items, superseded), running && ci === parts.length - 1)),
          },
    );
  }, [work, inlinePlan, running]);
  const lastChunk = chunks[chunks.length - 1];
  const lastBlocks = lastChunk?.kind === 'work' ? lastChunk.blocks : [];
  const lastBlock = lastBlocks.at(-1);
  const streamingReply =
    lastBlock?.kind === 'block' &&
    lastBlock.item.type === 'agentMessage' &&
    replyIsStreaming(running, turn.itemTimes[lastBlock.item.id]?.end);
  const elapsed = turnElapsed(turn, running, now, observedStart.current);
  // stable while the turn streams: a row reads its item's time when the item itself changes, so a new time re-renders no other row
  const times = useRef(turn.itemTimes);
  times.current = turn.itemTimes;
  const interrupted = turn.status === 'interrupted';
  const timing = useMemo(() => ({ timeOf: (id: string) => times.current[id], interrupted }), [interrupted]);
  const showReasoning = useStore((s) => s.prefs.showReasoning);
  const youStopped = turn.status === 'interrupted' && stoppedByYou(threadId, turn);
  const stopped = turn.status === 'interrupted' ? (youStopped ? 'You stopped' : 'Stopped') : null;
  // MoMo's chats say "Stopped", and only of a turn its person stopped, with no duration: an interrupted turn nobody stopped (the app quit) is no news
  const momoStopped = momo && turn.status === 'interrupted';
  const hasWork = work.some((w) => w.type !== 'hookPrompt' && (w.type !== 'reasoning' || (showReasoning && !!reasoningText(w).trim())));
  // only finished work folds and unfolds
  const foldable = !running && hasWork;
  const edits = useMemo(
    () => turn.items.filter((i): i is FileChangeItem => i.type === 'fileChange' && i.status === 'completed'),
    [turn.items],
  );
  const editedFiles = useMemo(() => turnDiffFiles({ diff: turn.diff, items: edits }, cwd), [turn.diff, edits, cwd]);
  const showBlocks = running || expanded;
  // a background agent or command still running outlives its turn: it stays in view when the work folds into "Worked for"
  const runsAgent = (b: TurnBlock) => runsOn(b, calls);
  const pinned = !showBlocks && chunks.some((c) => c.kind === 'work' && c.blocks.some(runsAgent));
  const hasHead = chunks.some((c) => c.kind === 'head');
  // the work folds into "Worked for" and unfolds out of it as Claude Desktop's does (accordion-open/close, #1511): the
  // blocks stay rendered while the height closes. With a head or a pinned agent the work stays in view, so it just changes.
  const closing = usePresence(showBlocks, COLLAPSE_MS).mounted && !showBlocks;
  const renderBlocks = showBlocks || (closing && !pinned && !hasHead);
  // what shows up while the turn runs, or in the read that finds it just finished (a followed
  // session's last reply often lands together with its completion), arrives animated
  const fresh = running || (turn.completedAt != null && Date.now() - turn.completedAt * 1000 < FRESH_MS);

  // a compaction the user asked for is a turn of its own: just its divider
  if (!running && items.length && items.every((i) => i.type === 'contextCompaction'))
    return (
      <div className={`turn${isLast ? ' last' : ''}`} data-turn-id={turn.id}>
        {items.map((i) => (
          <BlockItem turnId={turn.id} key={i.id} item={i} cwd={cwd} />
        ))}
      </div>
    );

  const content = (
    <div className={`turn${isLast ? ' last' : ''}`} data-turn-id={turn.id}>
      {stamp && (
        <div className="momo-day" role="separator" aria-label={stamp}>
          {stamp}
        </div>
      )}
      {users.map((u) => (
        <Enter key={u.id} id={u.id} running={fresh}>
          {(u as DisplayItem).type === 'statusNote' ? (
            <BlockItem turnId={turn.id} item={u} cwd={cwd} threadId={threadId} readOnly={readOnly} />
          ) : (
            <UserMessage
              item={u as UserMessageItem}
              threadId={threadId}
              turnId={turn.id}
              userIndex={userIndexes.get(u.id)!}
              canEdit={isLast && !running}
            />
          )}
        </Enter>
      ))}

      {/* a running Claude turn has no header: its activity line carries the clock, as in Claude Code */}
      {/* a turn its person stopped says so even with no work to unfold ("You stopped after 4s", as the Codex app does) */}
      {((running && ux !== 'dots') || (!running && (hasWork || youStopped))) && !(momoStopped && !youStopped) && (
        <button
          className={`worked-for ${running ? 'running' : ''} ${expanded ? 'open' : ''}`}
          onClick={() => foldable && setExpanded((e) => !e)}
        >
          <span>
            {(elapsed == null || momoStopped) && !running
              ? momoStopped
                ? 'Stopped'
                : (stopped ?? 'Worked')
              : `${running ? 'Working for' : stopped ? `${stopped} after` : 'Worked for'} ${formatDuration(elapsed) || '0s'}`}
          </span>
          {foldable && (expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />)}
        </button>
      )}

      <Collapse open={showBlocks || pinned || hasHead}>
        <div className="work">
          {chunks.map((c, ci) =>
            c.kind === 'head' ? (
              <Enter key={c.item.id} id={c.item.id} running={fresh}>
                {card && c.item.id === inlinePlan ? (
                  <TurnCardView turnId={turn.id} card={card} cwd={cwd} threadId={threadId} canImplement={false} running={running} />
                ) : hasAsyncQuestions(c.item) ? (
                  c.item.id === dockedQuestion ? null : (
                    <AsyncQuestions
                      questions={c.item.questions}
                      threadId={threadId}
                      cwd={cwd}
                      readOnly={readOnly}
                      submittedAnswers={questionAnswers.get(c.item.id)}
                    />
                  )
                ) : c.item.type === 'statusNote' || c.item.type === 'hookPrompt' ? (
                  <BlockItem turnId={turn.id} item={c.item} cwd={cwd} threadId={threadId} readOnly={readOnly} />
                ) : (
                  <UserMessage
                    item={c.item as UserMessageItem}
                    threadId={threadId}
                    turnId={turn.id}
                    userIndex={userIndexes.get(c.item.id)!}
                    canEdit={false}
                  />
                )}
              </Enter>
            ) : (
              c.blocks.map((b, i) =>
                !renderBlocks && !runsAgent(b) ? null : whole && heldBack(b, running, turn.itemTimes) ? null : b.kind === 'block' ? (
                  b.item.type === 'agentMessage' ? (
                    <BlockItem
                      turnId={turn.id}
                      key={b.item.id}
                      item={b.item}
                      readOnly={readOnly}
                      cwd={cwd}
                      running={fresh && !whole}
                      streaming={!whole && replyIsStreaming(running, turn.itemTimes[b.item.id]?.end)}
                      arrive={whole && fresh}
                    />
                  ) : (
                    <Enter key={b.item.id} id={b.item.id} running={fresh}>
                      <BlockItem turnId={turn.id} item={b.item} cwd={cwd} threadId={threadId} readOnly={readOnly} />
                    </Enter>
                  )
                ) : b.kind === 'sessions' ? (
                  <Enter key={b.rows[0].id} id={b.rows[0].id} running={fresh}>
                    <SessionStack rows={b.rows} threadId={threadId} readOnly={readOnly} />
                  </Enter>
                ) : b.kind === 'poll' ? (
                  <Enter key={b.checks[0].items[0].id} id={b.checks[0].items[0].id} running={fresh}>
                    <TurnTimingContext.Provider value={timing}>
                      <PollRow block={b} cwd={cwd} ux={ux} threadId={threadId} narrationOf={narrationOf} />
                    </TurnTimingContext.Provider>
                  </Enter>
                ) : (
                  <Enter key={b.items[0].id} id={b.items[0].id} running={fresh}>
                    {/* its steps read when each ran ("Thought for 4s") and whether Stop cut them off */}
                    <TurnTimingContext.Provider value={timing}>
                      <StepGroup
                        items={b.items}
                        cwd={cwd}
                        ux={ux}
                        narration={groupNarration.get(b.items[0].id)}
                        elapsedMs={elapsed}
                        active={running && ci === chunks.length - 1 && i === c.blocks.length - 1}
                      />
                    </TurnTimingContext.Provider>
                  </Enter>
                ),
              )
            ),
          )}
          {running &&
            showBlocks &&
            !final &&
            (lastChunk?.kind !== 'work' ||
              lastBlocks.length === 0 ||
              lastBlocks[lastBlocks.length - 1].kind === 'block' ||
              lastBlocks[lastBlocks.length - 1].kind === 'sessions') && (
              // the placeholder waits before it shows (placeholder-reveal), so a quick first token never flashes it;
              // after a step group it takes over from that group's running row, so it shows at once; every harness has
              // the dots line (src/harness/family.ts)
              <ThinkingLine
                ux={ux}
                elapsedMs={elapsed}
                chatId={threadId}
                activity={streamingReply ? 'default' : 'think'}
                reveal={!chunks.some((c) => c.kind === 'work' && c.blocks.some((b) => b.kind !== 'block'))}
              />
            )}
        </div>
      </Collapse>

      {endCard && (
        <TurnCardView turnId={turn.id} card={endCard} cwd={cwd} threadId={threadId} canImplement={isLast && !running} running={running} />
      )}

      {final && !(whole && replyIsStreaming(running, turn.itemTimes[final.id]?.end)) && (
        <div className="assistant-message" data-arrive={whole && fresh ? '' : undefined}>
          <ReplyText
            key={final.id}
            item={final}
            cwd={cwd}
            running={fresh && !whole}
            streaming={!whole && replyIsStreaming(running, turn.itemTimes[final.id]?.end)}
          />
        </div>
      )}

      {/* MoMo's question with its answers: the latest reply's chips, gone once anything follows it */}
      {asking && <OptionChips chatId={threadId} options={chips} />}

      {proposals.length > 0 && <TurnSuggestions calls={proposals} threadId={threadId} readOnly={readOnly} />}

      {turn.error && drawsErrorBox(turn, running) && (
        // the latest turn's error rises into place as it appears; errors in history are simply there
        <Reveal id={`${turn.id}:error`} live={isLast} className="turn-error">
          <AlertTriangle size={15} />
          <div>
            <TurnErrorHelp chatId={threadId} turnId={turn.id} message={turn.error.message} live={isLast && !readOnly} />
            {turn.error.additionalDetails && !isBareRateLimit(turn.error.additionalDetails) && (
              <div className="turn-error-details">{turn.error.additionalDetails}</div>
            )}
            <RequestLogLink chatId={threadId} turn={turn} />
            {isLast && !readOnly && !(auth && isLoginRefused(turn.error.message)) && <FailedTurnRetry chatId={threadId} turnId={turn.id} />}
            {auth?.waiting && waiting && <SignInWaiting text={waiting} onCancel={auth.waiting.cancel} />}
            {auth && !waiting && (
              <div className="turn-error-actions">
                <button className="btn-pill primary" onClick={auth.signIn}>
                  {auth.label}
                </button>
                {auth.recheck && (
                  <button className="btn-pill" onClick={auth.recheck}>
                    Re-check
                  </button>
                )}
              </div>
            )}
          </div>
        </Reveal>
      )}

      {!running && <CompactionLoopNote turn={turn} />}
      {!running && editedFiles.length > 0 && (
        <EditedCard key={cwd} threadId={threadId} turn={turn} items={edits} files={editedFiles} cwd={cwd} />
      )}
      {/* actions belong to a reply; a turn that is only a status note (e.g. a task notification) has none */}
      {!running && final && !asking && (
        <MessageActions
          text={(final as { text: string }).text}
          threadId={threadId}
          turnId={turn.id}
          startedAt={turn.startedAt}
          completedAt={turn.completedAt}
        />
      )}
      {isLast && !running && !readOnly && <RoutineOffer chatId={threadId} />}
      {/* the status line outlives the turn while background tasks or started sessions run: then it is just their counts */}
      {isLast && !running && !readOnly && (
        <InStatusSlot>
          <StatusCounts chatId={threadId} />
        </InStatusSlot>
      )}
    </div>
  );
  return <PullRequestReferenceTime.Provider value={turn.completedAt}>{content}</PullRequestReferenceTime.Provider>;
});
