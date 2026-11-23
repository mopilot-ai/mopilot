// The notice above the composer when another app has the chat: what it is doing and the action that applies.

import { useStore } from '../../store/core';
import { ELSEWHERE_LABEL, cancelHeld, continueHere, sendHeld } from '../../store/threads';
import { Lock, Spinner, AppWindow } from '../ui/icons';
import { prefixUnits } from '../../../shared/textPrefix.mjs';

const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

/**
 * Above the composer when another app has the chat (design §07): what it is doing, what happens to
 * a message sent now, and the one action that applies.
 */
export function ElsewhereNotice({ threadId }: { threadId: string }) {
  const e = useStore((s) => s.elsewhere[threadId]);
  const held = useStore((s) => s.runtime[threadId]?.held ?? null);
  if (!held && (!e || (!e.running && !e.hard))) return null;

  let icon = <AppWindow size={14} />;
  let title: string;
  let body: string;
  let actions: React.ReactNode = null;
  if (!e) {
    // the other app let go but the message wasn't sent (e.g. sending failed)
    title = 'Your message is waiting.';
    body = 'The other app has let go of this chat.';
    actions = (
      <button className="btn-pill" onClick={() => sendHeld(threadId, true)}>
        Send now
      </button>
    );
  } else {
    const app = ELSEWHERE_LABEL[e.app];
    if (e.running) {
      icon = <Spinner size={13} />;
      title = `${cap(app)} is working on this chat.`;
      body = held ? 'Your message will be sent when it finishes.' : 'You can watch here, and continue once it finishes.';
    } else if (e.hard) {
      icon = <Lock size={13} />;
      title = `This chat is open in ${app}.`;
      body = held
        ? 'Your message sends once you close the chat there or switch chats.'
        : 'Close it there, or switch to another chat, to continue here.';
    } else {
      // open there but idle: the notice only shows while it holds a message (the check above)
      title = `This chat is also open in ${app}.`;
      body = 'Send it here? To send from there, reopen the chat first, or it branches.';
      actions = (
        <button className="btn-pill" onClick={() => continueHere(threadId)}>
          Send here
        </button>
      );
    }
  }
  return (
    <div className="elsewhere-notice" role="status">
      <span className="elsewhere-icon">{icon}</span>
      <div className="elsewhere-text">
        <div className="elsewhere-title">{title}</div>
        <div className="elsewhere-body">{body}</div>
        {held && <div className="elsewhere-held">“{held.text.length > 140 ? `${prefixUnits(held.text, 140)}…` : held.text}”</div>}
      </div>
      <div className="elsewhere-actions">
        {actions}
        {held && (
          <button className="btn-pill ghost" onClick={() => cancelHeld(threadId)}>
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}
