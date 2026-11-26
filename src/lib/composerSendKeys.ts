// Conversation send and queue shortcuts, shared by keyboard handling, the empty-input hint and the Send tooltip.
import { isMac, shortcutLabel } from './platform';
import { imeComposing } from './focus';
import { t } from './i18n';
import type { Prefs } from '../../shared/model/store';

type SendWith = Prefs['sendWith'];
type FollowUp = Prefs['followUp'];
type SubmitKey = Pick<KeyboardEvent, 'key' | 'shiftKey' | 'altKey' | 'metaKey' | 'ctrlKey'> & Parameters<typeof imeComposing>[0];

export const RETURN_GLYPH = '⏎';

/**
 * While a turn runs, the submit chord asks for what the Follow-up setting says, as the Send button does, and the
 * alternate chord for the other one. Main decides what the chat's agent can take: a steer it can't take waits in the
 * queue, so this names no harness. Shift/Alt+Enter keep their newline role.
 */
export function composerSendIntent(event: SubmitKey, sendWith: SendWith, followUp: FollowUp): FollowUp | null {
  if (imeComposing(event) || event.key !== 'Enter' || event.altKey) return null;
  const modified = event.metaKey || event.ctrlKey;
  if (sendWith === 'enter' ? event.shiftKey : !modified) return null;
  const alternate = sendWith === 'enter' ? modified : event.shiftKey;
  if (!alternate) return followUp;
  return followUp === 'queue' ? 'steer' : 'queue';
}

export function composerSendShortcuts(sendWith: SendWith, mac = isMac) {
  return {
    submit: sendWith === 'enter' ? RETURN_GLYPH : shortcutLabel(`⌘${RETURN_GLYPH}`, mac),
    alternate: shortcutLabel(`${sendWith === 'enter' ? '⌘' : '⇧⌘'}${RETURN_GLYPH}`, mac),
  };
}

/**
 * The empty composer's hint while a turn runs: the submit chord's action first, then the alternate chord's.
 * @param steers the chat's agent takes a message into a running turn (its `steer` capability, main's word); otherwise every message waits
 */
export function composerSendHint(sendWith: SendWith, followUp: FollowUp, steers: boolean, mac = isMac): string {
  const { submit, alternate } = composerSendShortcuts(sendWith, mac);
  if (!steers) return t('{0} to queue for later', [submit]);
  return followUp === 'queue'
    ? t('{0} to queue for later, {1} to send now', [submit, alternate])
    : t('{0} to send now, {1} to queue for later', [submit, alternate]);
}
