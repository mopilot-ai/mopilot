// The sessions a turn proposed, as Claude Desktop ends a turn with them: one card after the reply, on any harness. An
// offer (a task the user named) asks "Start this in its own session?" with Do it here / New session beside its title
// and "Don't ask again" in the header; the agent's own suggestions each have Start and a dismiss, and several share a
// header with Start all. Where a row runs is its start options' trigger. A row that starts becomes the session's live
// card; a lone started one is just that card.
import { useFolderHere } from '../../lib/chatMachine';
import { useEffect, useId, useRef, useState } from 'react';
import { giveBackToComposer, sendOrDraft } from '../../store/send';
import { toast, useStore } from '../../store/core';
import { setPrefs } from '../../store/core';
import { native } from '../../lib/native';
import { errorText, ignoring } from '../../lib/ignored';
import { useOrchestration } from '../../lib/sideSessions';
import type { SessionToolCall } from '../../lib/sessionToolCall';
import type { OrchestrationView, SideSessionProposal } from '../../../shared/orchestration';
import { useOfferKeys } from './offerKeys';
import { OfferCountdownNote, useFillTiming } from './OfferCountdown';
import { SessionCard } from './SessionCard';
import { StartOptions, placeOf, startChoice, type StartChoice } from './StartOptions';
import { useWorktreeSupport } from '../../lib/branchList';
import { ChevronDown, X } from '../ui/icons';
import { ShimmerSpan } from '../ui/ShimmerBand';
import { Popover } from '../ui/Popover';
import { openChatFrom } from '../../session/openChat';

type Proposed = Extract<SessionToolCall, { kind: 'proposed' }>;
type Action = 'start' | 'dismiss' | 'here';

/** Rows shown before "Show N more", once there are more than SHOWN + 1. */
const SHOWN = 5;

/** Where a proposal would run, as its row says it (Claude Desktop's checkout labels). */
export const PLACE: Record<SideSessionProposal['place'], string> = {
  fork: 'Fork of this session',
  worktree: 'In a worktree',
  folder: 'In this folder',
};

/** A settled row's words. */
const SETTLED: Record<string, string> = {
  starting: 'Starting…',
  briefing: 'Writing the brief…',
  declined: 'Sent to this session',
  dismissed: 'Dismissed',
  expired: 'Expired',
};

/** A settled "Do it here" its countdown chose for the user, who did not answer. */
const DECLINED_UNANSWERED = 'Sent to this session (no answer)';

/** What a settled row says, on screen and to a screen reader: its status, or "Do it here" chosen for no answer. */
const settledWords = (status: string, autoHere?: boolean) =>
  status === 'declined' && autoHere ? DECLINED_UNANSWERED : (SETTLED[status] ?? status);

/** Claude Desktop's words for a "Do it here" that goes as the user's reply (the call that asked has ended). */
export const herePrompt = (title: string) => `Do this task here: “${title}”`;

/** A late click is the user's real request to fill the reserved session, rather than an automated peer note. */
export const briefPrompt = (taskId: string, title: string) =>
  [
    `Write the brief for the new session I chose: “${title}”.`,
    `Call start_session with proposal_id ${JSON.stringify(taskId)}.`,
    'Include prompt and background; do not do the task here.',
  ].join('\n');

async function requestBrief(threadId: string, taskId: string, title: string): Promise<boolean> {
  const text = briefPrompt(taskId, title);
  try {
    return (await sendOrDraft(threadId, text, { human: true })) !== false;
  } catch (error) {
    giveBackToComposer(threadId, text);
    toast(errorText(error), 'error');
    return false;
  }
}

/** Sends the user's "Do it here" reply for an offer main already took; one the chat did not send gives the offer back. */
async function answerHere(threadId: string, taskId: string, title: string) {
  const reopen = () => native.orchestration.task(taskId, 'reopen');
  let sent: boolean | void;
  try {
    // the user's own answer (human): a turn they began, so the agent may start or offer sessions in it
    sent = await sendOrDraft(threadId, herePrompt(title), { human: true });
  } catch (e) {
    // the send's own failure is what the card says; the offer goes back whatever the reopen answers
    await reopen().catch((r) => toast(errorText(r), 'error'));
    throw e;
  }
  if (sent === false) await reopen();
}

