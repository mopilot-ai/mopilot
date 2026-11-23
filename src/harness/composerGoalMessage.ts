// Sending a goal from the composer: whether the chat's adapter can take one, and the message that sets it.

import type { Attachment } from '../../shared/model/store';
import type { CapView } from '../../shared/model/session';
import type { QueuedOptions } from '../../shared/model/session';
import { whyText } from './caps';

/** Use the current adapter's binding, including native goal commands advertised by ACP. */
export function composerGoalReason(cap: CapView, off: string | null): string | null {
  if (off) return off;
  if (
    (cap.state === 'native' || cap.state === 'sage') &&
    (cap.via === 'rpc' || (cap.via === 'passthrough' && cap.template?.includes('{args}')))
  )
    return null;
  return cap.why ? whyText(cap.why, { semantic: 'goal' }) : 'Goals are unavailable in this chat';
}

export function composerGoalMessage(
  cap: CapView,
  text: string,
  attachments: Attachment[],
): {
  text: string;
  attachments: Attachment[];
  options: QueuedOptions;
} {
  const reason = composerGoalReason(cap, null);
  if (reason) throw new Error(reason);
  const objective = text.trim();
  if (!objective) throw new Error('Enter a goal before sending');
  // a goal set over the adapter's API (Codex: thread/goal/set) takes its objective only: files, images and chat
  // references would be dropped without a word, so the goal isn't sent and the composer keeps them
  if (cap.via === 'rpc' && attachments.length)
    throw new Error('A goal is set from its text only. Send the files or chats it needs in a message first, or remove them');
  return cap.via === 'passthrough'
    ? { text: cap.template!.replace('{args}', () => objective), attachments, options: { human: true } }
    : { text: objective, attachments, options: { goal: objective, human: true } };
}
