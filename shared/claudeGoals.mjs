// Claude Code goals, the part main and the window share. The CLI runs "/goal <condition>" itself:
// it answers "Goal set: <condition>", then keeps working inside one turn, checking the condition with
// a Stop hook each round, until it is met. Its goal state never reaches the SDK stream, so Sage keeps
// its own snapshot from the messages the CLI does send. The CLI has no pause: Sage pauses by stopping
// the loop, clearing the CLI's goal, and remembering the condition to send again on resume.
// The reducer and the plans run in main (electron/harness/claude/adapter.cjs); the goal bar's wording stays
// in src/lib/claudeGoals.ts.

import { contentBlocks } from './contentBlocks.mjs';
import { parseJsonRecord, isJsonRecord } from './jsonRecord.mjs';

/**
 * Rounds a goal may run before Sage pauses it. Subscriptions have no per-round cost, so the cap is
 * off there; an API key pays for every round.
 */
export const CLAUDE_GOAL_ROUND_LIMIT = 30;
/** What "10 more rounds" on a goal that hit the limit allows (the round count restarts on resume). */
export const CLAUDE_GOAL_EXTRA_ROUNDS = 10;
export function claudeGoalRoundLimit(metered) {
  return metered ? CLAUDE_GOAL_ROUND_LIMIT : null;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return contentBlocks(content)
    .filter((b) => b?.type === 'text')
    .map((b) => b.text ?? '')
    .join('\n');
}

/** "/goal" and "/goal clear" print local command output (a system message live, a tagged user record on disk). */
export function claudeLocalOutput(m) {
  if (m?.type === 'system' && m.subtype === 'local_command_output') return String(m.content ?? '');
  if (m?.type === 'user') {
    const r = /^\s*<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/.exec(textOf(m.message?.content));
    if (r) return r[1];
  }
  return null;
}

const firstLine = (s) => s.split('\n')[0].trim();

/** Parse a Claude SDK (or transcript) message into a goal event; null when it says nothing about goals. */
export function parseClaudeGoalMessage(m) {
  if (!m || m.parent_tool_use_id) return null;
  if (m.type === 'assistant') {
    const set = /^\s*Goal set: ([\s\S]+?)\s*$/.exec(textOf(m.message?.content));
    return set ? { kind: 'set', condition: set[1] } : null;
  }
  const out = claudeLocalOutput(m);
  if (out != null) {
    const t = out.trim();
    let r;
    if ((r = /^Goal set: (.+)/.exec(t))) return { kind: 'set', condition: firstLine(r[1]) };
    if ((r = /^Goal active: (.+)/.exec(t))) return { kind: 'active', condition: firstLine(r[1]).replace(/…$/, '') };
    if (/^Goal cleared\b/.test(t)) return { kind: 'cleared' };
    if (/^No goal set\b/.test(t)) return { kind: 'none' };
    return null;
  }
  if (m.type === 'user') {
    const r = /^\s*Stop hook feedback:\s*\n\s*\[([^\n]*?)\]: ([\s\S]*?)\s*$/.exec(textOf(m.message?.content));
    if (r) return { kind: 'check', condition: r[1], reason: r[2] };
  }
  return null;
}

function fresh(chatId, condition, limit, now) {
  return {
    threadId: chatId,
    objective: condition,
    status: 'active',
    tokenBudget: null,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    createdAt: now,
    updatedAt: now,
    claude: { iterations: 0, lastReason: null, limit },
  };
}

/**
 * The chat's goal after a goal event: a new snapshot, null when it is gone, or undefined for no
 * change. A goal Sage is holding (paused) stays as it is when the CLI reports its own goal cleared.
 */
export function reduceClaudeGoal(goal, e, ctx) {
  switch (e.kind) {
    case 'set': {
      // the CLI answering a resume (or "10 more rounds") that Sage just made: the limit it set stays
      const resumed = goal?.status === 'active' && goal.objective === e.condition && goal.claude?.iterations === 0;
      return fresh(ctx.chatId, e.condition, resumed ? goal.claude.limit : ctx.limit, ctx.now);
    }
    case 'check': {
      if (goal && goal.status !== 'active') return undefined; // a round that ran while Sage was pausing it
      const g = goal ?? fresh(ctx.chatId, e.condition, ctx.limit, ctx.now);
      const c = g.claude ?? { iterations: 0, lastReason: null, limit: ctx.limit };
      return { ...g, updatedAt: ctx.now, claude: { ...c, iterations: c.iterations + 1, lastReason: e.reason } };
    }
    case 'active':
      if (goal && goal.objective === e.condition && goal.status === 'active') return undefined;
      if (goal && goal.objective === e.condition && (goal.status === 'paused' || goal.status === 'budgetLimited')) return undefined;
      return fresh(ctx.chatId, e.condition, ctx.limit, ctx.now);
    case 'cleared':
    case 'none':
      return goal && (goal.status === 'active' || goal.status === 'stopped') ? null : undefined;
  }
  return undefined;
}

