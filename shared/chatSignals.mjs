// Two signals a harness can give about a chat that the Chrome side panel shows above its composer, read from each harness's own
// words into one shape: a refusal (the harness's safety filter paused the chat) and a limit warning (a usage window is nearly
// used up, while the chat still runs). Pure; each harness's adapter calls the reader of its own protocol (docs/chrome-panel-parity/design.md, rows 12-13).

/** What the chat says when a harness refused and gave no words of its own. */
export const REFUSAL_TEXT = 'The harness paused this chat: its safety filters flagged the request.';

/** Codex's turn errors (`codexErrorInfo`) that mean the model's policy refused the turn: not a transport or quota failure. */
const CODEX_REFUSALS = new Set(['cyberPolicy', 'misalignmentPolicyViolation']);

/**
 * A Claude Code assistant message that ends on the API's stop reason `refusal` (the SDK's SDKAssistantMessage; its streamed partial frames carry a
 * null stop reason). One a fallback model then retries is retracted by the `model_refusal_fallback` notice (ClaudeFailures.system).
 * @param {any} m
 */
export const isClaudeRefusal = (m) => m?.type === 'assistant' && m.message?.stop_reason === 'refusal';

/** The SDK's structured counterpart of that frame: the model refused and no fallback model retried the request (`model_refusal_no_fallback`). @param {any} m */
export const isClaudeRefusalNotice = (m) => m?.type === 'system' && m.subtype === 'model_refusal_no_fallback';

/**
 * The note a Codex turn refused by policy leaves in the chat (a `statusNote` of kind `refusal`, as every harness writes one), or
 * null when the turn did not end on a refusal.
 * @param {{ id?: string, error?: any } | null | undefined} turn the app-server's turn
 * @returns {{ type: 'statusNote', id: string, kind: 'refusal', text: string } | null}
 */
export function codexRefusalNote(turn) {
  const info = turn?.error?.codexErrorInfo;
  if (typeof info !== 'string' || !CODEX_REFUSALS.has(info) || typeof turn?.id !== 'string') return null;
  const message = typeof turn.error.message === 'string' ? turn.error.message.trim() : '';
  return { type: 'statusNote', id: `refusal-${turn.id}`, kind: 'refusal', text: message || REFUSAL_TEXT };
}

/** @typedef {'5h' | '7d'} LimitWindow the window a warning is about: five hours, a week (extra usage is no plan window: Claude has no approaching words for it, and claudeRateLimit.mjs counts it as no limit to show) */
/** @typedef {{ kind: 'approaching', window: LimitWindow, resetsAt: number | null, utilization?: number }} LimitWarning resetsAt in ms; utilization a fraction (0 to 1) */

/** Claude Code's rate limit types (`rateLimitType`) as a window; its per-model weekly windows are weekly windows. */
const CLAUDE_WINDOWS = Object.assign(Object.create(null), {
  five_hour: '5h',
  seven_day: '7d',
  seven_day_opus: '7d',
  seven_day_sonnet: '7d',
});

/**
 * The window a Claude Code `rate_limit_info` is about, whatever its status; null for one the banner has no words for (extra usage, a window the CLI does not name).
 * @param {any} info
 * @returns {LimitWindow | null}
 */
export const claudeWarningWindow = (info) => CLAUDE_WINDOWS[String(info?.rateLimitType)] ?? null;

const finite = (/** @type {unknown} */ v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const secondsToMs = (/** @type {unknown} */ s) => (typeof s === 'number' && Number.isFinite(s) && s > 0 ? Math.round(s * 1000) : null);
const fraction = (/** @type {unknown} */ v) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : undefined);

/**
 * Whether a warning still holds: a window that has reset (its time is past) is no longer nearly used up. A warning that names
 * no reset time holds until the harness says otherwise.
 * @param {LimitWarning | null | undefined} warning
 * @param {number} now ms
 */
export const warningHolds = (warning, now) => !!warning && (warning.resetsAt === null || warning.resetsAt > now);

/**
 * What a Claude Code `rate_limit_event`'s `rate_limit_info` says: a warning for the window it names when the CLI reports
 * `allowed_warning`; null for `allowed` or `rejected` (a refusal is the limit itself, not an approach to it), for a window the CLI
 * does not name, and for one that has already reset.
 * @param {any} info
 * @param {number} now ms
 * @returns {LimitWarning | null}
 */
