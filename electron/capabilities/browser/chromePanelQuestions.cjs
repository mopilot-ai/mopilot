// Panel questions validate against their native owners; ordinary asynchronous human replies retain delivery receipts to prevent automatic retry duplicates.
const { randomUUID } = require('node:crypto');
const { identityKey } = require('../../../shared/identityKey.mjs');
const { hasAsyncQuestions, submittedAsyncAnswers, sendAsyncAnswers } = require('../../../shared/asyncQuestionAnswers.mjs');
const { acceptSendReceipt } = require('../../../shared/sendReceipt.mjs');
const { validateAcpAnswer } = require('../../../shared/acpForm.mjs');
const { cardOf } = require('./chromePanelCards.cjs');
const { formAnswer } = require('./chromePanelForm.cjs');
const { versionOf } = require('./chromePanelEpoch.cjs');
const { ACP_FORM_CARD: ACP, acpFormCardId } = require('../../../shared/panelCardIds.mjs');
const ASYNC = 'panel:async:';
const actions = { submit: 'accept', decline: 'decline', cancel: 'cancel' };

/** Reconstruct only the already admitted ACP form constraints; the native owner validates the final answer again. */
function acpSchema(form) {
  const properties = Object.fromEntries(
    form.fields.map((f) => {
      const s = {
        type: f.type,
        preciseNumber: f.type === 'number' || f.type === 'integer',
        title: f.title,
        description: f.description,
        ...(Object.hasOwn(f, 'default') ? { default: f.default } : {}),
      };
      if (f.type === 'array')
        Object.assign(s, {
          items: { type: 'string', enum: f.options.map((o) => o.value), enumLabels: f.options.map((o) => o.label) },
          uniqueItems: true,
        });
      else if (f.options) Object.assign(s, { enum: f.options.map((o) => o.value), enumLabels: f.options.map((o) => o.label) });
      const bound =
        f.type === 'string' ? ['minLength', 'maxLength'] : f.type === 'array' ? ['minItems', 'maxItems'] : ['minimum', 'maximum'];
      if (f.min !== null) s[bound[0]] = f.min;
      if (f.max !== null) s[bound[1]] = f.max;
      return [f.key, s];
    }),
  );
  return { type: 'object', properties, required: form.fields.filter((f) => f.required).map((f) => f.key), additionalProperties: false };
}

