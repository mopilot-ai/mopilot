// A draft MoMo wrote for the user (A3, shared/momoDraft.mjs) as the card and its native calls carry it.
import type { From, Send } from '../../../../shared/momoDraftSend.mjs';

export interface MomoDraft {
  to: string[];
  subject: string;
  body: string;
}

/** The answer of Open in Mail: opened, or why not (`reason`: MoMo is off, the draft is too long for a link or not a draft, no mail app). */
export type MomoDraftOpened = { ok: true } | { ok: false; error: string; reason?: string };

/** A connected mail account the From chooser lists; `ok` false (with `why`) when it can't send now. */
export interface MomoMailAccount extends From {
  ok: boolean;
  why: string | null;
}

export type MomoMailAccounts = { ok: true; accounts: MomoMailAccount[] } | { ok: false; error: string; reason?: string };

/** What the card sends: the note it is, the account's id and its (edited) words. */
export interface MomoDraftSendInput extends MomoDraft {
  chatId: string;
  noteId: string;
  from: string;
}

/** The answer of Send: sent, or the reason it stopped (a code of shared/momoDraftSend.mjs WHY, or a draft word's own). */
export type MomoDraftSent =
  | { ok: true; send: Send }
  | {
      ok: false;
      reason: string;
      why?: string;
      error?: string;
      send?: Send | null;
    };

export type MomoDraftState = { ok: true; send: Send | null } | { ok: false; error: string; reason?: string };

/** A note's send moved (main's broadcast). */
export interface MomoDraftStateEvent {
  chatId: string;
  noteId: string;
  send: Send | null;
}