export function claudeLimitWarning(info, now) {
  if (info?.status !== 'allowed_warning') return null;
  const window = claudeWarningWindow(info);
  if (!window) return null;
  const utilization = fraction(info.utilization);
  const warning = {
    kind: /** @type {const} */ ('approaching'),
    window,
    resetsAt: secondsToMs(info.resetsAt),
    ...(utilization === undefined ? {} : { utilization }),
  };
  return warningHolds(warning, now) ? warning : null;
}

/**
 * Codex has no warning status: a window is "approaching" from this used percent until it is used up. 75 is the lowest of the Codex CLI's warning steps (75, 90, 95) as
 * recalled, not read from a Codex source: change it here, it is the only place.
 */
export const CODEX_WARN_AT = 75;

/** @param {{ windowDurationMins?: unknown } | null | undefined} w @param {'5h' | '7d'} slot the window's usual place: Codex sends the short one first */
const codexWindowOf = (w, slot) => {
  const mins = finite(w?.windowDurationMins);
  if (mins === null) return slot;
  return mins <= 360 ? '5h' : mins >= 7 * 24 * 60 ? '7d' : null;
};

/**
 * The warning Codex's rate limits say (`account/rateLimits/updated`'s snapshot, or the windows kept from its sparse updates): the
 * most used window at or past CODEX_WARN_AT and not yet used up, whose reset has not passed. Null when no window is, and when a
 * window is used up (the limit itself, not an approach to it).
 * @param {{ primary?: any, secondary?: any } | null | undefined} windows
 * @param {number} now ms
 * @returns {LimitWarning | null}
 */
export function codexLimitWarning(windows, now) {
  /** @type {LimitWarning | null} */
  let best = null;
  let bestUsed = 0;
  for (const [w, slot] of /** @type {const} */ ([
    [windows?.primary, '5h'],
    [windows?.secondary, '7d'],
  ])) {
    const used = finite(w?.usedPercent);
    if (used === null) continue;
    const window = codexWindowOf(w, slot);
    const warning = window && {
      kind: /** @type {const} */ ('approaching'),
      window,
      resetsAt: secondsToMs(w.resetsAt),
      utilization: fraction(used / 100),
    };
    if (!warning || !warningHolds(warning, now)) continue;
    // used up: the limit itself, whatever other window is close
    if (used >= 100) return null;
    if (used >= CODEX_WARN_AT && used > bestUsed) {
      best = warning;
      bestUsed = used;
    }
  }
  return best;
}

/**
 * The window a Claude Code `rate_limit_info` says is used up (`rejected`) and when it resets, or null for any other status. Extra usage and windows the CLI
 * does not name have no window words: they are still a limit, said without a window.
 * @param {any} info
 * @param {number} now ms
 * @returns {{ window: LimitWindow | null, resetsAt: number | null } | null}
 */
export function claudeLimitReached(info, now) {
  if (info?.status !== 'rejected') return null;
  const window = claudeWarningWindow(info);
  const resetsAt = secondsToMs(info.resetsAt);
  return { window, resetsAt: window && resetsAt !== null && resetsAt > now ? resetsAt : null };
}

/**
 * The window Codex's rate limits say is used up (100% or more) and when it resets: the one that resets last when both are, since the chat can run again
 * only then. Null when no window is used up (the turn's limit came from elsewhere); a reset already past is not named.
 * @param {{ primary?: any, secondary?: any } | null | undefined} windows
 * @param {number} now ms
 * @returns {{ window: LimitWindow | null, resetsAt: number | null } | null}
 */
export function codexLimitReached(windows, now) {
  /** @type {{ window: LimitWindow | null, resetsAt: number | null } | null} */
  let out = null;
  for (const [w, slot] of /** @type {const} */ ([
    [windows?.primary, '5h'],
    [windows?.secondary, '7d'],
  ])) {
    const used = finite(w?.usedPercent);
    if (used === null || used < 100) continue;
    const resetsAt = secondsToMs(w.resetsAt);
    const next = { window: codexWindowOf(w, slot), resetsAt: resetsAt !== null && resetsAt > now ? resetsAt : null };
    if (!out || (next.resetsAt ?? 0) > (out.resetsAt ?? 0)) out = next;
  }
  return out;
}
