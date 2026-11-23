// Reports a Claude Code chat's turns to the Host's stream. The turn itself belongs to the shared ChatController, which keeps its state in the SessionStore: a turn starts when the store says `running` and ends when it says idle or crashed, so Stop, a queued message and a crash end a turn the same way they do in the app. The rest of the turn comes from the CLI's messages, told as ACP session updates (./claudeAcp.mjs: words, thoughts, tool calls and results, the plan, context used), and a permission request becomes a card the app answers with `chat.answer`.
import { turnErrorCode } from '../../shared/host/turnErrorCode.mjs';
import { parseAcpForm, validateAcpAnswer } from '../../shared/acpForm.mjs';
import { claudeAskedReply, claudeQuestionsOf, withAnswers } from './claudeAsk.mjs';
import { createClaudeAcp, toolKindOf } from './claudeAcp.mjs';
import { steeredEvent } from './steeredEvent.mjs';

/** The answers a plan's card offers (a Claude turn in plan mode asks to leave it with the plan it wrote; the card shows the plan as its input). */
export const PLAN_OPTIONS = [
  { optionId: 'allow', name: 'Approve plan', kind: 'allow_once' },
  { optionId: 'deny', name: 'Keep planning', kind: 'reject_once' },
];

/** The extra answer a card offers when the CLI suggested a permission rule to remember: allow, and keep allowing what the rule names. It reads as the app's own card for a This Mac chat ("Allow for this session": the CLI decides where the rule lands, so "Always" would promise more than the app can). */
export const ALWAYS_ALLOW = { optionId: 'allow_always', name: 'Allow for this session', kind: 'allow_always' };

/** The answers a sign-in link's card offers: the person opened it and came back, or did not. */
export const ELICITATION_LINK_OPTIONS = [
  { optionId: 'done', name: 'I opened it', kind: 'allow_once' },
  { optionId: 'cancel', name: 'Cancel', kind: 'reject_once' },
];

