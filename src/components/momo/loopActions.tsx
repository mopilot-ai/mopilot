// What the Memory tab's Open loops and a nudge's card share (#2139 P4): one loop's Done, Snooze and Dismiss (or Reopen) buttons through main (electron/momo/loopsIpc.cjs), with the failure said under them, and how a loop's why reads.
import { useState } from 'react';
import { native } from '../../lib/native';
import { errorText } from '../../lib/ignored';
import type { MomoLoop, MomoLoopAct } from '../../lib/native/contracts/momoMemory';
import { sendMessage } from '../../store/send';
import { day } from './momoDay';

/** Why a loop is kept, in a line: the user's words and the day they said them. */
export const saidLine = (quote: string, saidAt: number) => `“${quote}” · said ${day(saidAt)}`;

/** A loop's state in a word or two, or null while it is open and awake. */
export function loopState(l: Pick<MomoLoop, 'state' | 'snoozedUntil'>, now: number): string | null {
  if (l.state === 'done') return 'Done';
  if (l.state === 'dismissed') return 'Dismissed';
  return l.snoozedUntil !== undefined && l.snoozedUntil > now ? `Snoozed to ${day(l.snoozedUntil)}` : null;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** What MoMo is asked to do with an open loop, in the user's words: the loop's title and, when it has one, its due time (the day alone for an end-of-day due). */
export function loopPrompt(kind: 'calendar' | 'reminder', title: string, dueAt?: number, dueDay?: string): string {
  let due = '';
  if (dueAt !== undefined) {
    const d = new Date(dueAt);
    const endOfDay = d.getHours() === 23 && d.getMinutes() === 59;
    due = `, due ${dueDay ?? day(dueAt)}${endOfDay ? '' : ` ${pad(d.getHours())}:${pad(d.getMinutes())}`}`;
  }
  return kind === 'calendar' ? `Add “${title}” to my Calendar${due}` : `Remind me about “${title}”${due}`;
}

/** The buttons for one loop: Done, Snooze, Dismiss (and Add to Calendar, Remind me when it has a title) while it is open, Reopen once closed. */
export function LoopActions({
  id,
  open,
  done,
  title,
  dueAt,
  dueDay,
}: {
  id: string;
  open: boolean;
  done?: (loop: MomoLoop) => void;
  title?: string;
  dueAt?: number;
  dueDay?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (act: MomoLoopAct) => {
    setBusy(true);
    try {
      const r = await native.momoMemory.loopAct(id, act);
      if (r.ok) {
        setError(null);
        done?.(r.loop);
      } else setError(r.error);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const name = title?.trim();
  // An ordinary user message to MoMo's main chat: MoMo calls the write tool and its approval card asks, as for any write.
  const ask = async (kind: 'calendar' | 'reminder', what: string) => {
    setBusy(true);
    try {
      const { chatId } = await native.momoChat.mainChat();
      const sent = await sendMessage(chatId, loopPrompt(kind, what, dueAt, dueDay), [], { human: true });
      setError(sent === false ? "Couldn't send to MoMo. Try again." : null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const button = (label: string, act: MomoLoopAct) => (
    <button className="btn-pill soft" disabled={busy} aria-busy={busy} onClick={() => void run(act)}>
      {label}
    </button>
  );
  return (
    <span className="momo-loop-actions">
      {open ? (
        <>
          {button('Done', { action: 'done' })}
          {button('Snooze', { action: 'snooze', snooze: 'day' })}
          {button('Dismiss', { action: 'dismiss' })}
          {name && (
            <>
              <button className="btn-pill soft" disabled={busy} onClick={() => void ask('calendar', name)}>
                Add to Calendar
              </button>
              <button className="btn-pill soft" disabled={busy} onClick={() => void ask('reminder', name)}>
                Remind me
              </button>
            </>
          )}
        </>
      ) : (
        button('Reopen', { action: 'reopen' })
      )}
      {error && (
        <span className="config-warning" role="alert">
          {error}
        </span>
      )}
    </span>
  );
}
