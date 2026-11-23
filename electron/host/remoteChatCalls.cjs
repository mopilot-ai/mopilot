// A remote Host's requests about one chat: a message, the first message of a chat, Stop, the answer to a permission card and a permission mode, each carrying the chat's epoch (from the ownership side map) and a key the Host runs once.
const schema = require('../../shared/host/schema.mjs');

/**
 * @param {object} o
 * @param {(method: string, params?: any) => void} o.needs refuses a request the agreed protocol does not allow (an older Host, a missing safety feature, a connection that is down)
 * @param {(method: string, params?: object) => Promise<any>} o.request one request on the connection; resolves the Host's whole reply
 * @param {(chatId: string) => number} o.epochOf the epoch the ownership side map holds for the chat
 * @param {() => string} o.mintKey a new idempotency key; a caller that retries a request passes its own `opts.key`
 * @param {(feature: string) => boolean} o.speaks whether the Host agreed on a feature
 */
function chatCalls({ needs, request, epochOf, mintKey, speaks }) {
  /** Who wrote a message, said only to a Host that carries it: an older one would drop it, and the app then reads its turns as nobody's. @param {{ human?: boolean }} item */
  const originOf = (item) => (item?.human === true && speaks('origin') ? { human: true } : {});
  return {
    async removeChat(chatId, opts) {
      needs('chat.remove');
      return (
        await request(
          'chat.remove',
          schema.parseParams('chat.remove', {
            chatId,
            epoch: opts.epoch,
            key: opts.key,
          }),
        )
      ).result;
    },
    /** Whether the Host agreed on a feature (remoteChats.cjs reads who wrote a turn only from a Host that did). */
    speaks,
    /**
     * A message to the chat, carrying its epoch and a key: the Host runs it once however often it is sent. A caller that retries passes the same `opts.key`.
     * `cwd` is the chat's folder on the Host, which counts only when the Host has no session for the chat yet.
     * @param {string} chatId @param {{ text?: string, cwd?: string, followUp?: 'steer', goal?: boolean, model?: string, effort?: string, attachments?: string[], skills?: string[], images?: string[], files?: { id: string, name: string, rel: string }[], human?: boolean, credential?: { source: string, login?: string } }} item @param {{ key?: string }} [opts]
     */
    async send(chatId, item, opts) {
      needs('chat.send', item);
      const { text, cwd, model, effort, attachments, skills, images, files, followUp, goal } = item ?? {};
      return (
        await request(
          'chat.send',
          schema.parseParams('chat.send', {
            chatId,
            epoch: epochOf(chatId),
            key: opts?.key ?? mintKey(),
            text,
            cwd,
            model,
            effort,
            attachments,
            images,
            files,
            skills,
            // into the turn that is running, where the agent takes it (an older Host drops the word)
            followUp,
            ...(goal === true ? { goal: true } : {}),
            ...originOf(item),
          }),
        )
      ).result;
    },
    /**
     * The first message of a chat that starts on this Host, in its folder. The Host refuses it unless both ends keep a chat's tools apart from the others'
     * (the `isolation` feature), so a chat never starts on a Host that cannot promise that. A retry passes the same `opts.key`.
     * @param {string} chatId @param {{ harness: string, text?: string, cwd?: string, projectId?: string | null, model?: string, effort?: string, permission?: string, planBase?: string, goal?: boolean, images?: string[], files?: { id: string, name: string, rel: string }[], human?: boolean, credential?: { source: string, login?: string }, sideChat?: import('../../shared/host/sideChats.mjs').SideChatStart }} item @param {{ key?: string }} [opts]
     */
    async start(chatId, item, opts) {
      needs('chat.start', item);
      const { harness, text, cwd, projectId, model, effort, permission, planBase, images, files, credential, goal, sideChat } = item;
      return (
        await request(
          'chat.start',
          schema.parseParams('chat.start', {
            chatId,
            epoch: epochOf(chatId),
            key: opts?.key ?? mintKey(),
            harness,
            text,
            cwd,
            projectId,
            model,
            effort,
            permission,
            // with Plan: the mode the person had picked, which Plan keeps as the one its tools run under
            planBase,
            images,
            files,
            credential,
            sideChat,
            ...(goal === true ? { goal: true } : {}),
            ...originOf(item),
          }),
        )
      ).result;
    },
    /** @param {string} chatId @param {unknown} [turnId] @param {{ key?: string }} [opts] */
    async stop(chatId, turnId, opts) {
      needs('chat.stop');
      return (
        await request('chat.stop', schema.parseParams('chat.stop', { chatId, epoch: epochOf(chatId), key: opts?.key ?? mintKey(), turnId }))
      ).result;
    },
    /**
     * The answer to a permission card the Host's harness is waiting on: the card's id and the option picked (none for a card dismissed). Resolves whether the card was still there.
     * @param {{ chatId: string, requestId: string, optionId?: string | null, form?: { action: string, content?: object } | null, key?: string }} p
     */
    async answer(p) {
      needs('chat.answer');
      return (
        await request(
          'chat.answer',
          schema.parseParams('chat.answer', {
            chatId: p?.chatId,
            epoch: epochOf(/** @type {string} */ (p?.chatId)),
            key: p?.key ?? mintKey(),
            requestId: p?.requestId,
            optionId: p?.optionId,
            form: p?.form,
          }),
        )
      ).result;
    },
    /**
     * Move the chat to another agent on its machine: the Host holds the choice and settles it with the chat's next message. It reaches the Host now or fails, as Stop does.
     * @param {string} chatId @param {{ harness: string, model?: string, effort?: string, credential?: { source: string, login?: string } }} pick @param {{ key?: string }} [opts]
     */
    async switchTo(chatId, pick, opts) {
      needs('chat.switch', pick);
      const { harness, model, effort, credential } = pick;
      return (
        await request(
          'chat.switch',
          schema.parseParams('chat.switch', {
            chatId,
            epoch: epochOf(chatId),
            key: opts?.key ?? mintKey(),
            harness,
            model,
            effort,
            credential,
          }),
        )
      ).result;
    },
    /**
     * What the goal bar does to the chat's goal (`chat.goal`): the Host runs it on the chat's agent and answers with the goal. It reaches the Host now or fails, as Stop does.
     * @param {string} chatId @param {{ action: string, human?: boolean, tokens?: number | null, objective?: string }} what @param {{ key?: string }} [opts]
     */
    async goal(chatId, what, opts) {
      needs('chat.goal', what);
      return (
        await request(
          'chat.goal',
          schema.parseParams('chat.goal', { ...what, chatId, epoch: epochOf(chatId), key: opts?.key ?? mintKey() }),
        )
      ).result;
    },
    /**
     * The person's name for the chat, kept on its machine (the agent's own session where it has one) and told to every client that follows the chat. It reaches the Host now or fails, as Stop does.
     * @param {{ chatId?: string, name: string, key?: string }} p
     */
    async rename(p) {
      needs('chat.rename');
      return (
        await request(
          'chat.rename',
          schema.parseParams('chat.rename', {
            chatId: p?.chatId,
            epoch: epochOf(/** @type {string} */ (p?.chatId)),
            key: p?.key ?? mintKey(),
            name: p?.name,
          }),
        )
      ).result;
    },
    /** @param {{ chatId?: string, value: string, key?: string }} p */
    async permit(p) {
      needs('chat.permit');
      return (
        await request(
          'chat.permit',
          schema.parseParams('chat.permit', {
            chatId: p?.chatId,
            epoch: epochOf(/** @type {string} */ (p?.chatId)),
            key: p?.key ?? mintKey(),
            value: p?.value,
          }),
        )
      ).result;
    },
  };
}

module.exports = { chatCalls };