/**
 * The goal when a turn that ran its loop ends: complete if the transcript's last check says it was
 * met, stopped otherwise (or when the transcript can't be read). Goals Sage paused keep their state.
 */
export function claudeGoalAfterTurn(goal, status, now) {
  if (!goal || goal.status !== 'active') return undefined;
  const met = !!status?.met && (!status.condition || status.condition === goal.objective);
  const c = goal.claude ?? { iterations: 0, lastReason: null, limit: null };
  return { ...goal, status: met ? 'complete' : 'stopped', updatedAt: now, claude: { ...c, lastReason: status?.reason ?? c.lastReason } };
}

/** The goal attachment a decoded transcript record actually carries. */
export function goalStatusAttachment(record) {
  const a = record.attachment;
  return isJsonRecord(a) && a.type === 'goal_status' ? a : null;
}

/** The newest goal_status record in a session transcript (JSONL text). */
export function lastGoalStatus(jsonl) {
  const lines = jsonl.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const parsed = parseJsonRecord(lines[i]);
    if (!parsed.ok) continue;
    const a = goalStatusAttachment(parsed.record);
    if (a)
      return {
        met: !!a.met && (a.condition === undefined || a.condition === null || typeof a.condition === 'string'),
        condition: typeof a.condition === 'string' ? a.condition : undefined,
        reason: typeof a.reason === 'string' ? a.reason : undefined,
      };
  }
  return null;
}

/** Sage pauses a goal once its round count reaches the limit. */
export function claudeGoalOverLimit(goal) {
  const c = goal?.claude;
  return goal?.status === 'active' && c?.limit != null && c.iterations >= c.limit;
}

/**
 * interrupt() leaves the CLI's goal active (the next message would resume it), and a clear sent
 * while the loop runs waits for the loop to end, so pausing stops the loop first, then clears.
 * A step is { kind: 'interrupt' } or { kind: 'send', text }.
 */
export function claudeGoalPausePlan(goal, running) {
  if (goal?.status !== 'active') return [];
  return [...(running ? [{ kind: 'interrupt' }] : []), { kind: 'send', text: '/goal clear' }];
}

const RESUMABLE = ['paused', 'budgetLimited', 'usageLimited', 'stopped'];
export function canResumeClaudeGoal(goal) {
  return !!goal && RESUMABLE.includes(goal.status);
}

/** A goal paused at Sage's round limit can be given CLAUDE_GOAL_EXTRA_ROUNDS more. */
export function canExtendClaudeGoal(goal) {
  return !!goal?.claude && goal.status === 'budgetLimited';
}

/** The goal as "10 more rounds" restarts it: active, the count back at zero, the limit the extra rounds. */
export function claudeGoalExtended(goal, now) {
  return { ...goal, status: 'active', updatedAt: now, claude: { iterations: 0, lastReason: null, limit: CLAUDE_GOAL_EXTRA_ROUNDS } };
}

/**
 * Resume sends the condition again: the CLI starts a new goal, so its round count starts over. After a
 * crash the CLI never got the clear a pause sends, and the reopened session may still hold the old
 * goal, so that goal is cleared first.
 */
export function claudeGoalResumePlan(goal, afterCrash = false) {
  if (!goal || !canResumeClaudeGoal(goal)) return [];
  return [...(afterCrash ? [{ kind: 'send', text: '/goal clear' }] : []), { kind: 'send', text: `/goal ${goal.objective}` }];
}

/**
 * Clearing forgets the condition. The CLI still holds a goal that is active or stopped (and maybe
 * one Sage doesn't know of), so those send "/goal clear"; a paused or complete goal is already gone there.
 */
export function claudeGoalClearPlan(goal, running) {
  if (!goal) return [{ kind: 'send', text: '/goal clear' }];
  const out = [];
  if (running && goal.status === 'active') out.push({ kind: 'interrupt' });
  if (goal.status === 'active' || goal.status === 'stopped') out.push({ kind: 'send', text: '/goal clear' });
  return out;
}

/** The one-line note the transcript shows for a goal message, instead of a reply or a user bubble. */
export function claudeGoalNote(e, raw) {
  switch (e.kind) {
    case 'set':
      return `Goal set: ${e.condition}`;
    case 'check':
      return `Goal not met yet: ${e.reason}`;
    default:
      return (
        (raw ?? '').trim() || (e.kind === 'none' ? 'No goal set' : e.kind === 'cleared' ? 'Goal cleared' : `Goal active: ${e.condition}`)
      );
  }
}
