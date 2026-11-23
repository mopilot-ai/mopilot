// Chat history, scrolling, approvals, peer messages and composer orchestration.
import { markFollowing, observeBottom, ScrollFollowing } from '../../lib/streamScroll';
import { useEffectOn } from '../../lib/effects';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { get as getState, useStore, toast } from '../../store/core';
import { loadOlderTurns } from '../../store/threads';
import { withChatNotes } from '../../lib/chatMeta';
import { retryOpen, heldHead } from '../../store/chatRetry';
import { ChatCodexQuitActions } from '../harness/codex/QuitActions';

import { AgentChatContext } from '../agents/AgentGroup';
import { asyncAnswersByTurn, dockedAsyncQuestions, submittedAsyncAnswers } from '../../lib/asyncQuestions';
import { turnNarrationPriors } from '../../lib/agentNarration';
import { ArrivalContext } from './arrival';
import { useSageApprovals } from './Approvals';
import { ComposerArea } from './ComposerArea';
import { useDownHarness } from './HarnessDownNotice';
import { SelectionToolbar } from './SelectionToolbar';
import { SideChatIcon, ArrowDown, Spinner } from '../ui/icons';
import { errorText } from '../../lib/ignored';
import { keepNavigation, navigationItems, type NavigationItem } from '../../session/threadNavigation';
import { loadHistoryPage } from '../../session/threadHistory';
import { TurnNavigation } from './TurnNavigation';
import { ComposerPills } from './ComposerPills';
import { PrCount } from './PrCount';
import { goalShown } from './GoalBar';
import { useSessions } from '../../store/session/useSession';
import { PeerContext, PeerMessages } from './PeerMessages';
import type { PeerMessage } from '../../../shared/peerMessages';
import { activityUx } from '../../session/activityUx';
import { currentFamily } from '../../harness/family';
import { TurnView } from './view/TurnView';
import { TurnBox } from './TurnBox';
import { TurnStall } from './TurnStall';
import { NeedsYouStrip } from './NeedsYouStrip';
import { ThreadNotices } from './ThreadNotices';
import { useRunningCalls } from '../tasks/TasksPill';
import type { ThreadRuntime, TurnState } from '../../store/types';
import { keepNotedTurns, type NotedTurns } from './view/notedTurns';
import { KeepAnchor, placeholderProps, useTurnWindow } from './view/turnWindow';
import { useThreadEntries } from './view/threadEntries';
import { WokenTurns } from './view/WokenTurns';
import { useMessageJumps } from './view/messageJumps';
import { ChatFind, useChatFindRequest } from './view/ChatFind';
import { addedTurn, latestMessage, useResponseSpace } from './view/responseSpace';
import { UnfoldedTurns } from './view/keptUnfold';
import { ChatScope } from './ChatScope';
import { StatusSlot } from './statusSlot';
import { WorkingMark } from './workingMark/WorkingMark';
import { isFocusedPane } from '../../store/split';
import { useMomoChat } from '../momo/useMomoChat';
import { liveTurnId } from '../../lib/liveTurn';
export { friendlyError } from './view/friendlyError';
export { linkify } from './view/UserMessage';

/**
 * Memoized, and it reads only the runtime fields it shows: a delta re-renders the transcript, while the composer area and
 * the rail below and beside it re-render only when their own props change.
 */