class PanelQuestions {
  constructor(live, { reachable, agent }) {
    this.live = live;
    this.reachable = reachable;
    this.agent = agent;
    this.caches = new WeakMap();
  }
  cache(chat) {
    const state = this.live.controller.state.get(chat);
    let map = this.caches.get(state);
    if (!map) this.caches.set(state, (map = new Map()));
    return map;
  }
  handles(id) {
    return typeof id === 'string' && (id.startsWith(ACP) || id.startsWith(ASYNC));
  }
  acpRequest(entry) {
    return {
      id: acpFormCardId(entry.view.id),
      method: 'mcpServer/elicitation/request',
      params: { mode: 'form', message: entry.view.message, requestedSchema: acpSchema(entry.view.form) },
    };
  }
  read(chat, turns) {
    // Native turn/tool ids are local to one session, including a chat's earlier harness segments.
    turns = turns.map((turn, ti) =>
      (turn.items ?? []).some(hasAsyncQuestions)
        ? {
            ...turn,
            items: turn.items.map((item, ii) =>
              hasAsyncQuestions(item) ? { ...item, id: JSON.stringify([turn.sourceSession ?? '', turn.id ?? ti, item.id ?? ii]) } : item,
            ),
          }
        : turn,
    );
    const cache = this.cache(chat),
      cards = [];
    const submitted = submittedAsyncAnswers(turns);
    for (const entry of cache.values()) if (submitted.has(entry.itemId)) entry.completed = true;
    turns.forEach((turn, ti) =>
      (turn.items ?? []).forEach((item) => {
        if (!hasAsyncQuestions(item) || submitted.has(item.id)) return;
        const shape = JSON.stringify(item.questions);
        const key = JSON.stringify([turn.id ?? ti, item.id, shape]);
        let entry = cache.get(key);
        if (!entry)
          entry = {
            id: ASYNC + randomUUID(),
            version: randomUUID(),
            itemId: item.id,
            questions: structuredClone(item.questions),
            busy: false,
            delivery: null,
            completed: false,
          };
        cache.set(key, entry);
        if (entry.completed) return;
        const request = {
          id: entry.id,
          method: 'item/tool/requestUserInput',
          params: {
            questions: entry.questions.map((q, i) => ({
              id: String(i),
              question: q.title,
              isOther: true,
              options: q.options?.map((label) => ({ label })),
            })),
          },
        };
        const card = { ...cardOf(request, this.agent(chat)), version: entry.version };
        if (entry.delivery)
          Object.assign(card, {
            title:
              entry.delivery.action === 'queued'
                ? 'Your answers are queued for the next turn'
                : entry.delivery.action === 'held'
                  ? 'Your answers are waiting to be sent'
                  : entry.delivery.action === 'discarded'
                    ? 'These answers were discarded before sending'
                    : 'Your answers were sent',
            detail: entry.delivery.error ?? null,
            choices: [],
            disabled: true,
          });
        if (entry.busy) Object.assign(card, { detail: 'Sending your answers…', disabled: true });
        if (this.live.controller.state.get(chat).runningElsewhere)
          Object.assign(card, { detail: 'Another client is running this chat. Answer after it finishes.', choices: [], disabled: true });
        cards.push(card);
      }),
    );
    for (const q of this.live.controller.state.get(chat).questions) {
      const entry = this.live.acpHost?.questions?.owner(chat, q.id);
      if (!entry || !['pending', 'failed'].includes(entry.view.status)) continue;
      if (!this.live.controller.isCurrentSource(chat, { kind: 'acp', key: entry.chat.key })) {
        this.live.acpHost.questions.retire(entry.chat);
        continue;
      }
      const request = this.acpRequest(entry);
      const card = { ...cardOf(request, q.harness), version: versionOf({}, chat, request, entry) };
      if (entry.view.status === 'failed')
        Object.assign(card, { detail: entry.view.error || 'The answer could not be delivered.', choices: [], disabled: true });
      cards.push(card);
    }
    return cards;
  }
  async answer(chat, id, choice, values, version) {
    if (id.startsWith(ACP)) {
      const questions = this.live.acpHost?.questions;
      const entry = questions?.owner(chat, id.slice(ACP.length));
      if (!entry || entry.view.status !== 'pending' || !Object.hasOwn(actions, choice)) return false;
      const request = this.acpRequest(entry);
      if (versionOf({}, chat, request, entry) !== version) return false;
      if (!this.live.controller.isCurrentSource(chat, { kind: 'acp', key: entry.chat.key })) {
        questions.retire(entry.chat);
        return false;
      }
      const payload = validateAcpAnswer(entry.view.form, { action: actions[choice], ...(choice === 'submit' ? { content: values } : {}) });
      const result = questions.answer(chat, entry.view.id, payload);
      if (result.status !== 'delivered') throw new Error(result.error || 'This question is no longer available.');
      return true;
    }
    let entry = [...this.cache(chat).values()].find((e) => e.id === id && e.version === version);
    if (!entry || entry.busy || entry.delivery || entry.completed || !['submit', 'skip'].includes(choice)) return false;
    const sourceOf = () => {
      const ref = this.live.controller.ref(chat);
      return identityKey(ref.kind, ref.key, ref.id, ref.instance);
    };
    const owner = this.live.controller.state.get(chat),
      source = sourceOf();
    if (this.live.controller.state.get(chat).runningElsewhere)
      throw new Error('Another client is running this chat. Answer after it finishes.');
    entry.busy = true;
    try {
      const history = await this.live.peerRuntime.readHistory(chat);
      if (!this.reachable(chat) || this.live.controller.state.get(chat) !== owner || sourceOf() !== source) return false;
      if (this.live.controller.state.get(chat).runningElsewhere)
        throw new Error('Another client is running this chat. Answer after it finishes.');
      const current = this.read(chat, history.turns);
      if (entry.completed || !current.some((card) => card.id === id && card.version === version)) return false;
      const p = { questions: entry.questions.map((q, i) => ({ id: String(i), question: q.title, isOther: true })) };
      const result = /** @type {{ answers: Record<string, { answers: string[] }> }} */ (
        formAnswer('item/tool/requestUserInput', p, choice, values)
      );
      const answered = Object.fromEntries(
        entry.questions.map((_, i) => [i, choice === 'skip' ? 'Skipped' : result.answers[String(i)].answers.join(', ')]),
      );
      let receipt;
      await sendAsyncAnswers(entry.questions, answered, async (text) => {
        receipt = await this.live.controller.send(chat, { text, attachments: [], opts: { human: true }, followUp: 'steer' }, null, true);
        acceptSendReceipt(receipt);
      });
      entry.delivery = receipt;
      return true;
    } finally {
      entry.busy = false;
    }
  }
}
module.exports = { PanelQuestions, acpSchema };
