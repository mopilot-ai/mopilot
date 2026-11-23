// What a Calendar or Reminders connect says to the user (#2528), shared by Settings › MoMo › Sources, Routines and the chat's connect card: one short line per case, "Allow in the window that opens" while macOS's own prompt is up, "Waiting for you to turn it on…" while the privacy pane is open and main waits for the switch (electron/momo/sources/ipc.cjs), and a notice when a connect ended without a grant.
import type { MomoSource, MomoSourceGrant, MomoSourceId } from '../../lib/native/contracts/momoSources';
import { errorText } from '../../lib/ignored';
import { native } from '../../lib/native';

/** While macOS's Allow prompt is up. */
export const ALLOW_LINE = 'Allow in the window that opens';

/** What `momoSources.connect` answered. */
export type ConnectAnswer = {
  connected: boolean;
  grant: MomoSourceGrant;
  asked?: boolean;
  waiting?: boolean;
  /** macOS answered the request without showing its prompt (still not decided), after main cleared the helper's record once if it could */
  noPrompt?: boolean;
  reset?: boolean;
  /** what the macOS request itself reported, for the log; never shown */
  requestError?: string;
};

/** How long a connect runs before its row says "Allow in the window that opens": macOS answers a repeated refusal at once, and only a prompt waits. */
export const ASK_LINE_DELAY_MS = 600;

/** A line under the row; `privacy` also sends the user to macOS's privacy pane, for a refusal the pane can still fix (denied or write-only: those have an entry to switch). */
export type ConnectNotice = { text: string; privacy?: boolean };

/** What a connect says when macOS never showed its prompt, even after main cleared the helper's record: the pane has nothing to switch. */
export const NO_PROMPT_LINE = (label: string) =>
  `macOS didn't show its ${label} prompt. Restart MoPilot and Connect again; if it still doesn't appear, update MoPilot.`;

/** The notice for a connect that ended without connecting; null when it needs none (the pane is open, or it connected). */
export function connectNotice(r: ConnectAnswer, label: string): ConnectNotice | null {
  if (r.connected || r.waiting) return null;
  switch (r.grant) {
    case 'granted':
      return { text: 'Connecting was cancelled.' };
    case 'unavailable':
      return { text: `${label} can't be read on this computer.` };
    case 'restricted':
      return { text: `A setting on this Mac blocks ${label}.` };
    case 'writeOnly':
      return { text: `${label} needs full access, not only adding.`, privacy: true };
    case 'denied':
      // the user answered macOS's prompt just now: the next Connect opens the switch
      return r.asked
        ? { text: `${label} wasn't allowed. Connect again to turn it on.` }
        : { text: `${label} is off for MoPilot.`, privacy: true };
    default:
      // not decided: macOS has no record to switch, so the privacy pane has no entry for MoPilot and is no way out
      return { text: r.noPrompt ? NO_PROMPT_LINE(label) : "macOS didn't ask. Connect to try again." };
  }
}

/**
 * Opens macOS's privacy pane for a source and says what to show when it did not open: null when it did. Main answers a refusal
 * as `{ ok: false, error }`, which the bridge resolves and never throws, so a caller that only catches would show nothing.
 */
export async function openPrivacyPane(id: MomoSourceId): Promise<string | null> {
  try {
    const r = await native.momoSources.openPrivacy(id);
    return r.ok ? null : r.error;
  } catch (e) {
    return errorText(e);
  }
}

/** Where a Calendar or Reminders row stands, which decides its line, its button and its look (Settings' Sources rows, Routines and the chat's connect card). */
export type RowPhase = 'idle' | 'asking' | 'needs' | 'waiting' | 'stalled' | 'lost' | 'connected';

/**
 * The phase of one row. `off`: macOS turned the access down or never showed its prompt, so the switch is the way; `watching`:
 * main has the pane open and finishes the connect when the switch goes on; `sawWatching`: a wait for this row has run, and when
 * `watching` is false again without a connect it ended (3 minutes passed, or it was cancelled). `lost`: MoMo has it connected
 * but macOS refuses its reads (the grant was reset, or another build of the app asked), so Connect asks macOS again.
 */
export function rowPhase(o: {
  connected: boolean;
  asking: boolean;
  off: boolean;
  watching: boolean;
  sawWatching: boolean;
  lost?: boolean;
}): RowPhase {
  if (o.connected) return 'connected';
  if (o.watching) return 'waiting';
  if (o.off) return o.sawWatching ? 'stalled' : 'needs';
  if (o.asking) return 'asking';
  return o.lost ? 'lost' : 'idle';
}

/** Whether a source is connected in MoMo but macOS refuses its reads (main's list says so: `needsGrant`). */
export const needsGrant = (s: MomoSource | null | undefined) => s?.connected === true && s.needsGrant === true;

/** The pane's name in System Settings › Privacy & Security, for the line that sends the user there. */
const paneName = (id: MomoSourceId) => (id === 'reminders' ? 'Reminders' : 'Calendars');

/** What a row in the needs-OK phase says: where to go and what to turn on. */
export const needsLine = (id: MomoSourceId) => `Turn on MoPilot under Privacy & Security › ${paneName(id)}.`;
/** What a row says when MoMo has it connected but macOS no longer allows it. */
export const lostLine = (id: MomoSourceId) => `MoPilot lost access to ${id === 'reminders' ? 'Reminders' : 'Calendar'}. Allow it again.`;
/** What a row says while main waits for the switch. */
export const WAITING_LINE = 'Waiting for you to turn it on…';
/** What a row says when the wait ended and the access is still off. */
export const stalledLine = (id: MomoSourceId) => `Still off. Turn on MoPilot under Privacy & Security › ${paneName(id)}, then come back.`;
/** The label of the row's badge in the needs-OK and stalled phases. */
export const NEEDS_BADGE = 'Needs your OK';

/** What one row shows for its phase: the line, how it looks, the badge and whether it spins. */
export type RowLine = { desc: string; tone?: 'error' | 'needs'; badge?: string; waiting: boolean };

/**
 * The line a Calendar or Reminders row shows, shared by Settings, Routines and the connect card in a chat: a failure (`problem`)
 * wins in red; the needs-OK phases say where to turn it on; asking says macOS's prompt is up; otherwise `idle` (what the
 * source is for) or, once connected, `idle` as well.
 */
export function rowLine(o: { id: MomoSourceId; phase: RowPhase; problem: string | null; idle: string }): RowLine {
  const { id, phase, problem, idle } = o;
  if (phase === 'connected') return { desc: idle, waiting: false };
  if (phase === 'lost') return { desc: problem ?? lostLine(id), tone: problem ? 'error' : 'needs', badge: NEEDS_BADGE, waiting: false };
  if (phase === 'needs' || phase === 'waiting' || phase === 'stalled') {
    const waitingNow = phase === 'waiting';
    return {
      desc: problem ?? (waitingNow ? WAITING_LINE : phase === 'stalled' ? stalledLine(id) : needsLine(id)),
      tone: problem ? 'error' : 'needs',
      ...(!waitingNow && { badge: NEEDS_BADGE }),
      waiting: waitingNow && !problem,
    };
  }
  return {
    desc: problem ?? (phase === 'asking' ? ALLOW_LINE : idle),
    ...(problem && { tone: 'error' as const }),
    waiting: phase === 'asking' && !problem,
  };
}