/** The answers a card offers: ACP's `allow_once` / `reject_once`, which the app already draws. */
export const CLAUDE_PERMISSION_OPTIONS = [
  { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
  { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
];

const running = (/** @type {string | undefined} */ turn) => turn === 'running' || turn === 'awaitingUser';
/** A queue item's token is `pending-<item id>` until the harness names the turn; the receipt of `chat.send` carries the bare id. */
const turnIdOf = (/** @type {{ id?: unknown } | null | undefined} */ activeTurn) => String(activeTurn?.id ?? '').replace(/^pending-/, '');

/**
 * @param {object} o
 * @param {{ get: (chatId: string) => { activeTurn?: { id?: unknown } | null } }} o.state the SessionStore whose changes tell when a turn starts and ends
 * @param {(event: object) => void} o.emit the Host's stream
 * @param {() => { ref: (chatId: string) => { kind: string }, chatOf: (key: string) => string, resolveApproval: (id: string) => void } | undefined} o.controller late-bound
 * @param {(requestId: string, result: object) => boolean} o.answer hands a permission result to the CLI that asked; false when that request is gone
 */
/** What a form's answer tells the server: the values the person gave if they fit the form that was asked, else a decline. @param {any} asked @param {any} given */
function formResult(asked, given) {
  try {
    return validateAcpAnswer(asked, given);
  } catch {
    return { action: 'decline' };
  }
}

export function createTurnBridge({ state, emit, controller, answer }) {
  /** chatId -> the turn the stream has been told about. @type {Map<string, { turnId: string, stopped: boolean }>} */
  const open = new Map();
  /** chatId -> why its last start failed, until the turn that ended with it reports it. @type {Map<string, string>} */
  const failures = new Map();
  /** chatId -> the translator of its running turn's messages. @type {Map<string, ReturnType<typeof createClaudeAcp>>} */
  const translators = new Map();
  /** turnId -> the original display input, until its start tells it. @type {Map<string, { text: string, user?: any }>} */
  const users = new Map();
  /** requestId -> the tool call and input a card asks about; an MCP server's ask (`form`: the form it put, `link`: a page to open) answers with an action instead of a tool's allow. @type {Map<string, { chatId: string, input: unknown, form?: any, link?: boolean, questions?: any[], asked?: any[], suggestions?: unknown[] }>} */
  const cards = new Map();

  /**
   * Whether the turn that starts now runs on Claude Code: the other families report their own turns. A turn that starts with a choice of another agent held runs on that agent once the switch settles, though the chat's session is still the old one when the store publishes the start.
   * @param {string} chatId
   */
  function isClaude(chatId) {
    try {
      const held = state.get(chatId).pendingSwitch?.harness;
      return (held ?? controller()?.ref(chatId).kind) === 'claude';
    } catch {
      return false;
    }
  }
  /** @param {string} key */
  const chatOf = (key) => controller()?.chatOf(key) ?? key;

  /** One SDK message of a chat's session, told as the session updates it makes. @param {string} chatId @param {any} m */
  function message(chatId, m) {
    const turn = open.get(chatId);
    const translator = translators.get(chatId);
    if (!turn || !translator) return;
    for (const update of translator.message(m)) emit({ kind: 'update', key: chatId, turnId: turn.turnId, update });
  }

  /**
   * An MCP server asks the person for input through a Claude tool: a form is a question card (the app's own form card, answered with the values), a sign-in link a card that shows it. Nobody to ask (no turn, a form this app cannot draw): the server is told so.
   * @param {string} chatId @param {any} e
   */
  function elicitation(chatId, e) {
    const turn = open.get(chatId);
    const said = e.title ? `${e.title}: ${e.message}` : String(e.message ?? '');
    if (!turn) return void answer(e.requestId, { action: 'cancel' });
    if (e.mode === 'url') {
      cards.set(e.requestId, { chatId, input: null, link: true });
      return emit({
        kind: 'permission',
        key: chatId,
        requestId: e.requestId,
        turnId: turn.turnId,
        toolCall: {
          toolCallId: e.requestId,
          title: `${said} ${e.url ?? ''}`.trim(),
          rawInput: { url: e.url ?? null, server: e.serverName },
        },
        options: ELICITATION_LINK_OPTIONS,
      });
    }
    let form;
    try {
      form = parseAcpForm(e.requestedSchema, said);
    } catch {
      return void answer(e.requestId, { action: 'decline' });
    }
    cards.set(e.requestId, { chatId, input: null, form });
    emit({
      kind: 'question',
      key: chatId,
      turnId: turn.turnId,
      question: { id: e.requestId, kind: 'question', status: 'pending', message: said, toolCallId: null, form, error: null },
    });
  }

  return {
    /** A change the SessionStore published. @param {{ chatId: string, patch: { turn?: string, crashed?: string | null } }} p */
    patched({ chatId, patch }) {
      // a turn this bridge opened is ended by it whichever agent the chat is on when it ends (a switch that did not settle)
      if (!Object.hasOwn(patch, 'turn') || !(open.has(chatId) || isClaude(chatId))) return;
      const turn = open.get(chatId);
      if (running(patch.turn) && !turn) {
        const turnId = turnIdOf(state.get(chatId).activeTurn) || `claude-${chatId}-${Date.now()}`;
        open.set(chatId, { turnId, stopped: false });
        translators.set(chatId, createClaudeAcp());
        // what the person wrote, as the record of the turn's first line; a turn nobody wrote (a goal's own prompt) has none
        const given = users.get(turnId);
        const text = given?.text;
        const started = /** @type {{ human?: boolean } | null | undefined} */ (state.get(chatId).activeTurn);
        users.delete(turnId);
        emit({
          kind: 'turnStart',
          key: chatId,
          turnId,
          // whether a person wrote the message that started it (a goal's own prompt, a scheduled run: no)
          ...(started?.human === true ? { human: true } : {}),
          user: given?.user ?? { id: `u-${turnId}`, clientId: turnId, content: text ? [{ type: 'text', text }] : [] },
        });
      } else if (!running(patch.turn) && turn) {
        // a turn that is open has its translator: both are made at its start
        const { failure, signal, usage, context } = /** @type {ReturnType<typeof createClaudeAcp>} */ (translators.get(chatId)).summary();
        open.delete(chatId);
        translators.delete(chatId);
        // a Stop is a stop whatever the CLI's result says of it; a crash and a start that failed are errors; otherwise the result's own failure
        const reason =
          patch.turn === 'crashed'
            ? (patch.crashed ?? 'The Claude Code session ended.')
            : turn.stopped
              ? null
              : (failures.get(chatId) ?? failure);
        failures.delete(chatId);
        const code = turnErrorCode(signal, failure);
        if (context)
          emit({
            kind: 'update',
            key: chatId,
            turnId: turn.turnId,
            update: { sessionUpdate: 'usage_update', used: context.used, size: context.size },
          });
        emit({
          kind: 'turnEnd',
          key: chatId,
          turnId: turn.turnId,
          stopReason: reason ? 'error' : turn.stopped ? 'cancelled' : 'end_turn',
          // the CLI's own word for the failure names its code; a crash or a failed start has only its message
          ...(reason ? { error: { message: String(reason), ...(reason === failure && code ? { code } : {}) } } : {}),
          ...(usage ? { usage } : {}),
        });
      }
    },

    /** What the person wrote in the message that will start turn `turnId`, for that turn's first line. @param {string} turnId @param {string} text @param {any} [user] the original display input */
    noteUser(turnId, text, user = undefined) {
      users.set(turnId, { text, user });
      // a message that never started a turn leaves its text here: only the newest are kept
      if (users.size > 100) users.delete(/** @type {string} */ (users.keys().next().value));
    },

    /** What the adapter tells its windows (`claude:event`); the Host has none, and keeps what the stream needs of it. @param {any} e */
    adapterEvent(e) {
      if (e?.kind === 'interrupting') {
        const turn = open.get(chatOf(e.key));
        if (turn) turn.stopped = true;
      } else if (e?.kind === 'turnFailed' && typeof e.chatId === 'string')
        failures.set(e.chatId, String(e.error ?? 'The turn did not start.'));
      // a message the CLI took into the turn that is running: told in that turn, as the message it is
      else if (e?.kind === 'steered' && open.has(chatOf(e.key))) {
        const chatId = chatOf(e.key);
        const given = users.get(e.clientId);
        users.delete(e.clientId);
        emit(
          steeredEvent({
            chatId,
            turnId: /** @type {{ turnId: string }} */ (open.get(chatId)).turnId,
            clientId: e.clientId,
            text: e.text,
            user: given?.user,
          }),
        );
      }
      // the chat was titled: told on the stream's state lane
      else if (e?.kind === 'threadName') emit(e);
      return false;
    },

    /** What the Claude harness reports about a session (`claude:event`). @param {any} e */
    harnessEvent(e) {
      if (!e?.key) return;
      const chatId = chatOf(e.key);
      if (e.kind === 'message') return message(chatId, e.msg);
      if (e.kind === 'permission') {
        const turn = open.get(chatId);
        // no turn to show a card in: refuse the call rather than leave the CLI waiting for an answer nobody can give
        if (!turn) return void answer(e.requestId, { behavior: 'deny', message: 'There is no turn to ask the person in.' });
        // the tool that asks the person questions is a form card, not an allow/deny on its input
        const asked = e.toolName === 'AskUserQuestion' ? claudeQuestionsOf(e.input) : null;
        if (asked) {
          cards.set(e.requestId, { chatId, input: e.input, form: asked.form, questions: asked.questions, asked: asked.asked });
          return emit({
            kind: 'question',
            key: chatId,
            turnId: turn.turnId,
            question: {
              id: e.requestId,
              kind: 'question',
              status: 'pending',
              message: asked.said,
              toolCallId: e.toolUseID ?? null,
              form: asked.form,
              ...(asked.asked.length ? { asked: asked.asked } : {}),
              error: null,
            },
          });
        }
        // a rule the CLI suggests remembering is offered as "Allow for this session" (the app's own word for it); a plan (shown in the card's input) is approved or kept planning
        const suggestions = Array.isArray(e.suggestions) && e.suggestions.length ? e.suggestions : undefined;
        const plan = e.toolName === 'ExitPlanMode';
        cards.set(e.requestId, { chatId, input: e.input, suggestions });
        return emit({
          kind: 'permission',
          key: chatId,
          requestId: e.requestId,
          turnId: turn.turnId,
          toolCall: {
            toolCallId: e.toolUseID ?? e.requestId,
            title: plan ? 'Approve this plan?' : (e.title ?? e.displayName ?? e.toolName),
            kind: plan ? 'switch_mode' : toolKindOf(String(e.toolName)),
            // a plan's card shows the plan as the markdown it is, not the tool's input as JSON (the call is answered from the input the bridge keeps)
            rawInput: plan && typeof e.input?.plan === 'string' ? e.input.plan : (e.input ?? null),
          },
          options: plan
            ? PLAN_OPTIONS
            : suggestions
              ? [...CLAUDE_PERMISSION_OPTIONS.slice(0, 1), ALWAYS_ALLOW, ...CLAUDE_PERMISSION_OPTIONS.slice(1)]
              : CLAUDE_PERMISSION_OPTIONS,
        });
      }
      if (e.kind === 'elicitation') return elicitation(chatId, e);
      if (e.kind === 'permissionCancelled' && cards.delete(e.requestId))
        emit({ kind: 'permissionCancelled', key: chatId, requestId: e.requestId });
    },

    /**
     * The app answered a card: `allow` lets the call run, anything else (a card dismissed too) refuses it.
     * @param {{ requestId: string, optionId?: string, form?: { action: string, content?: object } }} p
     * @returns {boolean} false when no card of this family has that id
     */
    permit({ requestId, optionId, form }) {
      const card = cards.get(requestId);
      if (!card) return false;
      cards.delete(requestId);
      if (card.questions) {
        // AskUserQuestion: the values are the tool's answers; anything but a fitting accept refuses the call
        controller()?.resolveApproval(requestId);
        const own = form?.action === 'accept' && card.asked?.length ? claudeAskedReply(card.input, card.asked, form.content) : null;
        if (own) return answer(requestId, own);
        const given = /** @type {{ action: string, content?: any }} */ (formResult(card.form, form));
        return answer(
          requestId,
          given.action === 'accept'
            ? { behavior: 'allow', updatedInput: withAnswers(card.input, card.questions, given.content) }
            : { behavior: 'deny', message: 'The user declined.' },
        );
      }
      if (card.link || card.form) {
        controller()?.resolveApproval(requestId);
        return answer(requestId, card.link ? { action: optionId === 'done' ? 'accept' : 'cancel' } : formResult(card.form, form));
      }
      const result =
        optionId === 'allow_always' && card.suggestions
          ? { behavior: 'allow', updatedInput: card.input, updatedPermissions: card.suggestions }
          : optionId === 'allow'
            ? { behavior: 'allow', updatedInput: card.input }
            : { behavior: 'deny', message: 'The user declined.' };
      controller()?.resolveApproval(requestId);
      return answer(requestId, result);
    },
  };
}
