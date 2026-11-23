// ACP session-form ownership and snapshots; questions never enter permission or turn-blocking state.
const { noteIgnored } = require('../../ignored.cjs');
const { randomUUID } = require('node:crypto');
const { parseAcpForm, validateAcpAnswer } = require('../../../shared/acpForm.mjs');
const { askedAnswers } = require('../../../shared/hostAsked.mjs');
const { RpcError } = require('./rpc.cjs');
const { validId } = require('./incoming.cjs');
const CANCELLED = { code: -32800, message: 'Question cancelled' };

/** The answer to a question the machine's agent asked in the card's own words (shared/hostAsked.mjs): the card's answers by question, or a decline; anything else is not an answer. @param {{ id: string }[]} asked @param {any} answer */
function askedEncoding(asked, answer) {
  if (answer?.action === 'decline' || answer?.action === 'cancel') return { action: answer.action };
  const answers = answer?.action === 'accept' ? askedAnswers(asked, answer.content) : null;
  if (!answers) throw new Error('Not an answer to these questions');
  return { action: 'accept', content: { answers } };
}

class AcpQuestions {
  constructor(host) {
    this.host = host;
    this.entries = new Map();
  }
  open(agent, params, context) {
    if (params?.mode !== 'form') throw new RpcError(-32602, 'Only form elicitation is supported');
    if (!context) throw new RpcError(-32602, 'Missing request owner');
    // Global/request-scoped interactions have no trusted chat destination in this bounded slice.
    if (params.requestId != null) {
      if (params.sessionId != null || !validId(params.requestId)) throw new RpcError(-32602, 'Invalid question scope');
      throw new RpcError(-32800, 'Request-scoped questions are not supported');
    }
    const chat = this.host.chatOf(agent, params.sessionId);
    if (!chat || this.host.chats.get(chat.key) !== chat || chat.loading || agent.authenticating)
      throw new RpcError(-32800, 'Question session is unavailable');
    if (
      typeof params.message !== 'string' ||
      (params.toolCallId != null && (typeof params.toolCallId !== 'string' || params.toolCallId.length > 512))
    )
      throw new RpcError(-32602, 'Invalid tool context');
    let form;
    try {
      form = parseAcpForm(params.requestedSchema, params.message);
    } catch {
      throw new RpcError(-32602, 'Unsupported form: check its schema and use a separate secure flow for credentials');
    }
    const owned = [...this.entries.values()].filter((e) => e.chat === chat);
    // Retain terminal snapshots for all windows, bounded independently from pending questions.
    for (const entry of owned.filter((e) => e.view.status !== 'pending')) this.entries.delete(entry.view.id);
    if (owned.filter((e) => e.view.status === 'pending').length >= 24 || this.entries.size >= 128)
      throw new RpcError(-32800, 'Too many pending questions');
    const entry = {
      chat,
      context,
      view: {
        id: randomUUID(),
        kind: 'question',
        status: 'pending',
        harness: this.host.label(chat.harness),
        message: params.message,
        toolCallId: params.toolCallId ?? null,
        form,
        error: null,
      },
    };
    const result = context.defer(() => this.cancel(entry));
    this.entries.set(entry.view.id, entry);
    if (!this.publish(entry)) this.cancel(entry);
    return result;
  }
  /**
   * A question a chat on another machine's agent asks (electron/host/remoteChats.cjs): the machine owns the answer, so the entry sends it there instead of writing to a local agent, and a send that fails says so on the question.
   * @param {{ chatId: string, label: string, view: { id: string, [k: string]: unknown }, send: (answer: object) => Promise<boolean> }} o
   */
  openRemote({ chatId, label, view, send }) {
    if (!view || typeof view.id !== 'string' || this.entries.has(view.id)) return;
    const chat = { key: chatId, chatId, remote: true };
    const entry = {
      chat,
      remote: true,
      context: {
        respond: (/** @type {any} */ answer) => {
          if (!answer) return { status: 'written' };
          const settle = (/** @type {object} */ patch) => {
            entry.view = { ...entry.view, ...patch };
            this.publish(entry);
          };
          // the machine's Host says whether it had the card and gave the agent the answer: that is the receipt an agent's own session cannot give
          send(answer).then(
            (took) => settle(took ? { status: 'answered' } : { status: 'retired', error: 'This question is no longer available.' }),
            // a card drawn as the app's own question card comes back to be answered again, as every card does; a form stays failed
            () => {
              const view = /** @type {{ asked?: unknown[], retried?: number }} */ (entry.view);
              settle(
                view.asked?.length
                  ? { status: 'pending', error: 'The machine could not be reached. Ask again.', retried: (view.retried ?? 0) + 1 }
                  : { status: 'failed', error: 'The machine could not be reached. Ask again.' },
              );
            },
          );
          return { status: 'written' };
        },
      },
      view: { ...view, harness: label, status: 'pending', error: null },
    };
    this.entries.set(view.id, entry);
    if (!this.publish(entry)) this.entries.delete(view.id);
  }
  /** The machine closed a question (answered elsewhere, or its turn ended): it is cancelled here without a reply. @param {string} id */
  closeRemote(id) {
    const entry = this.entries.get(id);
    if (!entry?.remote || entry.view.status !== 'pending') return;
    entry.view.status = 'cancelled';
    this.publish(entry);
  }
  publish(entry) {
    try {
      this.host.emitEvent({ key: entry.chat.key, kind: 'question', question: entry.view, questions: this.snapshot(entry.chat) });
      return true;
    } catch (error) {
      noteIgnored('publish an ACP question', error);
      return false;
    }
  }
  snapshot(chat) {
    return [...this.entries.values()].filter((e) => e.chat === chat).map((e) => structuredClone(e.view));
  }
  owner(chatId, id) {
    const entry = this.entries.get(id);
    return entry?.chat.chatId === chatId ? entry : null;
  }
  answer(chatId, id, answer) {
    const entry = this.owner(chatId, id);
    if (!entry) return { status: 'retired' };
    if (entry.view.status !== 'pending') return { status: entry.view.status };
    if (!entry.remote && this.host.chats.get(entry.chat.key) !== entry.chat) {
      this.cancel(entry);
      return { status: 'retired' };
    }
    let encoded;
    try {
      encoded = entry.view.asked?.length ? askedEncoding(entry.view.asked, answer) : validateAcpAnswer(entry.view.form, answer);
    } catch {
      return { status: 'pending', error: 'Check the required fields and allowed values.' };
    }
    // Claim before any write or publication; reentrant and duplicate-window submissions cannot both win.
    entry.view.status = 'sending';
    const result = entry.context.respond(encoded);
    entry.view = { ...entry.view, ...result, action: encoded.action };
    this.publish(entry);
    return result;
  }
  cancel(entry) {
    if (entry.view.status !== 'pending') return;
    entry.view.status = 'cancelled';
    const result = entry.context.respond(null, CANCELLED);
    if (result.status === 'failed') entry.view.error = result.error;
    this.publish(entry);
  }
  retire(chat) {
    for (const entry of this.entries.values())
      if (entry.chat === chat) {
        this.cancel(entry);
        this.entries.delete(entry.view.id);
      }
  }
  retireAgent(agent) {
    for (const chat of this.host.chats.values()) if (chat.agent === agent) this.retire(chat);
  }
}
module.exports = { AcpQuestions };
