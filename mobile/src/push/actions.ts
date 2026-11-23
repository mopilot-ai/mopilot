// iOS notification actions: a Review/Open button and a typed Reply that becomes a draft in the chat, never a message sent from the lock screen.
import type { PushKind } from './kinds';
import { ALLOW_ACTION, DENY_ACTION } from './approvalAction';

export const OPEN_ACTION = 'open';
export const REPLY_ACTION = 'reply';
export const MAX_REPLY = 2000;
/** The approval actions of a push from a Host (P5): Allow (after Face ID or the passcode) and Deny run in the background; both only act when the push opens to a Host card, else they open the app. */
export { ALLOW_ACTION, DENY_ACTION, ANSWER_ACTION } from './approvalAction';

/** The category a push of this kind names in `aps.category` (relay/src/pushPayload.mjs). */
export const categoryId = (kind: PushKind) => `mopilot.${kind}`;

type Spec = {
  id: string;
  actions: Array<{
    identifier: string;
    buttonTitle: string;
    background?: 'unlocked' | 'locked';
    textInput?: { submitButtonTitle: string; placeholder: string };
  }>;
};

const withActions = (kind: PushKind, openTitle: string): Spec => ({
  id: categoryId(kind),
  actions: [
    { identifier: OPEN_ACTION, buttonTitle: openTitle },
    ...(kind === 'needsYou'
      ? [
          { identifier: ALLOW_ACTION, buttonTitle: 'Allow', background: 'unlocked' as const },
          { identifier: DENY_ACTION, buttonTitle: 'Deny', background: 'locked' as const },
        ]
      : []),
    { identifier: REPLY_ACTION, buttonTitle: 'Reply', textInput: { submitButtonTitle: 'Open chat', placeholder: 'Message' } },
  ],
});

/** Every kind but `machineOffline` (nothing to answer there) has the two actions. */
export const CATEGORY_SPECS: readonly Spec[] = [
  withActions('needsYou', 'Review'),
  withActions('momoNeedsYou', 'Review'),
  withActions('done', 'Open'),
];

/** The text typed into the Reply action, trimmed and bounded; null for any other action or an empty reply. */
export function replyDraft(actionIdentifier: string, userText: unknown): string | null {
  if (actionIdentifier !== REPLY_ACTION || typeof userText !== 'string') return null;
  let text = userText.trim().slice(0, MAX_REPLY);
  // do not leave half of a surrogate pair at the cut
  if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1);
  return text || null;
}
