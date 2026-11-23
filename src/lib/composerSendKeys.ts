// Conversation send and queue shortcuts, shared by keyboard handling, the empty-input hint and the Send tooltip.
import { isMac, shortcutLabel } from './platform';
import { imeComposing } from './focus';
import type { Prefs } from '../../shared/model/store';

type SendWith = Prefs['sendWith'];
type SubmitKey = Pick<KeyboardEvent, 'key' | 'shiftKey' | 'altKey' | 'metaKey' | 'ctrlKey'> & Parameters<typeof imeComposing>[0];

/** Shift/Alt+Enter keep their newline role; the alternate submit chord explicitly queues a follow-up. */
export function composerSendIntent(event: SubmitKey, sendWith: SendWith): 'steer' | 'queue' | null {
  if (imeComposing(event) || event.key !== 'Enter' || event.altKey) return null;
  const modified = event.metaKey || event.ctrlKey;
  if (sendWith === 'enter') {
    if (event.shiftKey) return null;
    return modified ? 'queue' : 'steer';
  }
  if (!modified) return null;
  return event.shiftKey ? 'queue' : 'steer';
}

export function composerSendShortcuts(sendWith: SendWith, mac = isMac) {
  return {
    send: sendWith === 'enter' ? '↵' : shortcutLabel('⌘↵', mac),
    queue: shortcutLabel(sendWith === 'enter' ? '⌘↵' : '⇧⌘↵', mac),
  };
}
