// The "working in" stack's state: which desktop apps a turn controls, on MoPilot's desktop tools or a vendor's own computer use, with the current step and how the turn ended.
import { controlStep, controlThumbnail, isMoPilotControl, narrationContexts, type NarrationContext } from './agentNarration';
import { toolInvocation } from '../../shared/toolInvocation.mjs';
import { refusalOf } from './controlRefusal';
import type { RefusedApp } from '../../shared/model/store';

/** MoPilot's own desktop_* / desktop_app_* tools, or a vendor's computer use (Codex's cua_repl, ...). */
export type WorkingPath = 'sage' | 'vendor';
export type WorkingStatus = 'working' | 'done' | 'stopped' | 'failed';

export interface WorkingApp {
  app: string;
  path: WorkingPath;
  /** the latest step in this app, in the tense of the turn: "Pressing ⌘N in TextEdit" while it runs */
  step: string;
  /** the latest screenshot one of its steps returned (a data: URL), if any */
  shot: string | null;
  /** computer use refused the app (MoPilot itself, a blocked app): its name, "Refused", no live view */
  refused?: boolean;
}

export interface WorkingIn {
  turnId: string;
  status: WorkingStatus;
  /** the app acted in last comes first */
  apps: WorkingApp[];
}

export type WorkingEvent =
  | { type: 'start'; turnId: string }
  | { type: 'step'; turnId: string; app: string; path: WorkingPath; step: string; shot?: string | null; refused?: boolean }
  | { type: 'end'; turnId: string; outcome: Exclude<WorkingStatus, 'working'> };

/**
 * The state machine: a turn starts with nothing shown; each desktop step puts its app first with the
 * step text; the end marks every app done, stopped or failed, and that stays until the next turn starts.
 * Events of another turn than the one shown are ignored (a late step of a turn already replaced).
 */
export function reduceWorkingIn(s: WorkingIn | null, e: WorkingEvent): WorkingIn | null {
  if (e.type === 'start') return { turnId: e.turnId, status: 'working', apps: [] };
  if (!s || s.turnId !== e.turnId) return s;
  if (e.type === 'end') return { ...s, status: e.outcome };
  if (s.status !== 'working') return s;
  const key = e.app.toLowerCase();
  const prev = s.apps.find((a) => a.app.toLowerCase() === key);
  const next: WorkingApp = {
    app: e.app,
    path: e.path,
    step: e.step,
    shot: e.shot ?? prev?.shot ?? null,
    ...(e.refused ? { refused: true } : {}),
  };
  return { ...s, apps: [next, ...s.apps.filter((a) => a !== prev)] };
}

/** What the store keeps of a turn (src/store/types.ts TurnState). */
export interface TurnLike {
  id: string;
  status: 'completed' | 'interrupted' | 'failed' | 'inProgress';
  items: unknown[];
}

const OUTCOME: Record<Exclude<TurnLike['status'], 'inProgress'>, Exclude<WorkingStatus, 'working'>> = {
  completed: 'done',
  interrupted: 'stopped',
  failed: 'failed',
};

/**
 * The turn's control calls as events: start, a step per desktop call that names its app (others go to the last app), then the end.
 * Each call names the app its program had bound at that point (`prior`: what earlier turns left bound). An app computer
 * use refused in the turn (`refused`) shows by its name, as refused.
 */
export function workingEvents(turn: TurnLike, prior?: NarrationContext, refused: RefusedApp[] = []): WorkingEvent[] {
  const out: WorkingEvent[] = [{ type: 'start', turnId: turn.id }];
  const contexts = narrationContexts(turn.items, prior);
  const last: { app: string | null; path: WorkingPath | null } = { app: null, path: null };
  for (const [i, raw] of turn.items.entries()) {
    const item = toolInvocation(raw);
    const s = controlStep(item, contexts[i]);
    if (!s || s.surface !== 'desktop') continue;
    const path: WorkingPath = isMoPilotControl(item) ? 'sage' : 'vendor';
    const app = s.app ?? (last.path === path ? last.app : null);
    if (!app) continue;
    Object.assign(last, { app, path });
    // the narration may shorten a bundle id ("code" for ai.mopilot.code): the call's own app argument is matched too
    const named = (item as { arguments?: { app?: unknown } }).arguments?.app;
    const no = refusalOf(app, refused) ?? (typeof named === 'string' ? refusalOf(named, refused) : null);
    if (no) {
      out.push({ type: 'step', turnId: turn.id, app: no.name, path, step: 'Refused', shot: null, refused: true });
      continue;
    }
    const running = (item as { status?: unknown }).status === 'inProgress' && turn.status === 'inProgress';
    out.push({ type: 'step', turnId: turn.id, app, path, step: running ? s.doing : s.done, shot: controlThumbnail(item) });
  }
  if (turn.status !== 'inProgress') out.push({ type: 'end', turnId: turn.id, outcome: OUTCOME[turn.status] });
  return out;
}

/** What the stack shows for a chat's latest turn: null when it controlled no desktop app. */
export function workingInOf(turn: TurnLike | null | undefined, prior?: NarrationContext, refused: RefusedApp[] = []): WorkingIn | null {
  if (!turn) return null;
  const s = workingEvents(turn, prior, refused).reduce<WorkingIn | null>(reduceWorkingIn, null);
  return s?.apps.length ? s : null;
}
