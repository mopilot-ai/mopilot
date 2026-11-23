// The messages the Mac holds for a running turn, under the chat as the app's queue shows them: each with Edit (back into the composer) and Cancel, sent when the turn ends.
import type { MobileRuntime } from '../contracts';
import type { QueuedSend } from '../outbox';
import { QueuedMessages } from './QueuedMessages';

/** The line under a message the Mac holds: it goes after the turn that runs (a steer shows as a row instead, never here). */
export const WAITING_LINE = 'Sends when this turn ends';

/** What a message the Mac holds for a machine says when it waits for something other than the running turn. */
export const AWAY_LINE = 'Waiting for the machine';
export const SIGNIN_LINE = 'Sign in to your organization on your Mac';
/** The Host's refusal, in a line, when it gave no reason; and a chat that moved. */
export const REFUSED_LINE = 'The host did not accept it.';
export const MOVED_LINE = 'This chat moved to another machine.';

/** After a Stop the Mac keeps its queue and sends nothing (the app's tray offers Send now); on the phone Edit puts it back in the composer. */
export const HELD_LINE = 'On hold after Stop. Edit to send it now.';

import { heldOf } from '../presentation/macQueue';
export { heldOf } from '../presentation/macQueue';

export function MacQueue({
  runtime,
  chatId,
  session,
  running,
  draft,
  setDraft,
  fail,
  settle,
  hiddenIds = [],
  removed,
  picturesFor,
}: {
  runtime: MobileRuntime;
  chatId: string;
  session: Record<string, unknown> | undefined;
  /** A turn is running (or waits for you): the queue goes when it ends; else it was stopped and waits. */
  running: boolean;
  /** What is typed in the composer now (read when the message comes back, not when it was tapped). */
  draft: () => string;
  setDraft: (text: string) => void;
  fail: (message: string) => void;
  /** Takes back the line this list last set (a call of the list starts again: presentation/queueLine.ts). */
  settle?: () => void;
  hiddenIds?: string[];
  removed?: (id: string) => void;
  picturesFor?: (id: string) => string[] | undefined;
}) {
  const held = heldOf(session).filter((h) => !hiddenIds.includes(h.id));
  if (!held.length) return null;
  // a message the machine's Host refused, or whose chat moved, is not waiting: it is not sent, with the reason and what can still be done
  const items: QueuedSend[] = held.map((h) => ({
    id: h.id,
    pairId: '',
    chatId,
    text: h.text,
    attachments: [],
    at: 0,
    status: h.refused !== undefined || h.moved ? 'failed' : 'queued',
    error: h.refused !== undefined ? h.refused || REFUSED_LINE : h.moved ? MOVED_LINE : null,
    ...(h.moved ? { final: true } : {}),
  }));
  const lineOf = (id: string) => {
    const waiting = held.find((h) => h.id === id)?.waiting;
    return waiting === 'host' ? AWAY_LINE : waiting === 'orgSignin' ? SIGNIN_LINE : undefined;
  };
  /** Sends a refused message again through the Mac, as its own Retry does; what the Host says to it is told. */
  async function again(id: string) {
    settle?.();
    try {
      // a Host that refuses it again leaves the row with its reason (the Mac's queue says so): nothing to add above the chat
      await runtime.request('chat.queue.retry', { chatId, id });
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      // a Mac from before this call answers "Unknown request"
      fail(/Unknown request/.test(message) ? 'Update MoPilot on your Mac to retry queued messages.' : message);
    }
  }
  /** Takes the message out of the Mac's queue; whether it was still there. */
  async function take(id: string) {
    settle?.();
    try {
      const r = (await runtime.request('chat.queue.cancel', {
        chatId,
        id,
      })) as { removed?: boolean } | null;
      if (r?.removed === true) {
        removed?.(id);
        return true;
      }
      return false;
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      // a Mac from before this call answers "Unknown request"
      fail(/Unknown request/.test(message) ? 'Update MoPilot on your Mac to change queued messages.' : message);
      return false;
    }
  }
  return (
    <QueuedMessages
      items={items}
      picturesFor={picturesFor}
      queuedLine={running ? WAITING_LINE : HELD_LINE}
      retry={(id) => {
        // only a message the Host refused has anything to send again
        if (held.find((h) => h.id === id)?.refused !== undefined) void again(id);
      }}
      lineOf={lineOf}
      cancel={(id) => void take(id)}
      canTakeBack={(id) => (held.find((h) => h.id === id)?.attached ?? 1) === 0}
      takeBack={(id) =>
        void take(id).then((gone) => {
          // as the app's Edit message: its words go first, ahead of what is typed now
          const text = held.find((h) => h.id === id)?.text ?? '';
          const typed = draft();
          if (gone) setDraft(typed.trim() ? `${text}\n${typed}` : text);
        })
      }
    />
  );
}
