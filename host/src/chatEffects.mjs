// Host chat effects own first-message preparation, private attachment resolution, stable client input identity and durable user records; the protocol owns authentication, epochs and dedupe.
import { SchemaError } from '../../shared/host/schema.mjs';
import { hostImageUrl } from '../../shared/host/images.mjs';
import { UnsupportedError } from './errors.mjs';
import { harnessOfChat } from './chatCredentials.mjs';
import { HostRefusal } from './hostFs.mjs';
import { sideChatParentChanged } from './nativeSideChat.mjs';
export const pickedOf = (p) => ({ ...(p.model ? { model: p.model } : {}), ...(p.effort ? { effort: p.effort } : {}) });

const CLAUDE_ID = /^claude:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** @typedef {Pick<ReturnType<typeof import('./chatCredentials.mjs').createChatCredentials>, 'admit' | 'check' | 'ready' | 'forget' | 'sideChatChoice' | 'sideChatOrgIdentity'>} ChatCredentials */

/** @param {{ credentials?: ChatCredentials | null, [k: string]: any }} o */
export function createChatEffects({
  runtime,
  handoffs,
  finish,
  record,
  endedTurns,
  images,
  tools,
  check,
  faults,
  approvals,
  credentials = null,
  existingFolder = /** @type {((folder: string) => Promise<string>) | undefined} */ (undefined),
  assertAlive = /** @type {((chatId: string) => void) | undefined} */ (undefined),
}) {
  // a chat's settled switch is a typed item of its journal (from, to, the divider's words, the turn it belongs to): every client mirrors it, and one that does not know it skips it.
  // A Claude Code turn opens before its switch settles, the others after: the item names the turn that is open now, else the next one to start
  /** @type {Map<string, string>} */
  const opened = new Map();
  /** @type {Map<string, object>} */
  const moved = new Map();
  /** The chat each open turn belongs to: an end names its turn, and not always its chat. @type {Map<string, string>} */
  const chatOfTurn = new Map();
  runtime.host?.on?.('event', (/** @type {any} */ e) => {
    if (typeof e?.turnId !== 'string') return;
    if (e.kind === 'turnEnd') return void (opened.delete(/** @type {string} */ (chatOfTurn.get(e.turnId))), chatOfTurn.delete(e.turnId));
    if (e.kind !== 'turnStart' || typeof e.key !== 'string') return;
    chatOfTurn.set(e.turnId, e.key);
    opened.set(e.key, e.turnId);
    const note = moved.get(e.key);
    if (note) finish(e.key, { t: 'switch', ...note, turnId: e.turnId }), moved.delete(e.key);
  });
  runtime.onSwitched?.((chatId, note) => {
    const turnId = opened.get(chatId);
    if (turnId) finish(chatId, { t: 'switch', ...note, turnId });
    else moved.set(chatId, note);
  });
  const dispatchCheck = (p) =>
    assertAlive
      ? () => {
          p.checkImages?.();
          assertAlive(p.chatId);
        }
      : p.checkImages;
  /** @param {string} cwd refuses a folder that is gone with the sentence a chat on this Mac gets (electron/session/chatFolderGuard.cjs); any other fault of the path keeps the Host's own words. */
  const folderThere = async (cwd) => {
    try {
      await existingFolder?.(cwd);
    } catch (error) {
      if (/** @type {any} */ (error)?.code !== 'directory_missing') throw error;
      throw new HostRefusal(
        'directory_missing',
        `This chat's folder no longer exists on this host: ${JSON.stringify(cwd)}. Restore the folder, or continue in a new chat.`,
      );
    }
  };
  /** The handlers of the chat methods, after the request was parsed, gated and (for a change) admitted. @type {Record<string, (p: any) => Promise<unknown> | unknown>} */
  const effects = {
    async 'chat.send'(p) {
      check(p.chatId, p.text);
      // the folder the chat runs in is still on this machine: said before anything is taken or started, as the app's own chats say it, where the agent would fail with an unrelated error of its own
      if (existingFolder && typeof p.cwd === 'string') await folderThere(p.cwd);
      // a chat continued here starts with the handoff in front of its first message; the transcript keeps the user's own words
      const handoff = handoffs?.take(p.chatId) ?? null;
      // and on the agent it was continued on, whatever its id spells (a chat switched to another agent keeps the id it began with)
      if (handoff?.harness)
        await runtime.bindContinued?.({
          chatId: p.chatId,
          harness: handoff.harness,
          cwd: p.cwd ?? handoff.cwd,
          text: handoff.text,
          id: handoff.id,
        });
      // a chat that chose its credential runs on it or is refused, never on another
      // (the agent it runs on, or the one a held choice is about to move it to: the id's own spelling is only where it began)
      if (credentials) {
        const now = runtime.switchState?.(p.chatId);
        const agent = now?.pending ?? now?.harness ?? harnessOfChat(p.chatId);
        // what a chat began on is only kept once the machine's sign-in state is known
        await credentials.ready(agent, p.chatId);
        credentials.check(p.chatId, agent);
      }
      faults.clear(p.chatId);
      p.checkImages?.();
      // a chat paused for want of an answer tells its agent, once, that the action was not run
      const notice = approvals.resume(p.chatId) ?? null;
      const prefix = [notice, handoff?.text, p.sideContext].filter(Boolean).join('\n\n');
      if (p.images?.length && !images) throw new UnsupportedError('This Host cannot receive images yet. Update it.');
      if (p.files?.length && !images) throw new UnsupportedError('This Host cannot receive files yet. Update it.');
      const attachments = [
        ...(p.images?.length ? await images.attachments(p.imageOwner, p.chatId, p.images, p.checkImages) : []),
        // staged on this Host: Codex is told the path in its turn input (electron/harness/codexParams.cjs)
        ...(p.files?.length
          ? (await images.files(p.imageOwner, p.chatId, p.key, p.files, p.checkImages)).map((f) => ({ ...f, staged: true }))
          : []),
      ];
      dispatchCheck(p)?.();
      const cwd = p.cwd ?? handoff?.cwd;
      // the folder a message works in, for whoever keeps a record of each turn's folder (./methods/gitTurnDiff.mjs)
      runtime.host?.emit?.('sending', { key: p.chatId, cwd });
      const pick = pickedOf(p);
      const sent = await runtime.send({
        key: p.chatId,
        text: p.text,
        clientId: p.key,
        ...(dispatchCheck(p) ? { check: dispatchCheck(p) } : {}),
        ...(attachments.length ? { attachments } : {}),
        // the handoff goes in front as the prefix it is on this Mac: the CLI's own origin drops, the turn stays a person's
        ...(prefix ? { prefix } : {}),
        ...(cwd ? { cwd } : {}),
        ...(Object.keys(pick).length > 0 ? { pick } : {}),
        // only what the app said: a message nobody said a person wrote is not a person's
        ...(p.human === true ? { human: true } : {}),
        ...(p.followUp === 'steer' ? { followUp: 'steer' } : {}),
        // the message sets the chat's goal: its text is the objective
        ...(p.goal === true ? { goal: true } : {}),
      });
      try {
        if (handoff) {
          handoffs?.done(p.chatId);
          // the record the chat arrived with stays in its stream, so a later continue hands the whole conversation over, not only what happened here
          finish(p.chatId, { t: 'handoff', turnId: sent.turnId, text: handoff.text });
        }
        const user = {
          id: `u-${p.key}`,
          clientId: p.key,
          content: [
            ...(p.text ? [{ type: 'text', text: p.text, text_elements: [] }] : []),
            ...(p.images ?? []).map((id) => ({ type: 'image', url: hostImageUrl(id) })),
            // a file or folder shows by name, never by the private folder it was kept in
            ...[...new Set((p.files ?? []).map((f) => f.name))].map((name) => ({ type: 'mention', name })),
          ],
        };
        finish(p.chatId, {
          t: 'user',
          turnId: sent.turnId,
          text: p.text,
          user,
          messageKey: p.key,
          ...(p.by ? { by: p.by } : {}),
        });
      } catch (error) {
        faults.fail(p.chatId, error);
        return { ...sent, journalError: 'session_journal_write_failed' };
      }
      return sent;
    },
    'chat.stop': async (p) => {
      // the turn the person's button showed has ended (a queued message started another meanwhile): nothing to stop, and the next turn is not theirs to stop
      if (p.turnId !== undefined && endedTurns.has(`${p.chatId}\n${p.turnId}`)) return { stopped: false, retired: true };
      // the tool calls the chat has waiting for the app end with it
      tools?.abortChat(p.chatId);
      approvals.stopped(p.chatId);
      // a Codex Stop the app-server has refused so far (the turn has not begun) is still being carried out, not done: the reply says so
      const stopped = await runtime.host.cancel(p.chatId);
      return stopped === 'pending' ? { stopped: false, pending: true } : { stopped: true };
    },
    'chat.permit': async (p) => {
      // a harness whose runtime cannot set a mode for new turns says so rather than pretend it was set
      if (!runtime.setMode) throw new UnsupportedError('This host cannot change the permission mode.');
      await runtime.setMode({ chatId: p.chatId, value: p.value });
      return { permission: p.value, plan: p.value === 'plan' };
    },
  };
  // a chat is started on the harness its id names: the runtime opens its session from that id, so a request that disagrees with it is refused before it runs
  effects['chat.start'] = async (p) => {
    check(p.chatId, p.text);
    p.checkImages?.();
    if (p.harness.startsWith('acp:')) {
      if (!p.chatId.startsWith(`${p.harness}:`)) throw new SchemaError('That chat id does not belong to the harness it starts on.');
    } else {
      // a harness that names its own sessions (Codex) is given the chat id the client chose; an id that names another family's session is not one
      if (!runtime.prepare) throw new UnsupportedError('This host cannot run that harness yet.');
      // Claude Code's ids are minted by the client as `claude:<id>`; any other id naming a family's session is not this harness's
      const own = p.harness === 'claude' ? p.chatId.startsWith('claude:') : !/^(acp|claude):/.test(p.chatId);
      if (!own) throw new SchemaError('That chat id does not belong to the harness it starts on.');
      // Claude Code refuses a session id that is not a UUID, and its turn would then fail where no client hears of it: refuse the start instead
      if (p.harness === 'claude' && !p.sideChat && !CLAUDE_ID.test(p.chatId))
        throw new SchemaError('A Claude Code chat id is "claude:" and a UUID.');
      const forked = await runtime.prepare({
        chatId: p.chatId,
        harness: p.harness,
        ...(p.source ? { source: p.source } : {}),
        ...(dispatchCheck(p) ? { check: dispatchCheck(p) } : {}),
        ...(p.cwd ? { cwd: p.cwd } : {}),
      });
      if (forked === true) p = { ...p, sideContext: undefined };
      p.checkImages?.();
      // the mode the chat starts in stays its mode for later turns
      // Plan from the first message runs on the mode the person picked: that is entered first, so Plan keeps it as the one its tools run under
      if (p.planBase && p.permission === 'plan' && runtime.setMode) await runtime.setMode({ chatId: p.chatId, value: p.planBase });
      if (p.permission && runtime.setMode) await runtime.setMode({ chatId: p.chatId, value: p.permission });
    }
    p.checkImages?.();
    return effects['chat.send'](p);
  };
  // the credential a start chose is kept before its first message can run (refused here when it cannot be honored) and let go if the start fails
  const started = effects['chat.start'];
  effects['chat.start'] = async (p) => {
    p.checkImages?.();
    const inherited = p.sideChat && credentials?.sideChatChoice(p.sideChat.sourceId, p.harness);
    if (p.nativeParent && !p.harness.startsWith('acp:') && (inherited || !p.credential)) {
      const { sourceId, epoch } = p.sideChat;
      const { id, instance } = p.nativeParent;
      const checkParent = p.checkImages;
      const bindingOf = (choice) => {
        const identity = choice?.source === 'org' ? credentials?.sideChatOrgIdentity(p.harness) : undefined;
        return JSON.stringify([sourceId, epoch, p.harness, id, instance, choice, identity]);
      };
      const binding = bindingOf(inherited);
      p = {
        ...p,
        source: { chatId: sourceId, id, binding },
        checkImages: () => {
          checkParent();
          const now = credentials?.sideChatChoice(sourceId, p.harness);
          if (bindingOf(now) !== binding) throw sideChatParentChanged();
        },
      };
    }
    await credentials?.ready(p.harness, p.chatId);
    p.checkImages?.();
    credentials?.admit({ chatId: p.chatId, harness: p.harness, credential: inherited ?? p.credential });
    try {
      return await started(p);
    } catch (error) {
      credentials?.forget(p.chatId);
      throw error;
    }
  };
  // a permission card the Host's harness is waiting on, answered by the app that drew it
  effects['chat.answer'] = (p) => {
    // the first answer wins: a second one is refused (`card_answered`), whoever sends it and with whatever key
    const claim = approvals.claim(p);
    // the close is recorded once, with who answered and what the option was (the runtime's own close of this card is left out)
    const closing = (/** @type {string} */ chatId, /** @type {any} */ e) => record(chatId, approvals.answeredEvent(claim, e));
    let out;
    try {
      out = faults.answer(p, check, (answer) => runtime.permit(answer), closing);
    } catch (error) {
      approvals.unclaim(claim);
      throw error;
    }
    if (out.answered) approvals.answered(p.chatId, p.requestId, claim);
    else approvals.unclaim(claim);
    return out;
  };

  return effects;
}