/** The task a row stands for: its own, or (an offer whose call still waits) the chat's waiting offer of that title. */
export function taskOf(call: Proposed, threadId: string, proposals: OrchestrationView['proposals']) {
  if (call.taskId) return call.taskId;
  const found = Object.entries(proposals).find(
    ([, p]) => p.parentId === threadId && p.kind === 'offer' && p.waiting && p.title === call.title,
  );
  return found?.[0] ?? null;
}

/** The user took an offer's card in hand: main stops its countdown to "Do it here", and the card waits for them. */
function holdCountdown(taskId: string) {
  void native.orchestration.task(taskId, 'hold').catch(ignoring('hold an offer’s countdown'));
}

/**
 * Answer a proposal: main takes the answer first (one that expired or started elsewhere is refused, and nothing is
 * sent). An offer whose call still waits gets the answer in that call; otherwise "Do it here" goes out as the user's
 * reply, and a refused one waits in the composer while the offer opens again. Resolves whether it went through.
 */
async function answer(
  threadId: string,
  taskId: string,
  title: string,
  action: Action,
  options: ReturnType<typeof startChoice> = null,
): Promise<boolean> {
  try {
    const r = (await native.orchestration.task(taskId, action, action === 'start' ? options : null)) as
      | { answered?: boolean; status?: string }
      | undefined;
    if (action === 'here' && !r?.answered) await answerHere(threadId, taskId, title);
    if (action === 'start' && r?.status === 'briefing' && !r.answered) return requestBrief(threadId, taskId, title);
    return true;
  } catch (e) {
    toast(errorText(e), 'error');
    return false;
  }
}

