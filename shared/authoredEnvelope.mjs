// What a user-role message that MoPilot itself wrote into a chat is shown as: a one-line card (title, optional body) read back from the envelope text, on every harness. Desktop uses saved presentations first; the phone and older history have only this text.
import { parseFamilyMessage, parseWakeText } from './sideSessions.mjs';
import { parsePeerPrompt } from './peerPrompt.mjs';
import { markedCard } from './modelFraming.mjs';

/** The progress check the app sends a session whose user has heard nothing for a while. */
const NUDGE = /^The user hasn't heard from you in a while\b/;
const TASK = /^<task-notification>/;
const tag = (text, name) => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text)?.[1].trim() ?? '';

/**
 * @param {unknown} text a user message's text
 * @returns {{ kind: 'family' | 'peer' | 'wake' | 'nudge' | 'task' | 'routine' | 'marked', title: string, body: string, name?: string, completed?: boolean } | null} null for a person's words
 */
export function authoredCard(text) {
  const t = String(text ?? '').trim();
  const family = parseFamilyMessage(t);
  if (family)
    return {
      kind: 'family',
      title: `Received message from ${family.fromName}`,
      body: family.body,
    };
  const peer = parsePeerPrompt(t);
  if (peer) {
    const from = peer.sourceTitle ?? 'another chat';
    return {
      kind: 'peer',
      title: `${peer.replyTo ? 'Reply' : 'Received message'} from ${from}`,
      body: peer.body,
    };
  }
  const wake = parseWakeText(t);
  if (wake)
    return {
      kind: 'wake',
      title: 'Linked sessions reported back',
      body: wake.notes,
    };
  if (TASK.test(t))
    return {
      kind: 'task',
      title: tag(t, 'summary') || 'Background task update',
      body: tag(t, 'result') || tag(t, 'event'),
    };
  if (NUDGE.test(t)) return { kind: 'nudge', title: 'Progress check', body: '' };
  // MoMo's own framing for the model (a routine's report, the setup greeting): a labelled card, never its words
  return markedCard(t);
}
