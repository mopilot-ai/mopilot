// Check the source chat on its Host until the side chat's first message has been handed to its own agent.
import { harnessOfHostChat } from '../../shared/host/chatIds.mjs';
import { turnsFromHostItems } from '../../shared/host/continueHandoff.mjs';
import { SIDE_CHAT_PARENT_CHANGED } from '../../shared/host/sideChats.mjs';
import { renderConversation, turnMessageTexts } from '../../shared/handoff.mjs';
import { clip } from '../../shared/clippedText.mjs';
import { suffixUnits } from '../../shared/textPrefix.mjs';
import { HostRefusal } from './hostFs.mjs';
import { sideChatParentChanged } from './nativeSideChat.mjs';

const MAX_ITEMS = 2_000;
const CONTEXT_TOKENS = 12_000;
const CONTEXT_CHARS = CONTEXT_TOKENS * 3;
const LATEST_CHARS = 18_000;

/** @param {import('../../shared/model/store').TurnState} turn @param {number} number */
function latestTurn(turn, number) {
  const full = renderConversation([turn], LATEST_CHARS / 3, number).text;
  if (full.length <= LATEST_CHARS) return full;
  const { user, reply } = turnMessageTexts(turn);
  return [
    `### Turn ${number}`,
    `User: ${clip(user, 6_000)}`,
    `Assistant: ${clip(reply, 11_500)}`,
    '[This exchange is abbreviated. See the parent chat for the full history.]',
  ].join('\n');
}

/** @param {{ items: unknown[], total: number, omittedForSize?: boolean }} history */
function parentContext({ items, total, omittedForSize }) {
  if (omittedForSize)
    return 'The parent history was too large to load for this side chat. Use the selected passage and the message that follows.';
  const turns = /** @type {any[]} */ (turnsFromHostItems(items));
  const first = turns[0];
  if (first && total > items.length && !turnMessageTexts(first).user) {
    first.items.unshift({
      type: 'userMessage',
      content: [{ type: 'text', text: 'The user’s message for this turn may be outside the excerpt.' }],
    });
  }
  const latest = turns.pop();
  if (!latest) return '';
  const newest = latestTurn(latest, turns.length + 1);
  const remaining = CONTEXT_CHARS - newest.length;
  const text = turns.length ? renderConversation(turns, Math.floor(remaining / 3)).text : '';
  const recent = suffixUnits(text, remaining);
  const omitted = text.length - recent.length;
  return [
    total > items.length && `[${total - items.length} earlier items omitted. See the parent chat for the full history.]`,
    omitted && `[${omitted} earlier characters omitted. See the parent chat for the full history.]`,
    recent,
    newest,
  ]
    .filter(Boolean)
    .join('\n');
}

/** @param {{ epochs: { current: (id: string) => number }, continueHost?: { gate: (id: string, epoch: number) => unknown }, log: Pick<ReturnType<typeof import('./chatLog.mjs').createChatLog>, 'deleted' | 'items' | 'recentItems'>, runtime: { switchState?: (id: string) => { harness: string, pending?: string | null } | null, sideChatParent?: ReturnType<typeof import('./nativeSideChat.mjs').sideChatParentOf>, retire?: (chatId: string) => Promise<unknown> }, policy?: Pick<ReturnType<typeof import('./policy.mjs').createPolicy>, 'rules'>, report: (error: unknown) => void }} o */
export function sideChatStart({ epochs, continueHost, log, runtime, policy, report }) {
  const starting = new Set();
  return async (/** @type {any} */ p, /** @type {(input: any) => unknown} */ effect) => {
    if (!p.sideChat) return effect(p);
    if (starting.has(p.chatId)) throw new HostRefusal('side_chat_starting', 'The first message for this side chat is still starting.');
    if (log.items(p.chatId).some((item) => /** @type {{t?: string}} */ (item).t === 'user'))
      throw new HostRefusal('side_chat_started', 'This side chat already has a first message. Open it to continue.');
    const { sourceId, epoch } = p.sideChat;
    const nativeParent = runtime.sideChatParent?.(sourceId);
    function check() {
      p.checkImages?.();
      const state = runtime.switchState?.(sourceId);
      const harness = state?.harness ?? harnessOfHostChat(sourceId);
      if (epochs.current(sourceId) !== epoch || log.deleted(sourceId) || state?.pending || harness !== p.harness)
        throw sideChatParentChanged();
      if (nativeParent) {
        if (!nativeParent.current()) throw sideChatParentChanged();
        // The initial request already recorded its audit and mode. Recheck changing rules at native dispatch.
        const { harness, permission, planBase } = p;
        policy?.rules('chat.start', { harness, permission, planBase }, p.by?.kind ?? 'desktop');
      }
      try {
        continueHost?.gate(sourceId, epoch);
      } catch {
        // Move details for the parent must never redirect the side chat's own outbox entries.
        throw sideChatParentChanged();
      }
    }
    check();
    const context = parentContext(log.recentItems(sourceId, MAX_ITEMS));
    const sideContext = context
      ? `<side-chat-context>\nThis is a separate conversation. The parent chat's recent messages are background for the user's next message.\n\n${context.replace(/<\/side-chat-context/gi, '<\\/side-chat-context')}\n</side-chat-context>`
      : '';
    starting.add(p.chatId);
    let result;
    try {
      result = await effect({ ...p, nativeParent, sideContext, checkImages: check });
    } catch (error) {
      if (/** @type {HostRefusal} */ (error)?.code === SIDE_CHAT_PARENT_CHANGED) {
        try {
          await runtime.retire?.(p.chatId);
        } catch (retireError) {
          report(retireError);
        }
      }
      throw error;
    } finally {
      starting.delete(p.chatId);
    }
    return result;
  };
}
