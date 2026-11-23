// A chat's call to MoPilot's linked-session tools (electron/capabilities/tools/sessions.cjs), read from the tool call
// item whichever harness made it: the line it reads as while it runs and once done, and the session it started or
// proposed, for the thread's session cards.
import { nameOf } from './scheduledTaskCall';
import { toolInvocation } from '../../shared/toolInvocation.mjs';
import { toolOutput } from './toolOutput';

export type SessionToolCall =
  | {
      kind: 'started';
      chatId: string;
      title: string;
      name: string;
      worktree: boolean;
      context: string;
      fallback: string | null;
      error: string | null;
      /** its place in line when it waits for a free slot (1 is next), else 0 */
      queued: number;
    }
  /** taskId null: an offer whose call still waits for the user, found on main's side by its chat and title */
  | { kind: 'proposed'; taskId: string | null; title: string; offer: boolean };

type CallItem = {
  type?: string;
  tool?: unknown;
  server?: unknown;
  status?: string;
  error?: unknown;
  result?: { isError?: boolean } | null;
  arguments?: unknown;
};

const TOOLS = new Set(['start_session', 'hand_off_to_session', 'dismiss_task']);

/** The item as one of MoPilot's session tool calls (its tool name), or null. */
function ownCall(item: unknown): { it: CallItem; tool: string } | null {
  const it = toolInvocation(item) as CallItem | null;
  if (!it || (it.type !== 'mcpToolCall' && it.type !== 'dynamicToolCall')) return null;
  const name = nameOf(it);
  // MoPilot's tool server is sage_<nonce>; another server's tool of the same name is not ours
  if (!name || !TOOLS.has(name.tool) || (name.server && !/^sage(_|$)/i.test(name.server))) return null;
  return { it, tool: name.tool };
}

/** What a session call does, as its line names it. */
export type SessionCallKind = 'start' | 'offer' | 'kept' | 'suggest' | 'handoff' | 'dismiss';

/** Each kind's line while it runs, once done, and when the call failed (Claude Desktop's labels where it has them). */
const LINES: Record<SessionCallKind, { doing: string; done: string; failed: string }> = {
  start: { doing: 'Starting session', done: 'Started session', failed: 'Couldn’t start a session' },
  offer: { doing: 'Offering a new session', done: 'Offered a new session', failed: 'Couldn’t offer a new session' },
  kept: { doing: 'Offering a new session', done: 'Kept in this session', failed: 'Couldn’t offer a new session' },
  suggest: { doing: 'Suggesting task', done: 'Suggested task', failed: 'Couldn’t suggest a task' },
  handoff: { doing: 'Handing off to a new session', done: 'Handed off to a new session', failed: 'Couldn’t hand off' },
  dismiss: { doing: 'Withdrawing suggestion', done: 'Withdrew suggestion', failed: 'Couldn’t withdraw a suggestion' },
};
/** An offer kept here by its countdown: nobody answered the card in time (proposals.cjs goAheadHere). */
const KEPT_UNANSWERED = 'Kept in this session (no answer)';

/** The line one of MoPilot's session calls reads as, running or finished, from what it was asked; else null. */
export function sessionCallLine(item: unknown): { kind: SessionCallKind; text: string; failed: boolean } | null {
  const own = ownCall(item);
  if (!own) return null;
  const { it, tool } = own;
  const args = (it.arguments ?? {}) as { initiation?: unknown; proposal_id?: unknown };
  const kind: SessionCallKind =
    tool === 'dismiss_task'
      ? 'dismiss'
      : tool === 'hand_off_to_session'
        ? 'handoff'
        : args.proposal_id !== undefined
          ? 'start'
          : args.initiation === 'offer'
            ? 'offer'
            : args.initiation === 'own_initiative'
              ? 'suggest'
              : 'start';
  const failed = it.status === 'failed' || !!it.error || it.result?.isError === true;
  // an offer the user answered reads as their answer: kept here, or a session started
  const result = kind === 'offer' && it.status === 'completed' && !failed ? answerOf(it) : null;
  const answered = result?.answer ?? null;
  const line = LINES[answered === 'here' ? 'kept' : answered === 'new_session' ? 'start' : kind];
  // only an answered call is done; a pending or still-running one (any harness's word for it) is still doing it
  const running = !failed && it.status !== undefined && it.status !== 'completed';
  return {
    kind: answered === 'here' ? 'kept' : answered === 'new_session' ? 'start' : kind,
    failed,
    text: failed ? line.failed : running ? line.doing : answered === 'here' && result?.auto ? KEPT_UNANSWERED : line.done,
  };
}

/** The answer an offer's call came back with ("here" or "new_session"), and whether its countdown chose it; or null. */
function answerOf(it: CallItem): { answer: string; auto: boolean } | null {
  try {
    const out = JSON.parse(toolOutput(it).text) as { answer?: unknown; auto?: unknown } | null;
    return typeof out?.answer === 'string' ? { answer: out.answer, auto: out.auto === true } : null;
  } catch {
    return null;
  }
}

/** The started or proposed session an item is, when it is one of MoPilot's session calls that answered; else null. */
export function sessionToolCall(item: unknown): SessionToolCall | null {
  const own = ownCall(item);
  if (!own || own.tool === 'dismiss_task') return null;
  const { it } = own;
  if (it.status !== 'completed' || it.error || it.result?.isError) return null;
  let out: Record<string, unknown>;
  try {
    out = JSON.parse(toolOutput(it).text);
  } catch {
    return null;
  }
  const text = (v: unknown) => (typeof v === 'string' ? v : '');
  if (['proposed', 'briefing', 'started', 'queued', 'waiting', 'held'].includes(String(out?.status)) && typeof out.task_id === 'string')
    return { kind: 'proposed', taskId: out.task_id, title: text(out.title), offer: out.status === 'briefing' || out.kind === 'offer' };
  if (['started', 'not_started', 'queued', 'waiting', 'held'].includes(String(out?.status)) && typeof out.chat_id === 'string')
    return {
      kind: 'started',
      chatId: out.chat_id,
      title: text(out.title),
      name: text(out.name),
      worktree: out.worktree === true,
      context: text(out.context),
      fallback: text(out.context_fallback) || null,
      error: out.status === 'not_started' ? text(out.error) || 'It did not take its brief yet' : null,
      queued: out.status === 'queued' ? Number(out.queue_position) || 1 : 0,
    };
  return null;
}

/**
 * The sessions a turn's calls proposed, in order, each once (a repeated proposal answers with the same task), with an
 * offer whose call still waits for the user's answer by its title.
 */
export function turnProposals(items: readonly unknown[]): Extract<SessionToolCall, { kind: 'proposed' }>[] {
  const seen = new Set<string>();
  const out: Extract<SessionToolCall, { kind: 'proposed' }>[] = [];
  for (const item of items) {
    const call = sessionToolCall(item) ?? waitingOffer(item);
    const key = call?.kind === 'proposed' ? (call.taskId ?? `title:${call.title}`) : null;
    if (call?.kind !== 'proposed' || seen.has(key!)) continue;
    seen.add(key!);
    out.push(call);
  }
  return out;
}

/** An offer whose call is running: its card asks the user while the call waits. */
function waitingOffer(item: unknown): Extract<SessionToolCall, { kind: 'proposed' }> | null {
  item = toolInvocation(item);
  const line = sessionCallLine(item);
  const it = item as CallItem;
  const title = (it?.arguments as { title?: unknown } | null)?.title;
  if (line?.kind !== 'offer' || line.failed || it.status === 'completed' || typeof title !== 'string') return null;
  return { kind: 'proposed', taskId: null, title, offer: true };
}
