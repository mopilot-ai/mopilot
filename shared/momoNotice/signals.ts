// Text signals read in code, never by a model: risk wording, access secrets to hide, deadlines and urgency in the home's local days, and cleaning of model-written text.
import { proseLinks } from '../proseLinks.mjs';

/** Wording that says an account, payment or store is at risk: it must reach the reading turn, even when the mail also holds a link or code. */
const RISK =
  /security alert|suspicious|unusual (?:sign-?in|activity)|(?:wasn'?t|was not|isn'?t|is not) you|unauthori[sz]ed|payment (?:failed|declined|overdue|due)|failed payment|update (?:your )?(?:billing|payment)|\bbilling\b|past due|overdue|account (?:has been |is )?(?:locked|suspended|paused|disabled)|(?:store|shop) (?:has been |is )?paused|final notice|on hold|verify your|breach|compromised|exposed|must reset|\u4ed8\u6b3e\u5931\u8d25|\u8d26\u53f7\u5f02\u5e38|\u5f02\u5e38\u767b\u5f55|\u4e0d\u662f\u60a8/i;
export const hasRiskSignal = (text: string): boolean => RISK.test(text);

// An access secret: a one-time code or a link that signs in or resets a credential, English and Chinese (the definition is nod's mail-check.ts, Apache-2.0).
const codeRegex = (words: string, flags: string) =>
  new RegExp(
    `(?:(?:${words})\\s+(?:code|pin|passcode)|\\botp\\b|passcode|\\u9a8c\\u8bc1\\u7801|\\u6821\\u9a8c\\u7801|\\u52a8\\u6001\\u7801)[^\\n\\d]{0,40}\\b\\d{4,8}\\b`,
    flags,
  );
const SIGN_IN_WORDS = 'verification|security|login|log-in|sign-?in|one-?time|auth(?:entication)?';
/** What is cut out of text: a "confirmation code" too, which may sign in. */
const CODE = codeRegex(`${SIGN_IN_WORDS}|confirmation`, 'gi');
/** What makes a mail private and quiet: a sign-in code only. "Confirmation code" is also a booking's record locator, so it is not enough to silence a mail. */
const SIGN_IN_CODE = codeRegex(SIGN_IN_WORDS, 'i');
const CODE_AFTER = /\b\d{4,8}\b[^\n]{0,30}(?:is your|\u662f\u60a8\u7684)[^\n]{0,30}(?:code|\u9a8c\u8bc1\u7801)/gi;
const SECRET_LINK = /reset|recover|magic|passwordless|one-?time|signin-?token|login-?token|[?&](?:token|code|otp)=/i;
export const SECRET_WORDS =
  /(?:reset|recover|change)\s+your\s+password|magic\s+(?:link|sign-?in)|sign-?in\s+link|\u91cd\u7f6e\u5bc6\u7801|\u627e\u56de\u5bc6\u7801/i;

/** The sign-in and reset links in a text. */
export const secretLinks = (text: string): string[] => proseLinks(text).filter((link) => SECRET_LINK.test(link));
/** A "confirmation code" that expires or must be entered is a sign-in or email check; a booking's record locator is not. */
const EXPIRING = /\bexpires?\b|\bvalid for\b|\benter (?:this|the) code\b|\bdo not share\b/i;
const CONFIRMATION_CODE = codeRegex('confirmation', 'i');
export const holdsCode = (text: string): boolean =>
  SIGN_IN_CODE.test(text) || (CONFIRMATION_CODE.test(text) && EXPIRING.test(text)) || new RegExp(CODE_AFTER.source, 'i').test(text);

/** The text with codes and secret links cut out, so nothing that signs in reaches a model, a push or a brief. */
export function redactSecrets(text: string): string {
  let out = text
    .replace(CODE, (match) => match.replace(/\d{4,8}$/, '[code removed]'))
    .replace(CODE_AFTER, (match) => match.replace(/^\d{4,8}/, '[code removed]'));
  for (const link of secretLinks(text)) out = out.replaceAll(link, '[link removed]');
  return out;
}

