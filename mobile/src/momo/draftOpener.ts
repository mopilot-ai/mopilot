// How the phone hands a MoMo draft to the user (A3): three ways, Gmail's own compose link (iOS gives Gmail's inbox, not a compose window, for a mailto: link when Gmail is the default mail app), the mailto: link, and the system share sheet with the text. The phone cannot know the default mail app, so with Gmail installed the person picks once (a chooser) and the pick is the button's one tap next time; without Gmail the mail link comes first and the sheet is its fallback; a draft too long for any link is shared. Pure choice and run; the screen supplies `open` and `share`. Nothing here sends: each way opens a compose window or a sheet the user acts in.
import { mailtoOf, MAX_MAILTO, type Draft } from '../../../shared/momoDraft.mjs';

/** The scheme asked of `Linking.canOpenURL` to learn whether Gmail is installed; iOS answers only for schemes the app declares (LSApplicationQueriesSchemes in app.json, a native change). */
export const GMAIL_PROBE = 'googlegmail://';
/** The longest compose link handed to Gmail; a longer draft goes to the share sheet instead. */
export const MAX_GMAIL = MAX_MAILTO;

export type Step = { via: 'gmail' | 'mail'; url: string } | { via: 'share' };
/** What the button says it will do. */
export type OpenWord = 'openInGmail' | 'openInMail' | 'share' | 'openChoose';
/** The three ways, as a person picks them and as the phone remembers the pick. */
export type Pick = 'gmail' | 'mail' | 'share';
export const isPick = (v: unknown): v is Pick => v === 'gmail' || v === 'mail' || v === 'share';

/** Gmail's compose link for the draft: every recipient, subject and body percent-encoded; null when it is longer than a link may be. */
export function gmailUrlOf(draft: Draft): string | null {
  const query = [
    `to=${draft.to.map(encodeURIComponent).join(',')}`,
    ...(draft.subject ? [`subject=${encodeURIComponent(draft.subject)}`] : []),
    `body=${encodeURIComponent(draft.body)}`,
  ].join('&');
  const url = `googlegmail:///co?${query}`;
  return url.length > MAX_GMAIL ? null : url;
}

/** The steps to try, best first; the share sheet is always last, so there is always one. */
export function planOf(draft: Draft, gmailInstalled: boolean): Step[] {
  const gmail = gmailInstalled ? gmailUrlOf(draft) : null;
  const mail = mailtoOf(draft);
  return [
    ...(gmail ? [{ via: 'gmail' as const, url: gmail }] : []),
    ...(mail.ok ? [{ via: 'mail' as const, url: mail.url }] : []),
    { via: 'share' },
  ];
}

/**
 * What the button and its chooser offer: `options` the ways this draft can open now, `choose` whether the person picks (Gmail is installed
 * and there is more than one way), `primary` the one tap (the remembered pick when it can open; none yet while choosing; else the first
 * way), and `forget` that the remembered pick can no longer open (Gmail was uninstalled), so the caller drops it.
 */
export function viewOf(draft: Draft, gmailInstalled: boolean, remembered: Pick | null) {
  const options = planOf(draft, gmailInstalled).map((s) => s.via);
  const choose = gmailInstalled && options.length > 1;
  const forget = remembered === 'gmail' && !gmailInstalled;
  const kept = remembered !== null && !forget && options.includes(remembered) ? remembered : null;
  const primary: Pick | null = choose ? kept : options[0];
  return { options, choose, forget, primary };
}

/** The word the button wears: what its one tap does, or that it asks. */
export const wordOf = (primary: Pick | null): OpenWord =>
  primary === 'gmail' ? 'openInGmail' : primary === 'mail' ? 'openInMail' : primary === 'share' ? 'share' : 'openChoose';

/** The steps to try for a pick: its own first, then the others in the default order, so a way that cannot open passes to the next. */
export function stepsFor(draft: Draft, gmailInstalled: boolean, pick: Pick | null): Step[] {
  const plan = planOf(draft, gmailInstalled);
  const own = plan.filter((s) => s.via === pick);
  return [...own, ...plan.filter((s) => s.via !== pick)];
}

/** The text the share sheet carries: who it is for, the subject and the body. */
export const shareTextOf = (draft: Draft): string =>
  [draft.to.length ? `To: ${draft.to.join(', ')}` : '', draft.subject ? `Subject: ${draft.subject}` : '', draft.body]
    .filter(Boolean)
    .join('\n\n');

/**
 * Tries the steps in order until one opens; a step that refuses (no such app, a link the system will not take) passes to the next.
 * @returns the step that opened, or null when none did
 */
export async function runPlan(
  plan: Step[],
  draft: Draft,
  io: { open: (url: string) => Promise<unknown>; share: (text: string) => Promise<unknown> },
): Promise<Step | null> {
  for (const step of plan) {
    try {
      await (step.via === 'share' ? io.share(shareTextOf(draft)) : io.open(step.url));
      return step;
    } catch {
      // this one could not open: the next is tried
    }
  }
  return null;
}
