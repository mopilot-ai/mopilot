// A chat's live state as main holds it (electron/session/state.cjs), and how a window keeps its copy.
import type { SessionPatch, SessionState } from '../../../shared/model/session';
import { type GoalClock, updateGoalClock } from '../../lib/goalClock';
export type {
  AppControlEntry,
  BackgroundTask,
  BackgroundWork,
  ChromeLinkState,
  ControllerPlanState,
  QueuedMessage,
  QueuedOptions,
  RemoteControlView,
  ScheduledMark,
  SessionPatch,
  SessionState,
  TurnPhase,
} from '../../../shared/model/session';

export type WindowSessionState = SessionState & { goalClock?: GoalClock };

export const EMPTY_SESSION: SessionState = Object.freeze({
  rev: 0,
  turn: 'idle',
  activeTurn: null,
  crashed: null,
  progressAt: null,
  plan: false,
  permission: null,
  goal: null,
  queue: [],
  compaction: null,
  approvals: [],
  questions: [],
  pendingSwitch: null,
  autoRoute: null,
  promptSuggestion: null,
  acp: null,
  modality: null,
  computer: null,
  appControl: null,
  nativeCleanup: null,
  chromeLink: null,
  controllerPlan: null,
  chromeApproval: false,
  routineOffer: null,
  tasks: [],
  backgroundWork: null,
  ultracode: null,
  remoteControl: null,
  runningElsewhere: false,
  scheduled: null,
}) as SessionState;

/** Keep the display clock with the window's copy. Only the harness's goal snapshot crosses the bridge. */
export function withGoalClock(cur: WindowSessionState | undefined, next: WindowSessionState): WindowSessionState {
  const goalClock = updateGoalClock(cur?.goalClock, next.goal);
  return goalClock === next.goalClock ? next : { ...next, goalClock };
}

/**
 * Apply a patch from main to this window's copy. Patches come in rev order: the next rev applies,
 * an old or repeated one is ignored (null), and a skipped rev means a patch was missed ('gap'):
 * the window takes a fresh snapshot.
 */
export function applySessionPatch(cur: WindowSessionState | undefined, p: SessionPatch): WindowSessionState | 'gap' | null {
  if (!cur) return 'gap';
  if (p.rev <= cur.rev) return null;
  if (p.rev !== cur.rev + 1) return 'gap';
  return withGoalClock(cur, { ...cur, ...p.patch, rev: p.rev });
}

/** A snapshot replaces the copy unless the copy is already newer. */
export function takeSnapshot(cur: WindowSessionState | undefined, snap: SessionState): WindowSessionState {
  return cur && cur.rev > snap.rev ? cur : withGoalClock(cur, snap);
}

export const turnBusy = (s: SessionState) => s.turn === 'running' || s.turn === 'awaitingUser';
