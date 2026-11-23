// What a Codex turn says on the Host's stream (the items as ACP updates: ./codexItems.mjs): the app-server's notifications and approval requests read as the minimal turn events the protocol turns into frames (host/src/sessions.mjs), and the answer a card's option sends back.

import { turnErrorCode } from '../../shared/host/turnErrorCode.mjs';
import { LINK_OPTIONS, askOf } from './codexAsk.mjs';
import { createItemMapper } from './codexItems.mjs';

/** Approval requests a person can answer over the wire, by the shape of their answer. */
const V2_APPROVALS = new Set(['item/commandExecution/requestApproval', 'item/fileChange/requestApproval']);
const LEGACY_APPROVALS = new Set(['execCommandApproval', 'applyPatchApproval']);
/** Extra permissions (network, folders) a tool asks for: answered with the permissions granted and for how long, not a decision. */
const PERMISSIONS_APPROVAL = 'item/permissions/requestApproval';

/** The options a Codex approval card offers: the ids are the ones a client answers with (`chat.answer` optionId). */
export const APPROVAL_OPTIONS = Object.freeze([
  { optionId: 'allow_once', name: 'Allow', kind: 'allow_once' },
  { optionId: 'allow_always', name: 'Allow for this session', kind: 'allow_always' },
  { optionId: 'reject_once', name: 'Deny', kind: 'reject_once' },
]);

/** Whether the request is an approval this Host can put to a person (a command to run, files to change). @param {string} method */
export const isApproval = (method) => V2_APPROVALS.has(method) || LEGACY_APPROVALS.has(method) || method === PERMISSIONS_APPROVAL;

/**
 * The answer a request takes for the option picked; none (a dismissed card) cancels.
 * @param {string} method the approval request's method
 * @param {string | undefined} optionId
 * @param {unknown} [requested] the permissions a permissions request asked for: what an allow grants
 */
export function approvalAnswer(method, optionId, requested = {}) {
  if (method === PERMISSIONS_APPROVAL) {
    if (optionId === 'allow_once') return { permissions: requested, scope: 'turn' };
    if (optionId === 'allow_always') return { permissions: requested, scope: 'session' };
    // a refusal or a dismissed card grants nothing
    return { permissions: {}, scope: 'turn' };
  }
  const legacy = LEGACY_APPROVALS.has(method);
  if (optionId === 'allow_once') return { decision: legacy ? 'approved' : 'accept' };
  if (optionId === 'allow_always') return { decision: legacy ? 'approved_for_session' : 'acceptForSession' };
  if (optionId === 'reject_once') return { decision: legacy ? 'denied' : 'decline' };
  return { decision: legacy ? 'abort' : 'cancel' };
}

/** How a turn's end reads as a stop reason (the ACP spelling the protocol and the app already know). @param {string | undefined} status */
const stopReasonOf = (status) => (status === 'completed' ? 'end_turn' : status === 'interrupted' ? 'cancelled' : 'error');

/** What the card shows of the request: the command, or the files' reason. @param {any} p @param {string} method */
function toolCallOf(p, method) {
  if (method === PERMISSIONS_APPROVAL)
    return {
      title: String(p.reason ?? 'Additional permissions'),
      kind: 'other',
      ...(typeof p.itemId === 'string' ? { toolCallId: p.itemId } : {}),
    };
  const command = Array.isArray(p.command) ? p.command.join(' ') : p.command;
  // the item the card asks about, so the app can draw the card on its tool call
  const item = typeof p.itemId === 'string' ? { toolCallId: p.itemId } : {};
  if (typeof command === 'string' && command) return { title: command, kind: 'execute', ...item };
  return { title: String(p.reason ?? 'Change files'), kind: 'edit', ...item };
}

/**
 * @param {object} o
 * @param {(threadId: string) => string | null} o.chatOf the chat a Codex thread's events belong to now, or null when no chat of this Host shows it (a helper thread, a sub-agent)
 * @param {(event: object) => void} o.emit the Host's stream
 */
