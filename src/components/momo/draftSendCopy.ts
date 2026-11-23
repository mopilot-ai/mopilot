// What a MoMo draft card says around Send, short and the same on every harness: the lines after a send began, why one stopped, and the From chooser's words. The codes are shared/momoDraftSend.mjs's (the phone's words are in its catalogs, `momoDraft.*`).
import { STATES, WHY, fromName, type From, type Send } from '../../../shared/momoDraftSend.mjs';

/** The lines a send shows so far, in order (asked, chose, sent; or the one unsure line). */
export function sendWords(codes: string[], send: Send): string[] {
  const name = fromName(send.from);
  return codes.map((code) => {
    if (code === STATES.ASKED) return 'Asked to send';
    if (code === STATES.CHOSE) return 'You chose Send';
    if (code === STATES.SENT) return `Sent from ${name}`;
    return `Not sure this was sent. Check Sent mail in ${name}.`;
  });
}

/** Why a send did not go, in one line; `from` names the account the user picked when the line is about it. */
export function whyWords(reason: string, from: From | null, detail?: string): string {
  const name = from ? fromName(from) : 'This account';
  switch (reason) {
    case WHY.NO_RECIPIENT:
      return 'Add who it is for first.';
    case WHY.NO_ACCOUNT:
      return 'Connect a mail account in Settings to send.';
    case WHY.CHOOSE:
      return 'Which account should I send it from?';
    case WHY.LOST:
      return 'That account can’t send now. Pick another.';
    case WHY.NOT_CONNECTED:
      return `${name} is not connected. Pick another.`;
    case WHY.RECONNECT:
      return `Sign in to ${name} again in Settings.`;
    case WHY.PAUSED:
      return `${name} is paused in Settings.`;
    case WHY.READ_ONLY:
      return `${name} can only read mail.`;
    case WHY.DECLINED:
      return 'Not sent.';
    case WHY.NOT_ALLOWED:
      return 'MoMo is not available.';
    case WHY.FAILED:
      return 'Couldn’t send. Try again.';
    default:
      // a draft word's own reason (too long, a bad address) says why in its own line
      return detail || 'Couldn’t send.';
  }
}

/** The plain line above the card, in MoMo's words: who the draft is for, its subject and the account it goes from (when one is known). */
export function leadWords(draft: { to: string[]; subject: string }, sender: string): string {
  const who = draft.to.length ? ` to ${draft.to.join(', ')}` : '';
  const what = draft.subject ? ` with subject ${draft.subject}` : '';
  return `Draft email${who}${what}${sender ? `, from ${sender}` : ''}.`;
}