/** A model's or a sender's text made safe to store and show: no secrets, links or control characters, one line, at most `max` characters. */
export function cleanText(text: string, max: number): string {
  let out = redactSecrets(text);
  for (const link of proseLinks(out)) out = out.replaceAll(link, '[link]');
  out = out
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return out.length > max ? `${out.slice(0, max - 1).trimEnd()}…` : out;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const DAY_MS = 86_400_000;

/** A home-local day (YYYY-MM-DD) moved by `n` days. */
export const addDays = (day: string, n: number): string => new Date(Date.parse(day) + n * DAY_MS).toISOString().slice(0, 10);

/** The calendar day written as `YYYY-MM-DD`, or undefined when it is not a real date. */
function realDay(year: number, month: number, day: number): string | undefined {
  const text = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const at = Date.parse(text);
  return Number.isNaN(at) || new Date(at).toISOString().slice(0, 10) !== text ? undefined : text;
}

/** The earliest deadline day the text names, from `today` on: today, tomorrow, an ISO date, "Nov 27", or "by Friday". Undefined when it names none. */
export function deadlineDay(text: string, today: string): string | undefined {
  const found: (string | undefined)[] = [];
  if (/\b(?:today|tonight)\b|\u4eca\u5929|\u4eca\u665a/i.test(text)) found.push(today);
  if (/\btomorrow\b|\u660e\u5929/i.test(text)) found.push(addDays(today, 1));
  for (const m of text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) found.push(realDay(Number(m[1]), Number(m[2]), Number(m[3])));
  const year = Number(today.slice(0, 4));
  for (const m of text.matchAll(new RegExp(`\\b(${MONTHS.join('|')})[a-z]*\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, 'gi'))) {
    const month = MONTHS.indexOf(m[1].toLowerCase()) + 1;
    const thisYear = realDay(year, month, Number(m[2]));
    found.push(thisYear !== undefined && thisYear < today ? realDay(year + 1, month, Number(m[2])) : thisYear);
  }
  const todayWeekday = new Date(Date.parse(today)).getUTCDay();
  for (const m of text.matchAll(new RegExp(`\\b(?:by|before|on|due|until)\\s+(${WEEKDAYS.join('|')})\\b`, 'gi'))) {
    found.push(addDays(today, (WEEKDAYS.indexOf(m[1].toLowerCase()) - todayWeekday + 7) % 7));
  }
  return found.filter((day): day is string => day !== undefined && day >= today).sort()[0];
}

/** A request or question to the owner: a question mark, or wording that asks. */
const ASKS =
  /\?|\bplease\b|\b(?:could|can|would|will) you\b|\bneed you to\b|\blet me know\b|\bkindly\b|\bare you able\b|\u8bf7|\u80fd\u5426|\u9ebb\u70e6|\u5417[\uff1f?]?/i;

/** Sentences that are about the mail itself, not a request: "please do not reply", unsubscribe lines, automatic-message notes. */
const BOILERPLATE =
  /do(?:es)? not reply|don'?t reply|do not respond|unsubscribe|automated (?:message|email)|automatically generated|auto-?generated/i;

/** The first request or question in a text, folded to letters and digits (so a re-quote or a changed link does not count as new), or undefined when it asks nothing. */
export function askOf(text: string): string | undefined {
  for (const sentence of redactSecrets(text).split(/(?<=[.!?\u3002\uff01\uff1f])\s+|\n+/)) {
    if (!ASKS.test(sentence) || BOILERPLATE.test(sentence)) continue;
    const folded = sentence
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim()
      .slice(0, 80);
    if (folded) return folded;
  }
  return undefined;
}

/** Wording that is urgent by itself, whatever date it names. */
const URGENT = /final notice|last (?:chance|reminder|warning)|overdue|past due|immediately|\basap\b|urgent/i;

/** How urgent a text is: 3 today or final, 2 within three days, 1 otherwise. */
export function urgencyRank(text: string, deadline: string | undefined, today: string): 1 | 2 | 3 {
  if (URGENT.test(text)) return 3;
  if (deadline === undefined) return 1;
  const gap = (Date.parse(deadline) - Date.parse(today)) / DAY_MS;
  return gap <= 0 ? 3 : gap <= 3 ? 2 : 1;
}