function SuggestionRow({
  call,
  threadId,
  readOnly,
  keys,
  noWorktree,
  always,
  onAlways,
}: {
  call: Proposed;
  threadId: string;
  readOnly: boolean;
  /** this row takes the card's keys: the first offer whose call waits (one key answers one offer) */
  keys: boolean;
  /** why the chat's folder can't hold a worktree (worktreeUnsupported); null when it can, undefined while unknown */
  noWorktree: string | null | undefined;
  /** "Don't ask again" was clicked (in the card's header): the row shows its remembered choices */
  always: boolean;
  onAlways: (always: boolean) => void;
}) {
  const view = useOrchestration();
  const taskId = taskOf(call, threadId, view.proposals);
  const proposal = taskId ? view.proposals[taskId] : undefined;
  const foreign = !!proposal && proposal.parentId !== threadId;
  readOnly = readOnly || foreign;
  const status = proposal?.status ?? 'open';
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const parentWorking = useStore((s) => !!s.runtime[threadId]?.activeTurnId);
  const [showPrompt, setShowPrompt] = useState(false);
  // what the user changed before Start: harness and worktree (StartOptions.tsx), shown on Options
  const [showOptions, setShowOptions] = useState(false);
  const optionsAnchor = useRef<HTMLButtonElement>(null);
  const [choice, setChoice] = useState<StartChoice>({ harness: null, useWorktree: null });
  const row = useRef<HTMLDivElement>(null);
  const open = status === 'open' && !busy && !!taskId && proposal?.parentId === threadId;
  const act = async (action: Action) => {
    setBusy(true);
    // reached only while `open`, which needs the task (an offer main has not shown yet has none to answer)
    const ok = await answer(threadId, taskId!, call.title, action, startChoice(choice));
    setFailed(!ok && action === 'start');
    setBusy(false);
  };
  const askForBrief = async () => {
    setBusy(true);
    setFailed(!(await requestBrief(threadId, taskId!, call.title)));
    setBusy(false);
  };
  // an offer whose call waits takes the keyboard as Claude Desktop's does
  useOfferKeys(row, keys && call.offer && open && !readOnly && proposal?.waiting === true, (a) => void act(a));
  // a waiting offer counts down to "Do it here" while main does (OfferCountdown.tsx), wherever it can be answered; it
  // follows main's view alone, so "Don't ask again" hides it only once main took the hold
  const countdown = call.offer && open && !readOnly && proposal?.waiting === true ? (proposal.countdown ?? null) : null;
  const fill = useFillTiming(countdown);
  const countdownId = useId();
  // typing a reply in this chat's composer while it counts takes the card in hand too: the user's message decides,
  // not the countdown. Only a row that counts reads the draft, so the other cards don't render on every key
  const draft = useStore((s) => (countdown ? (s.drafts?.[threadId]?.text ?? '') : ''));
  const draftAtStart = useRef<{ at: number; text: string; held: boolean } | null>(null);
  const countingTo = countdown?.at;
  useEffect(() => {
    if (countingTo === undefined) {
      draftAtStart.current = null;
      return;
    }
    const seen = draftAtStart.current;
    if (seen?.at !== countingTo) draftAtStart.current = { at: countingTo, text: draft, held: false };
    else if (!seen.held && draft !== seen.text) {
      seen.held = true;
      holdCountdown(taskId!);
    }
  }, [countingTo, draft, taskId]);
  const remember = (choice: 'new' | 'here') => {
    setPrefs({ newTaskPrompt: choice });
    onAlways(false);
    void act(choice === 'new' ? 'start' : 'here');
  };
  if (status === 'started' && proposal?.chatId)
    return (
      <div className="suggest-row" data-state="started">
        <SessionCard
          chatId={proposal.chatId}
          parentId={threadId}
          readOnly={readOnly}
          title={proposal.title}
          fallback={PLACE[proposal.place]}
        />
      </div>
    );
  const prompt = proposal?.prompt ?? '';
  const place = proposal ? PLACE[placeOf(proposal.place, noWorktree)] : '';
  // where it runs opens the start options (worktree, harness), so the row needs no button of its own for them
  const placeLabel =
    proposal && status === 'open' && !readOnly ? (
      <button
        ref={optionsAnchor}
        type="button"
        className="suggest-row-place link"
        title="Start options"
        aria-haspopup="dialog"
        aria-expanded={showOptions}
        disabled={!open}
        onClick={() => {
          // choosing where it starts is taking the card in hand: the countdown stops and the card waits
          if (!showOptions && countdown) holdCountdown(taskId!);
          setShowOptions(!showOptions);
        }}
      >
        {place}
        <ChevronDown size={12} aria-hidden />
      </button>
    ) : (
      <span className="suggest-row-place">{place}</span>
    );
  const starting = status === 'starting' || status === 'briefing';
  const answers = status === 'open' && !readOnly && (
    <div className="suggest-row-actions">
      {failed && <span className="suggest-row-failed">Couldn’t start</span>}
      {call.offer ? (
        <>
          <button
            className={countdown ? 'btn-pill soft offer-countdown-fill' : 'btn-pill soft'}
            style={fill}
            aria-describedby={countdown ? countdownId : undefined}
            disabled={!open}
            onClick={() => act('here')}
          >
            Do it here {proposal?.waiting && <kbd>Esc</kbd>}
          </button>
          <button className="btn-pill primary" disabled={!open} onClick={() => act('start')}>
            New session {proposal?.waiting && <kbd>⌘↵</kbd>}
          </button>
        </>
      ) : (
        <button className="btn-pill primary" disabled={!open} onClick={() => act('start')}>
          Start
        </button>
      )}
    </div>
  );
  return (
    <div ref={row} className="suggest-row" data-state={status}>
      <div className="suggest-row-top">
        <div className="suggest-row-text">
          {call.offer || !prompt ? (
            <ShimmerSpan className="suggest-row-title" on={starting}>
              {call.title}
            </ShimmerSpan>
          ) : (
            <button type="button" className="suggest-row-title link" aria-expanded={showPrompt} onClick={() => setShowPrompt(!showPrompt)}>
              {call.title}
            </button>
          )}
          {proposal && (
            <span className="suggest-row-desc">
              {placeLabel}
              {!call.offer && prompt && !showPrompt ? ` · ${prompt.split('\n')[0]}` : ''}
            </span>
          )}
          {showPrompt && <div className="suggest-row-prompt">{prompt}</div>}
          {countdown && <OfferCountdownNote id={countdownId} at={countdown.at} />}
        </div>
        {!always && answers}
        {!call.offer && status === 'open' && !readOnly && (
          <button
            type="button"
            className="icon-btn suggest-row-dismiss"
            aria-label={`Dismiss suggestion ${call.title}`}
            disabled={!open}
            onClick={() => act('dismiss')}
          >
            <X size={14} />
          </button>
        )}
      </div>
      {foreign && (
        <button
          type="button"
          className="side-session-more"
          onClick={(event) => openChatFrom(event, proposal!.parentId, { newWindow: false })}
        >
          Open original session
        </button>
      )}
      {showOptions && proposal && status === 'open' && !readOnly && (
        <Popover anchor={optionsAnchor.current} open onClose={() => setShowOptions(false)} placement="bottom-start">
          <div className="session-start-options-popover" role="dialog" aria-label="Session start options">
            <StartOptions proposal={proposal} choice={choice} onChange={setChoice} noWorktree={noWorktree} />
          </div>
        </Popover>
      )}
      {status !== 'open' ? (
        <div className="suggest-row-status">
          <span className="suggest-row-status-label">{settledWords(status, proposal?.autoHere)}</span>
          {status === 'briefing' && taskId && !readOnly && (failed || !parentWorking) && (
            <button type="button" className="btn-pill soft" disabled={busy} onClick={() => void askForBrief()}>
              Request the brief
            </button>
          )}
          {status === 'briefing' && failed && <span>Your request is kept in the composer.</span>}
        </div>
      ) : (
        always &&
        !readOnly && (
          <div className="suggest-row-actions">
            <button className="btn-pill soft" onClick={() => onAlways(false)}>
              Cancel
            </button>
            <button className="btn-pill soft" disabled={!open} onClick={() => remember('here')}>
              Always do it here
            </button>
            <button className="btn-pill primary" disabled={!open} onClick={() => remember('new')}>
              Always start a new session
            </button>
          </div>
        )
      )}
    </div>
  );
}

