// The chat state a Host publishes alongside the turn stream.
import { laneChoice } from './hostSwitch.mjs';

/** Background tasks a patch carries, and the longest text of one: the lane is for a glance, not a log. */
const TASKS_MAX = 50;
const TEXT_MAX = 500;

/** The modes a chat's lane may say it is in: the ones `chat.permit` takes (`plan` is the agent's plan mode). */
const MODES = new Set(['default', 'read-only', 'auto-review', 'full-access', 'plan']);
/** The harness ids the wire speaks (shared/host/schema.mjs). */
const HARNESS = /^(codex|claude|acp:[\w.-]{1,64})$/;
const isObject = (/** @type {unknown} */ v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const clip = (/** @type {unknown} */ v) => (typeof v === 'string' && v.length > TEXT_MAX ? v.slice(0, TEXT_MAX) : v);

/** A task or goal with its long strings cut. @param {any} o */
const bounded = (o) => (isObject(o) ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, clip(v)])) : o);

/** Selects the live session fields a Host publishes with the chat. @param {any} change */
export function sessionLaneEvent({ chatId, patch }) {
  const { goal, tasks, plan, promptSuggestion } = patch;
  const fields = {
    ...(goal === undefined ? {} : { goal }),
    ...(tasks === undefined ? {} : { tasks }),
    ...(typeof plan === 'boolean' ? { plan } : {}),
    ...(promptSuggestion === undefined ? {} : { promptSuggestion }),
    ...(Object.hasOwn(patch, 'pendingSwitch') ? { pendingSwitch: laneChoice(patch.pendingSwitch) } : {}),
  };
  return Object.keys(fields).length ? { kind: 'state', chatId, patch: fields } : null;
}

/**
 * The state patch a runtime event makes: `threadName` (the chat was titled; `provisional` is the cut-short title it replaces; `named`: the person chose the name) and `state` (the store's goal, background tasks, the agent the chat runs on or the choice of another one changed).
 * @param {any} e
 * @returns {{ chatId: string, patch: Record<string, unknown> } | null}
 */
export function chatStateOf(e) {
  if (!isObject(e)) return null;
  const chatId = typeof e.chatId === 'string' ? e.chatId : typeof e.key === 'string' ? e.key : null;
  if (!chatId) return null;
  if (e.kind === 'threadName' && typeof e.name === 'string' && e.name.trim())
    return {
      chatId,
      patch: {
        title: {
          name: clip(e.name),
          provisional: typeof e.provisional === 'string' ? clip(e.provisional) : null,
          ...(e.named === true ? { named: true } : {}),
        },
      },
    };
  if (e.kind !== 'state' || !isObject(e.patch)) return null;
  /** @type {Record<string, unknown>} */
  const patch = {};
  if (Object.hasOwn(e.patch, 'goal')) patch.goal = e.patch.goal === null ? null : bounded(e.patch.goal);
  if (Array.isArray(e.patch.tasks)) patch.tasks = e.patch.tasks.slice(-TASKS_MAX).map(bounded);
  if (e.patch.promptSuggestion === null || typeof e.patch.promptSuggestion === 'string') patch.promptSuggestion = e.patch.promptSuggestion;
  // the mode the chat is in and whether its agent is planning, as the Host holds them: what a client shows and compares with before it sends (a client keeps no copy of its own)
  if (typeof e.patch.plan === 'boolean') patch.plan = e.patch.plan;
  if (typeof e.patch.permission === 'string' && MODES.has(e.patch.permission)) patch.permission = e.patch.permission;
  // the agent the chat runs on after a switch, and the agent a held choice moves it to (null: none held): both only ever the wire's harness ids
  if (typeof e.patch.harness === 'string' && HARNESS.test(e.patch.harness)) patch.harness = e.patch.harness;
  if (Object.hasOwn(e.patch, 'pendingSwitch')) {
    const p = e.patch.pendingSwitch;
    if (p === null) patch.pendingSwitch = null;
    else if (isObject(p) && typeof p.harness === 'string' && HARNESS.test(p.harness))
      patch.pendingSwitch = { harness: p.harness, ...(typeof p.model === 'string' && p.model ? { model: clip(p.model) } : {}) };
  }
  return Object.keys(patch).length ? { chatId, patch } : null;
}
