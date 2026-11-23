// The agent's cursor over a Host's desktop in the pane (G8 #3903): pure state for what main sent (electron/capabilities/hostDesktopCursor.cjs). It plays the plan on the action's own clock (the approach message starts it; the Host's answer presses), never on when a frame arrives, and it is shown only on a frame of the geometry version it was placed by.
import { sampleAt } from '../../shared/cursorMotionPlan.mjs';

export type CursorPlan = {
  samples: { t: number; x: number; y: number; progress: number; state: 'arrow' | 'disc' | 'hidden' }[];
  to: { x: number; y: number };
  pressAtMs: number;
  totalMs: number;
  hideAfterClickMs: number;
};
export type CursorMessage =
  | { kind: 'approach'; id: number; version: number; press: boolean; plan: CursorPlan }
  | { kind: 'dispatched'; id: number }
  | { kind: 'hide'; id: number };
export type CursorState = {
  id: number;
  version: number;
  press: boolean;
  plan: CursorPlan;
  startedAt: number;
  dispatchedAt: number | null;
} | null;
/** Where the cursor is, in the Host display's points, and which shape it has. */
export type CursorView = { x: number; y: number; shape: 'arrow' | 'disc' } | null;

/** How long a click's disc stays waiting for the Host's answer before it goes anyway (phantomCursor.cjs HOLD_CAP_MS). */
export const HOLD_CAP_MS = 1500;

/** One message from main, received at `now` (ms): an approach starts the plan; a newer one replaces it; a message about an action that was replaced is ignored. */
export function reduceCursor(state: CursorState, msg: CursorMessage, now: number): CursorState {
  if (msg.kind === 'approach')
    return { id: msg.id, version: msg.version, press: msg.press, plan: msg.plan, startedAt: now, dispatchedAt: null };
  if (msg.kind === 'dispatched') return state && state.id === msg.id ? { ...state, dispatchedAt: now } : state;
  // id 0: nothing of the agent's shows (the user took over, the turn ended, Stop)
  return msg.id === 0 || state?.id === msg.id ? null : state;
}

/** When the cursor is gone, ms from its start. A click's disc waits for the Host's answer (capped), then goes as the helper's cursor does. */
function endsAt(s: NonNullable<CursorState>): number {
  const p = s.plan;
  if (!s.press) return p.totalMs;
  if (s.dispatchedAt === null) return p.pressAtMs + HOLD_CAP_MS;
  return Math.max(s.dispatchedAt - s.startedAt, p.pressAtMs) + p.hideAfterClickMs;
}

/** The cursor at `now`, on a frame of `frameVersion`; null when it is not shown (no cursor, over, or a frame of another layout). */
export function cursorView(state: CursorState, now: number, frameVersion: number | null): CursorView {
  if (!state || frameVersion !== state.version) return null;
  const t = now - state.startedAt;
  if (t < 0 || t >= endsAt(state)) return null;
  const { plan } = state;
  const at = sampleAt(plan, Math.min(t, plan.pressAtMs));
  const shape = state.press && t >= plan.pressAtMs ? 'disc' : 'arrow';
  return { x: at.x, y: at.y, shape };
}

/** Whether the cursor is over for good at `now` (the loop that draws it can stop). */
export function cursorOver(state: CursorState, now: number): boolean {
  return !state || now - state.startedAt >= endsAt(state);
}