/** The header: one offer asks, one suggestion is a new session, several are counted (with how many started). */
function headline(calls: Proposed[], started: number) {
  if (calls.length > 1) return { text: `${calls.length} suggested tasks`, started };
  return { text: calls[0].offer ? 'Start this in its own session?' : 'New session', started: 0 };
}

/** The sessions a turn proposed, after its reply, each once. */
export function TurnSuggestions({
  calls,
  threadId,
  readOnly = false,
}: {
  calls: Proposed[];
  threadId: string;
  /** a chat shown read-only: its proposals show what became of them, with nothing to click */
  readOnly?: boolean;
}) {
  const view = useOrchestration();
  const [all, setAll] = useState(false);
  const [starting, setStarting] = useState(false);
  // a lone offer's "Don't ask again" (in the header) turns its row's answers into the choices to remember
  const [always, setAlways] = useState(false);
  const rows = calls.map((call) => {
    const taskId = taskOf(call, threadId, view.proposals);
    return { call, taskId, proposal: taskId ? view.proposals[taskId] : undefined };
  });
  // a screen reader hears each row's change, as Claude Desktop announces "{title}: {status}"
  const [heard, setHeard] = useState('');
  const seen = useRef(new Map<string, string>());
  const statuses = rows.map((r) => `${r.call.title}\n${r.proposal?.status ?? 'open'}\n${r.proposal?.autoHere ? 1 : 0}`).join('\n\n');
  useEffect(() => {
    for (const entry of statuses.split('\n\n')) {
      const [title, status, auto] = entry.split('\n');
      const before = seen.current.get(title);
      seen.current.set(title, status + auto);
      if (before && before !== status + auto)
        setHeard(`${title}: ${status === 'started' ? 'Started' : settledWords(status, auto === '1')}`);
    }
  }, [statuses]);
  // whether the chat's folder can hold a worktree, read only while a row could start in one: where it can't, a row
  // says it runs in the folder, where main starts it (spawn.cjs makeChild)
  // the worktree check is git on this Mac's folder: a chat on a machine has none here
  const folder = useStore((s) => s.threads[threadId]?.cwd ?? null);
  const here = useFolderHere(threadId, folder ?? '');
  const cwd = here || null;
  const choosing =
    !readOnly && rows.some((r) => r.proposal?.parentId === threadId && r.proposal.status === 'open' && r.proposal.place !== 'fork');
  const noWorktree = useWorktreeSupport(cwd, choosing);
  const lone = rows.length === 1 ? rows[0].proposal : undefined;
  if (lone?.status === 'started' && lone.chatId)
    return <SessionCard chatId={lone.chatId} parentId={threadId} readOnly={readOnly} title={lone.title} fallback={PLACE[lone.place]} />;
  const started = rows.filter((r) => r.proposal?.status === 'started').length;
  const startable = rows.filter((r) => !r.call.offer && r.taskId && r.proposal?.parentId === threadId && r.proposal.status === 'open');
  const startAll = async () => {
    setStarting(true);
    // all at once: main starts clicked proposals side by side (entrypoints.cjs act), so each row shows Starting… now
    await Promise.all(startable.map((r) => answer(threadId, r.taskId!, r.call.title, 'start')));
    setStarting(false);
  };
  const head = headline(calls, started);
  const keyed =
    rows.find((r) => r.call.offer && r.proposal?.parentId === threadId && r.proposal.waiting && r.proposal.status === 'open')?.taskId ??
    null;
  const shown = rows.length > SHOWN + 1 && !all ? rows.slice(0, SHOWN) : rows;
  const loneOffer = rows.length === 1 && rows[0].call.offer && lone?.parentId === threadId && lone.status === 'open' && !readOnly;
  return (
    <div
      className="session-suggestions"
      role="group"
      aria-label={calls.length === 1 ? '1 suggested task' : `${calls.length} suggested tasks`}
    >
      <div className="suggest-card">
        <div className="suggest-head">
          <span className="suggest-head-text">{head.text}</span>
          {head.started > 0 && <span className="suggest-head-started">{head.started} started</span>}
          {startable.length > 1 && !readOnly && (
            <button className="btn-pill soft suggest-start-all" disabled={starting} onClick={() => void startAll()}>
              Start all
            </button>
          )}
          {loneOffer && !always && (
            <button
              type="button"
              className="suggest-head-link"
              onClick={() => {
                setAlways(true);
                // choosing what to remember is taking the card in hand: its countdown stops
                if (lone?.countdown) holdCountdown(rows[0].taskId!);
              }}
            >
              Don’t ask again
            </button>
          )}
        </div>
        {shown.map((r) => (
          <SuggestionRow
            key={JSON.stringify([threadId, r.call.taskId ?? `title:${r.call.title}`])}
            call={r.call}
            threadId={threadId}
            readOnly={readOnly}
            keys={!!keyed && r.taskId === keyed}
            noWorktree={noWorktree}
            always={loneOffer && always}
            onAlways={setAlways}
          />
        ))}
        {rows.length > SHOWN + 1 && (
          <button type="button" className="suggest-more" onClick={() => setAll(!all)}>
            {all ? 'Show fewer' : `Show ${rows.length - SHOWN} more`}
          </button>
        )}
      </div>
      <span className="sr-only" aria-live="polite">
        {heard}
      </span>
    </div>
  );
}
