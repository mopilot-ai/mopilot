// Stable durable identities and turn projections let recovery adopt an uncertain completed write without repeating user or terminal records.
import { subAgentOf } from '../../shared/host/stream2.mjs';
export const itemKey = (item) => {
  if (item.t === 'user' && typeof item.messageKey === 'string') return `user:${item.messageKey}`;
  if (item.t === 'assistant') return `assistant:${item.turnId}`;
  if (item.t === 'event' && item.event?.kind === 'turnEnd') return `end:${item.event.turnId}`;
  return null;
};
export function createJournalItems(frames = []) {
  const keys = new Map();
  const turns = new Map();
  const add = (frame) => {
    const item = frame.item;
    const key = itemKey(item);
    if (key) keys.set(key, frame);
    const event = item.event;
    const turnId = item.turnId ?? event?.turnId;
    if (typeof turnId !== 'string') return;
    const turn = turns.get(turnId) ?? { text: '', end: null, assistant: null };
    if (event?.kind === 'turnEnd') turn.end = event;
    if (item.t === 'assistant') turn.assistant = item;
    if (event?.kind === 'update' && event.update?.sessionUpdate === 'agent_message_chunk' && !subAgentOf(event.update))
      turn.text += String(event.update.content?.text ?? '');
    turns.set(turnId, turn);
  };
  frames.forEach(add);
  return {
    add,
    seen: (item) => {
      const key = itemKey(item);
      return key ? keys.get(key) : undefined;
    },
    turn: (id) => turns.get(id),
  };
}