export const ThreadView = memo(function ThreadView({
  threadId,
  inPane = false,
  readOnly = false,
  composer = true,
  readOnlyNote,
}: {
  threadId: string;
  inPane?: boolean;
  readOnly?: boolean;
  composer?: boolean;
  /** a read-only view's own note (ComposerArea) */
  readOnlyNote?: ReactNode;
}) {
  const [peerMessages, setPeerMessages] = useState<PeerMessage[]>([]);
  const known = useStore((s) => !!s.threads[threadId]);
  const cwd = useStore((s) => s.threads[threadId]?.cwd ?? '');
  const rt = useStore(useShallow((s) => shownRuntime(s.runtime[threadId])));
  const notes = useStore((s) => s.chatNotes[threadId]);
  // while the harness its next message goes to is down, nothing in the transcript can send (its questions, say)
  const harnessDown = useDownHarness(threadId) !== null;
  const turnsReadOnly = readOnly || harnessDown;
  const harnessApproval = useStore((s) => s.pending.some((p) => p.threadId === threadId));
  // MoMo's chat is no side chat (#2279): none of the coding side's empty state
  const momo = useMomoChat(threadId);
  // a pane's view (not the side pane's) says whether it is the focused one: window keys act in that pane alone
  const paneFocused = useStore((s) => (inPane ? undefined : isFocusedPane(s, threadId)));
  const hasApproval = useSageApprovals(threadId).length > 0 || harnessApproval;
  const scrollRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [statusSlot, setStatusSlot] = useState<HTMLDivElement | null>(null);
  const stick = useRef(new ScrollFollowing());
  /** Follow the bottom, or stop: the transcript is marked too, for the browser's scroll anchoring (streamScroll). */
  const follow = useCallback((on: boolean) => {
    stick.current.set(scrollRef.current, on);
    markFollowing(scrollRef.current, on);
    setAtBottom(on);
  }, []);
  const historyLoad = useRef<Promise<void> | null>(null);
  const historyGeneration = useRef(0);
  const [loadingOlder, setLoadingOlder] = useState(false);
  // set once the chat has scrolled to where it opens: from then on, what is on screen decides which turns render
  const [armed, setArmed] = useState(false);
  const currentThreadId = useRef(threadId);
  currentThreadId.current = threadId;

  // account-switch notes from the chat's file, for history loaded from the harness
  const turns = useNotedTurns(rt?.turns, notes);
  // the rail's entries keep their array while a delta changes nothing it shows
  const navigationBefore = useRef<NavigationItem[]>([]);
  const navigation = useMemo(() => (navigationBefore.current = keepNavigation(navigationBefore.current, navigationItems(turns))), [turns]);
  const leftBottom = useCallback(() => setAtBottom(false), []);
  const jumps = useMessageJumps({ scrollRef, turns, follow, onJump: leftBottom });
  const navigationTarget = jumps.target;
  const navigateTo = jumps.navigateTo;
  const space = useResponseSpace(threadId);
  const find = useChatFindRequest(threadId, scrollRef);
  // each turn gets only its own questions' answers, so answering one re-renders that turn alone
  const answersBefore = useRef<ReturnType<typeof asyncAnswersByTurn> | undefined>(undefined);
  const submittedAnswers = useMemo(() => submittedAsyncAnswers(turns), [turns]);
  const questionAnswers = useMemo(
    () => (answersBefore.current = asyncAnswersByTurn(turns, submittedAnswers, answersBefore.current)),
    [turns, submittedAnswers],
  );
  // the latest unanswered questions wait docked above the composer, as Claude Code docks its question card, until answered;
  // a view that can't send leaves them in the transcript
  const docked = useMemo(
    () => (turnsReadOnly || !composer ? null : dockedAsyncQuestions(turns, submittedAnswers)),
    [turns, submittedAnswers, turnsReadOnly, composer],
  );
  // the app bindings Codex's computer-use kernel carries into each turn, so a later `app.click()` names its app
  const narrationPriors = useMemo(() => turnNarrationPriors(turns), [turns]);
  const ux = useStore((s) => activityUx(currentFamily(s.segments[threadId], threadId)));
  // read here, not in each turn: the hook follows the chat's turns, which change with every delta
  const runningCalls = useRunningCalls(threadId);
  const activeTurn = turns.find((t) => t.id === rt?.activeTurnId);
  const liveId = liveTurnId(turns, rt?.activeTurnId);
  // quiet turns no one typed fold into one row: each window slot is a turn, or the first of a folded run
  const { entries, slots, slotOf } = useThreadEntries(turns, liveId);
  // only the turns near the viewport render in full, and the running and last turns, and where a jump goes
  const turnWindow = useTurnWindow({
    scope: threadId,
    scrollRef,
    turns: slots,
    pinned: [slotOf(rt?.activeTurnId), slotOf(turns.at(-1)?.id), slotOf(jumps.turn)],
    armed,
  });
  // the view holds its place unless it follows its bottom, a smooth scroll it started is on its way, or a page of older
  // history is going in (loadHistoryPage keeps the place then, by the page's height and any turn that swapped above)
  const aiming = jumps.aiming;
  const holdAnchor = useCallback(() => stick.current.following || aiming() || historyLoad.current !== null, [aiming]);
  // the chat's goal has its pill above the composer, in every view but a read-only sub-agent thread's
  // the message a refused start left in the queue, which this chat's Retry sends
  const heldId = useSessions((s) => heldHead(s.sessions[threadId]));
  const goalPill = useSessions((s) => !readOnly && goalShown(s.sessions[threadId]?.goal));

  // the view follows the bottom of its column for as long as the column is on screen
  const followColumn = useCallback(
    (column: HTMLDivElement | null) => {
      const el = column?.closest<HTMLElement>('.thread-scroll');
      if (!column || !el) return;
      return observeBottom(
        el,
        column,
        () => stick.current.following && !aiming() && !historyLoad.current,
        () => stick.current.set(el, stick.current.following),
      );
    },
    [aiming],
  );
  // a chat switch, and its history arriving, start again at the bottom
  useEffectOn([threadId, rt?.loaded], () => {
    historyGeneration.current++;
    follow(true);
    jumps.forget();
    historyLoad.current = null;
    setLoadingOlder(false);
    setArmed(false);
    const frame = requestAnimationFrame(() => {
      const el = scrollRef.current;
      if (el && stick.current.following && !aiming() && !historyLoad.current) {
        el.scrollTop = el.scrollHeight;
        stick.current.set(el, stick.current.following);
      }
      setArmed(true);
    });
    return () => {
      cancelAnimationFrame(frame);
      historyLoad.current = null;
      historyGeneration.current++;
    };
  });
  // the turns unfolded in this visit of the chat: kept while they leave the window, not when the chat opens again
  const unfolded = useRef({ chat: threadId, turns: new Set<string>() });
  if (unfolded.current.chat !== threadId) unfolded.current = { chat: threadId, turns: new Set() };
  // what is on screen once the chat has loaded and painted is history; anything after is an arrival
  const arrival = useMemo(() => ({ ready: false, scope: threadId }), [threadId]);
  useEffect(() => {
    if (!rt?.loaded) return;
    const f = requestAnimationFrame(() => (arrival.ready = true));
    return () => cancelAnimationFrame(f);
  }, [arrival, rt?.loaded]);
  // each turn's arrival scope: one object per turn for as long as the chat's arrival lasts, so a turn's context
  // value changes only when the chat or its arrival does
  const turnArrival = useMemo(() => {
    const values = new Map<string, { readonly ready: boolean; scope: string; turn: string }>();
    return (turnId: string) => {
      let value = values.get(turnId);
      if (!value)
        values.set(
          turnId,
          (value = {
            get ready() {
              return arrival.ready;
            },
            scope: threadId,
            turn: turnId,
          }),
        );
      return value;
    };
  }, [arrival, threadId]);

  const requestOlder = useCallback((): Promise<void> => {
    if (historyLoad.current !== null) return historyLoad.current;
    const scroll = scrollRef.current;
    if (!scroll || !getState().runtime[threadId]?.olderCursor) return Promise.resolve();
    const generation = historyGeneration.current;
    follow(false);
    setLoadingOlder(true);
    const operation = loadHistoryPage({
      scroll,
      load: () => loadOlderTurns(threadId),
      afterPaint: () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
      isCurrent: () => scrollRef.current === scroll && currentThreadId.current === threadId && historyGeneration.current === generation,
      target: () => navigationTarget.current,
      navigate: (id) => navigateTo(id, true),
      onError: (error: unknown) => toast(`Couldn't load earlier messages: ${errorText(error)}`, 'error'),
    });
    historyLoad.current = operation;
    void operation.finally(() => {
      if (historyLoad.current === operation) {
        historyLoad.current = null;
        if (scrollRef.current === scroll && currentThreadId.current === threadId && !navigationTarget.current) {
          const bottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 40;
          follow(bottom);
        }
        setLoadingOlder(false);
      }
    });
    return operation;
  }, [threadId, navigateTo, follow, navigationTarget]);

  // a turn added at the end (a send, from any window or harness) goes near the top of the view with room for its reply,
  // which grows there without moving the view, as in Claude and ChatGPT desktop (#1779)
  const seen = useRef({ scope: threadId, turns });
  useLayoutEffect(() => {
    const before = seen.current;
    seen.current = { scope: threadId, turns };
    if (before.scope !== threadId || !arrival.ready) return;
    // the room is only for the turn it placed: a turn removed (a rewind) ends it
    if (turns.length < before.turns.length) return space.clear();
    if (!addedTurn(before.turns, turns)) return;
    const scroll = scrollRef.current!;
    const message = latestMessage(scroll);
    // a turn with no message of its own has nothing to place, and ends the room
    if (!message) return space.clear();
    space.place();
    // far away, it goes there at once rather than scrolling through the whole chat
    const far = message.getBoundingClientRect().top - scroll.getBoundingClientRect().top > 2 * scroll.clientHeight;
    navigateTo(message.dataset.navigationId!, far);
  }, [threadId, turns, arrival, space, navigateTo]);

  const measureFrame = useRef(0);
  useEffect(
    () => () => {
      cancelAnimationFrame(measureFrame.current);
      measureFrame.current = 0;
    },
    [],
  );
  const onScroll = () => {
    const el = scrollRef.current!;
    // the room's layout reads run once per frame, however many scroll events came
    measureFrame.current ||= requestAnimationFrame(() => {
      measureFrame.current = 0;
      space.measure();
    });
    follow(stick.current.scrolled(el) && !navigationTarget.current && !historyLoad.current);
    if (el.scrollTop < 200 && rt?.hasOlder && !navigationTarget.current && !historyLoad.current) void requestOlder();
  };
  const manualScroll = (on: boolean | null = false) => {
    if (on === null) return;
    jumps.forget();
    follow(on && !historyLoad.current);
  };

  if (!known && !rt) return <div className="thread-empty">Loading…</div>;

  return (
    <PeerContext.Provider value={peerMessages}>
      <ChatScope threadId={threadId}>
        <div className="thread-view" data-thread-id={threadId} data-pane-focused={paneFocused}>
          <div className="thread-scroll-wrap">
            <div
              key={threadId}
              className="thread-scroll"
              ref={scrollRef}
              role="region"
              aria-label="Conversation transcript"
              tabIndex={0}
              onScroll={onScroll}
              onScrollEnd={jumps.onScrollEnd}
              onWheel={(event) => manualScroll(stick.current.wheel(event.currentTarget, event))}
              onTouchStart={jumps.forget}
              onPointerDown={jumps.forget}
              onKeyDown={(event) => manualScroll(stick.current.key(event.currentTarget, event))}
            >
              <ArrivalContext.Provider value={arrival}>
                <StatusSlot.Provider value={statusSlot}>
                  <AgentChatContext.Provider value={threadId}>
                    <UnfoldedTurns.Provider value={unfolded.current.turns}>
                      <div className="thread-column" ref={followColumn} data-selection-source={`thread-${threadId}`}>
                        {rt?.hasOlder && (
                          <div className="load-older">
                            <Spinner size={14} />
                          </div>
                        )}
                        {!rt?.loaded && rt?.loading && (
                          <div className="thread-loading">
                            <Spinner size={16} />
                          </div>
                        )}
                        {rt?.error && (
                          <div className="error-banner">
                            <span className="error-banner-text">{rt.error}</span>{' '}
                            <button type="button" className="btn-pill soft" onClick={() => retryOpen(threadId, heldId)}>
                              Retry
                            </button>
                            <ChatCodexQuitActions chatId={threadId} />
                          </div>
                        )}
                        <PeerMessages
                          chatId={threadId}
                          readOnly={readOnly}
                          inPane={inPane}
                          entry={!composer}
                          onMessages={setPeerMessages}
                        />
                        <KeepAnchor scrollRef={scrollRef} mounted={turnWindow.mounted} hold={holdAnchor}>
                          {entries.map((entry, i) => {
                            const t = slots[i];
                            const full = turnWindow.mounted.has(t.id);
                            const last = i === entries.length - 1;
                            const turnView = (turn: TurnState) => (
                              <ArrivalContext.Provider value={turnArrival(turn.id)}>
                                <TurnView
                                  turn={turn}
                                  cwd={cwd}
                                  threadId={threadId}
                                  ux={ux}
                                  isLast={last && entry.kind === 'turn'}
                                  live={turn.id === liveId}
                                  readOnly={turnsReadOnly}
                                  questionAnswers={questionAnswers.get(turn.id)!}
                                  dockedQuestion={last && entry.kind === 'turn' ? docked?.id : undefined}
                                  narration={narrationPriors.get(turn.id)}
                                  runningCalls={runningCalls}
                                />
                              </ArrivalContext.Provider>
                            );
                            return (
                              <div
                                key={`${threadId}\n${entry.kind}\n${t.id}`}
                                className="turn-slot"
                                data-turn-slot={t.id}
                                ref={turnWindow.slotRef(t.id)}
                                {...placeholderProps(t, full, entry.kind !== 'turn', turnWindow.heightOf)}
                              >
                                {full &&
                                  (entry.kind === 'turn' ? (
                                    turnView(t)
                                  ) : (
                                    <WokenTurns entry={entry} renderTurn={turnView} target={jumps.turn} />
                                  ))}
                              </div>
                            );
                          })}
                        </KeepAnchor>
                        {!readOnly && <NeedsYouStrip threadId={threadId} />}
                        {/* the task list: a turn's native plan or the agent's own (update_task_list) */}
                        <TurnBox threadId={threadId} readOnly={readOnly} turns={turns} />
                        {/* One live status row stays below the task list through thinking, tools and agents. */}
                        <div className="turn-status-slot" ref={setStatusSlot} />
                        {/* a stalled turn's banner goes with its status line, under the task list */}
                        <TurnStall threadId={threadId} readOnly={readOnly} />
                        {!readOnly && <PrCount key={threadId} chatId={threadId} />}
                        {!readOnly && <ThreadNotices threadId={threadId} />}
                        <div className="thread-bottom-spacer" />
                        <div className="thread-response-space" ref={space.ref} aria-hidden="true" />
                      </div>
                    </UnfoldedTurns.Provider>
                  </AgentChatContext.Provider>
                </StatusSlot.Provider>
              </ArrivalContext.Provider>
            </div>
            {inPane && !momo && !readOnly && rt?.loaded && turns.length === 0 && !rt.error && (
              <div className="side-chat-empty">
                <span className="side-chat-empty-icon">
                  <SideChatIcon size={29} strokeWidth={1.6} />
                </span>
                <div className="side-chat-empty-text">
                  <div className="side-chat-empty-title">Side chat</div>
                  <div className="side-chat-empty-desc">Side chats are temporary and disappear when you close the app.</div>
                </div>
              </div>
            )}
            {find.focusKey !== null && (
              <ChatFind
                key={`find:${threadId}`}
                turns={turns}
                scrollRef={scrollRef}
                hasOlder={!!rt?.hasOlder}
                loadingOlder={loadingOlder}
                focusKey={find.focusKey}
                onNavigate={navigateTo}
                onLoadOlder={requestOlder}
                onClose={find.close}
              />
            )}
            {/* Sibling keys must differ: a shared key duplicates these overlays when the chat changes. */}
            <TurnNavigation
              key={`navigation:${threadId}`}
              threadId={threadId}
              items={navigation}
              scrollRef={scrollRef}
              inPane={inPane}
              hasOlder={!!rt?.hasOlder}
              loadingOlder={loadingOlder}
              rendered={turnWindow.mounted}
              onLoadOlder={requestOlder}
              onNavigate={navigateTo}
            />
            {!readOnly && !hasApproval && (
              <SelectionToolbar key={`selection:${threadId}`} containerRef={scrollRef} threadId={threadId} inPane={inPane} />
            )}
            <ComposerPills key={`pills:${threadId}`} threadId={threadId} showGoal={goalPill} showInbox={!readOnly} />
            {!atBottom && space.below && (
              <button
                className={`scroll-bottom ${activeTurn ? 'working' : ''} ${goalPill ? 'above-pill' : ''}`}
                onClick={() => {
                  manualScroll();
                  space.clear();
                  follow(true);
                  jumps.toBottom();
                  scrollRef.current!.scrollTo({ top: scrollRef.current!.scrollHeight, behavior: 'smooth' });
                }}
                aria-label="Scroll to bottom"
              >
                {/* while the agent works, the working mark stands in for the arrow until the pointer is on the button */}
                {activeTurn && <WorkingMark activity="default" standalone />}
                <ArrowDown size={16} className="scroll-bottom-arrow" />
              </button>
            )}
          </div>
          <ComposerArea
            threadId={threadId}
            cwd={cwd}
            inPane={inPane}
            readOnly={readOnly}
            composer={composer}
            hasApproval={hasApproval}
            question={docked}
            readOnlyNote={readOnlyNote}
          />
        </div>
      </ChatScope>
    </PeerContext.Provider>
  );
});

/** The runtime fields the view shows; the rest (token usage, a held message, checkpoints…) change without re-rendering it. */
function shownRuntime(rt: ThreadRuntime | undefined) {
  if (!rt) return null;
  const { turns, activeTurnId, loaded, loading, error } = rt;
  return { turns, activeTurnId, loaded, loading, error, hasOlder: !!rt.olderCursor };
}

/** The chat's turns with its saved notes put back; a turn and notes that did not change keep the merged object. */
function useNotedTurns(turns: TurnState[] | undefined, notes: Parameters<typeof withChatNotes>[1]): TurnState[] {
  const cache = useRef<NotedTurns<TurnState, typeof notes>>(new WeakMap());
  return useMemo(() => {
    const raw = turns ?? [];
    return keepNotedTurns(raw, withChatNotes(raw, notes), notes, cache.current);
  }, [turns, notes]);
}

/* ------------------------------------------------------------------ */
/* Turn                                                                */
/* ------------------------------------------------------------------ */
/** A turn that completed this recently still animates what arrives with its completion. */