export function createCodexStream({ chatOf, emit }) {
  /** Turns the stream has been told started and not ended: turn id -> chat. @type {Map<string, string>} */
  const open = new Map();
  /** Cards the stream shows: wire request id -> what answers it. @type {Map<string, { id: number | string, method: string, chatId: string, turnId: string | null, permissions?: unknown, ask?: NonNullable<ReturnType<typeof askOf>> }>} */
  const cards = new Map();
  /** Turns that ended, newest last: what the app-server still says of one (a tool's result after a Stop) must not open it again. @type {Set<string>} */
  const ended = new Set();
  const ENDED_KEPT = 200;
  let generation = 0;
  const items = createItemMapper();

  /**
   * Turns the app-server's notification opened that the adapter has not named yet: their start waits for what was asked (#3599). Codex names its turns
   * itself, so only the adapter's own start, which carries the message's text, ties a turn to the message that started it. @type {Set<string>}
   */
  const unnamed = new Set();

  /** @param {string} chatId @param {string} turnId @param {string} [text] what the person wrote, when the message is known @param {boolean} [human] whether a person wrote it @param {any} [user] the original display input */
  function emitStart(chatId, turnId, text, human, user) {
    emit({
      kind: 'turnStart',
      key: chatId,
      turnId,
      ...(human === true ? { human: true } : {}),
      ...(user ? { user } : text === undefined ? {} : { user: { id: `u-${turnId}`, clientId: turnId, content: [{ type: 'text', text }] } }),
    });
  }

  /** A turn heard of from the app-server: it opens now, and its start is told once the adapter names it or the turn says anything (then nobody asked it: the agent's own). @param {string} chatId @param {string} turnId */
  function heard(chatId, turnId) {
    if (open.has(turnId)) return;
    open.set(turnId, chatId);
    unnamed.add(turnId);
  }

  /** The held start goes out before anything else of its turn, with no user message. @param {string} turnId */
  function release(turnId) {
    if (!unnamed.delete(turnId)) return;
    emitStart(/** @type {string} */ (open.get(turnId)), turnId);
  }

  /** The adapter started this turn for a message: its start carries the message's text. @param {string} chatId @param {string} turnId @param {string} [text] @param {boolean} [human] @param {any} [user] */
  function begin(chatId, turnId, text, human, user) {
    // the app-server's reply to `turn/start` can be read after the turn it names has finished (a turn that is over in a few milliseconds): its start went out with the turn's first word, and a second one after the end would leave the chat running for good
    if (ended.has(turnId)) return;
    if (unnamed.delete(turnId)) return emitStart(chatId, turnId, text, human, user);
    if (open.has(turnId)) return;
    open.set(turnId, chatId);
    emitStart(chatId, turnId, text, human, user);
  }

  /** The tokens each open turn's requests have used so far, in ACP's names (the spend counter reads them from the turn's end). @type {Map<string, { inputTokens: number, outputTokens: number, cachedReadTokens: number, totalTokens: number }>} */
  const used = new Map();
  /** Adds one request's usage (`tokenUsage.last`) to its turn. @param {string} turnId @param {any} last */
  function addUsage(turnId, last) {
    const n = (/** @type {unknown} */ v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
    const cached = n(last?.cachedInputTokens);
    const sum = used.get(turnId) ?? { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, totalTokens: 0 };
    // Codex counts cached tokens inside its input tokens; they are priced apart
    sum.inputTokens += Math.max(0, n(last?.inputTokens) - cached);
    sum.cachedReadTokens += cached;
    sum.outputTokens += n(last?.outputTokens);
    sum.totalTokens += n(last?.totalTokens);
    used.set(turnId, sum);
  }

  /** A turn that ended, or whose end came before anything opened it: newest last, kept to a bound. @param {string} turnId */
  function remember(turnId) {
    ended.add(turnId);
    if (ended.size > ENDED_KEPT) ended.delete(/** @type {string} */ (ended.values().next().value));
  }

  /** @param {string} turnId @param {string} stopReason @param {string} [message] @param {unknown} [info] Codex's own word for the failure (`codexErrorInfo`) */
  function finish(turnId, stopReason, message, info) {
    const chatId = open.get(turnId);
    // the end of a turn nothing opened (its start was not heard of): a later naming of it by the adapter must not open it
    if (!chatId) return void remember(turnId);
    release(turnId);
    open.delete(turnId);
    remember(turnId);
    items.forget(turnId);
    // a turn's open cards go with it: nothing is left waiting on an answer
    for (const [requestId, card] of cards)
      if (card.turnId === turnId) {
        cards.delete(requestId);
        emit({ kind: 'permissionCancelled', key: chatId, requestId });
      }
    const code = message === undefined ? undefined : turnErrorCode(info, message);
    const usage = used.get(turnId);
    used.delete(turnId);
    emit({
      kind: 'turnEnd',
      turnId,
      stopReason,
      ...(message === undefined ? {} : { error: { message, ...(code ? { code } : {}) } }),
      ...(usage ? { usage } : {}),
    });
  }

  /** A card answered elsewhere or withdrawn: it is closed for every client. @param {string} requestId */
  function settle(requestId) {
    const card = cards.get(requestId);
    if (!card) return false;
    cards.delete(requestId);
    emit({ kind: 'permissionCancelled', key: card.chatId, requestId });
    return true;
  }

  /**
   * The turn a request's card belongs to (released first, so its start goes out before it): the turn it names, or for a sub-agent's request the chat's turn that runs it; none when no turn is open.
   * @param {any} p @param {string} chatId @param {boolean} fromSubAgent
   */
  function turnOf(p, chatId, fromSubAgent) {
    const turnId = fromSubAgent
      ? ([...open].reverse().find(([, chat]) => chat === chatId)?.[0] ?? null)
      : typeof p.turnId === 'string'
        ? p.turnId
        : null;
    // a card names its turn, or else belongs to the chat's turns still waiting to be told: they start before it
    if (turnId) release(turnId);
    else for (const [id, chat] of open) if (chat === chatId) release(id);
    return turnId;
  }

  return {
    /** The turn ids and chats of the turns still open. */
    openTurns: () => new Map(open),
    /** The card a wire request id names, or undefined. @param {string} requestId */
    card: (requestId) => cards.get(requestId),
    settle,
    /** Take the card out of the books without telling anyone (the caller answers it). @param {string} requestId */
    take(requestId) {
      const card = cards.get(requestId);
      cards.delete(requestId);
      return card;
    },
    /**
     * Put a question the app-server asks (its user-input questions, an MCP server's elicitation) to the person: a form card, or a card that shows a sign-in link. False when this Host cannot ask it.
     * @param {{ id: number | string, method: string, params?: any }} msg
     * @param {string} chatId
     * @param {boolean} [fromSubAgent]
     */
    ask(msg, chatId, fromSubAgent = false) {
      const p = msg.params ?? {};
      const ask = askOf(msg.method, p);
      if (!ask) return false;
      const requestId = `codex-${generation}-${msg.id}`;
      const turnId = turnOf(p, chatId, fromSubAgent);
      cards.set(requestId, { id: msg.id, method: msg.method, chatId, turnId, ask });
      if (ask.form)
        emit({
          kind: 'question',
          key: chatId,
          turnId: turnId ?? undefined,
          question: {
            id: requestId,
            kind: 'question',
            status: 'pending',
            message: ask.said,
            toolCallId: null,
            form: ask.form,
            ...(ask.asked?.length ? { asked: ask.asked } : {}),
            error: null,
          },
        });
      else
        emit({
          kind: 'permission',
          key: chatId,
          requestId,
          turnId: turnId ?? undefined,
          toolCall: { title: `${ask.said} ${ask.link ?? ''}`.trim(), kind: 'other' },
          options: LINK_OPTIONS,
        });
      return true;
    },
    /**
     * Show a card for an approval the app-server asked: the wire request id is returned.
     * @param {{ id: number | string, method: string, params?: any }} msg
     * @param {string} chatId
     * @param {boolean} [fromSubAgent] the request is a sub-agent's: its turn is not one of the chat's, so the card belongs to the chat's turn that runs it
     */
    request(msg, chatId, fromSubAgent = false) {
      const p = msg.params ?? {};
      // ids restart from 0 with each app-server process: the generation keeps a stale client from answering the new process's request
      const requestId = `codex-${generation}-${msg.id}`;
      const turnId = turnOf(p, chatId, fromSubAgent);
      cards.set(requestId, {
        id: msg.id,
        method: msg.method,
        chatId,
        turnId,
        ...(msg.method === PERMISSIONS_APPROVAL ? { permissions: p.permissions ?? {} } : {}),
      });
      emit({
        kind: 'permission',
        key: chatId,
        requestId,
        turnId: turnId ?? undefined,
        toolCall: toolCallOf(p, msg.method),
        options: APPROVAL_OPTIONS,
      });
      return requestId;
    },
    /** A turn the adapter started, with the text of the message that started it: the same stream event as the app-server's own `turn/started`, once. @param {string} chatId @param {string} turnId @param {string} [text] @param {boolean} [human] */
    started: begin,
    /** One notification from the app-server. @param {{ method?: string, params?: any }} msg */
    notification(msg) {
      const p = msg.params ?? {};
      // a request settled elsewhere closes its card whichever thread asked, a sub-agent's included
      if (msg.method === 'serverRequest/resolved') {
        for (const [requestId, card] of cards) if (String(card.id) === String(p.requestId)) settle(requestId);
        return;
      }
      if (!p.threadId) return;
      const chatId = chatOf(p.threadId);
      if (!chatId) return;
      if (msg.method === 'turn/started' && p.turn?.id) return ended.has(p.turn.id) ? undefined : heard(chatId, p.turn.id);
      if (msg.method === 'turn/completed' && p.turn?.id)
        return finish(
          p.turn.id,
          stopReasonOf(p.turn.status),
          // a failed turn says why, or the error the app-server reported just before it
          p.turn.status === 'failed' ? String(p.turn.error?.message ?? items.errorOf(p.turn.id) ?? 'The turn failed.') : undefined,
          p.turn.error?.codexErrorInfo,
        );
      // the turn's items: commands, file changes, tool calls, reasoning, the plan and token usage, as ACP updates
      const lastTurn = () => [...open].reverse().find(([, chat]) => chat === chatId)?.[0];
      if (msg.method === 'thread/tokenUsage/updated') {
        const usedBy = p.turnId ?? lastTurn();
        if (usedBy && !ended.has(usedBy)) addUsage(usedBy, p.tokenUsage?.last);
      }
      for (const { turnId, update } of items.map(String(msg.method), p, lastTurn)) {
        // a turn that ended says nothing more: a tool's result arriving after Stop would open it again and take the next turn's words
        if (ended.has(turnId)) continue;
        // the first thing a turn says can be handled before the adapter's own start reaches here: the start goes first
        if (!open.has(turnId)) begin(chatId, turnId);
        else release(turnId);
        emit({ kind: 'update', turnId, update });
      }
    },
    /** The app-server went away: every open turn ends with the reason, every card closes. @param {string} message */
    exited(message) {
      generation += 1;
      items.reset();
      for (const turnId of [...open.keys()]) finish(turnId, 'error', message);
      // a new process names its turns afresh: nothing it says is a late word of an old one
      ended.clear();
      for (const requestId of [...cards.keys()]) settle(requestId);
    },
  };
}
