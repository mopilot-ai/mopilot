// The sender check before a tell-now about money or credentials: whether Gmail's own Authentication-Results header says the From domain passed DMARC.
import { header } from './preChecks.ts';
import { cleanText } from './signals.ts';
import type { MailMessage } from './types.d.ts';

/*
 * Ported from OpenClaw (extensions/imap/src/sender-gate.ts, MIT, Copyright (c) 2026 OpenClaw Foundation): the
 * Authentication-Results parser and the "trusted authserv-id with dmarc=pass" rule. OpenClaw also re-checks with the
 * `mailauth` library when it holds the raw message; that is left out here (see THIRD_PARTY.md and the open item recorded
 * on the tracking issue): the Gmail API gives headers, not the raw message, and Gmail's own result is the one that read the SMTP envelope.
 */

export type SenderStatus = 'pass' | 'fail' | 'unknown';
export type SenderCheck = {
  status: SenderStatus;
  reason: string;
  /** The domain has never been seen in the user's mail history. */
  firstSeen?: boolean;
  /** A known domain this one imitates (paypa1.com for paypal.com). */
  lookalikeOf?: string;
};

type AuthResult = { authservId: string; dmarc?: string; headerFrom?: string };

/** Parses one `Authentication-Results` value (RFC 8601): the authserv-id, the dmarc result and the `header.from` it covers. */
export function parseAuthResults(value: string): AuthResult | undefined {
  const unfolded = value.replace(/\r?\n[\t ]+/gu, ' ');
  const separator = unfolded.indexOf(';');
  if (separator < 1) return undefined;
  const authservId = unfolded
    .slice(0, separator)
    .trim()
    .replace(/\s+\d+$/u, '');
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]*$/u.test(authservId)) return undefined;
  const methods = unfolded.slice(separator + 1);
  const dmarc = /(?:^|;)\s*dmarc\s*=\s*([a-z]+)/iu.exec(methods)?.[1]?.toLowerCase();
  const headerFrom = /dmarc\s*=[^;]*?header\.from\s*=\s*([^\s;)]+)/iu.exec(methods)?.[1]?.toLowerCase();
  return { authservId, ...(dmarc ? { dmarc } : {}), ...(headerFrom ? { headerFrom } : {}) };
}

/** The domain of a `From` header, or null when it holds not exactly one address. */
export function fromDomain(from: string): string | null {
  const addresses = from.match(/[^\s<>,"';]+@[^\s<>,"';]+/g) ?? [];
  if (addresses.length !== 1) return null;
  return addresses[0].slice(addresses[0].lastIndexOf('@') + 1).toLowerCase();
}

/** The one address of a `From` header, lower case, or null when it holds not exactly one. */
export function fromAddress(from: string): string | null {
  const addresses = from.match(/[^\s<>,"';]+@[^\s<>,"';]+/g) ?? [];
  return addresses.length === 1 ? addresses[0].toLowerCase() : null;
}

/** The authserv-ids whose results are trusted: Gmail's own receiving servers. */
export const GMAIL_AUTHSERV_IDS = ['mx.google.com'];

/**
 * Only the TOPMOST `Authentication-Results` counts: the receiving server adds its block above the others, so a block a sender
 * forged sits below it and is ignored. It must come from a trusted server, say `dmarc=pass`, and name `header.from` equal to the
 * domain in the `From` line. Anything else is not a pass: no header or another server's header is `unknown`, an explicit dmarc
 * failure or a `From` with not exactly one address is `fail`. Several blocks arrive joined by a newline, topmost first.
 */
export function checkSender(message: MailMessage, trusted: readonly string[] = GMAIL_AUTHSERV_IDS): SenderCheck {
  const domain = fromDomain(message.from);
  if (!domain) return { status: 'fail', reason: 'The From line does not hold exactly one address.' };
  const top = parseAuthResults((header(message, 'Authentication-Results') ?? '').split(/\r?\n(?=[^\s])/u)[0]);
  if (!top || !trusted.includes(top.authservId)) return { status: 'unknown', reason: 'No trusted authentication result on the mail.' };
  if (top.dmarc === 'fail') return { status: 'fail', reason: 'DMARC failed for the sender domain.' };
  if (top.dmarc !== 'pass') return { status: 'unknown', reason: 'The authentication result is not a DMARC pass.' };
  if (!top.headerFrom) return { status: 'unknown', reason: 'The DMARC result does not name the domain it covers.' };
  return top.headerFrom === domain
    ? { status: 'pass', reason: 'DMARC passed for the sender domain.' }
    : { status: 'fail', reason: 'DMARC passed for a different domain than the From line.' };
}

/** Look-alike spellings folded together: rn for m, 1 or | for l, 0 for o, vv for w. */
const fold = (domain: string) => domain.replace(/rn/g, 'm').replace(/[1|]/g, 'l').replace(/0/g, 'o').replace(/vv/g, 'w');

/** True when the strings differ by one inserted, removed or changed character. */
function oneEdit(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1);
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : b.slice(i + 1) === a.slice(i);
}

/**
 * The sender check against the user's history. A genuine DMARC pass proves the domain sent it, not that it is the domain the
 * user deals with: paypa1.com passes for itself. So a domain never seen before, or one that imitates a known domain, passes only as
 * `firstSeen` / `lookalikeOf`, and no reply is offered for a money or credential ask.
 */
export function judgeSender(
  message: MailMessage,
  knownDomains: readonly string[],
  trusted: readonly string[] = GMAIL_AUTHSERV_IDS,
): SenderCheck {
  const check = checkSender(message, trusted);
  const domain = fromDomain(message.from);
  if (check.status !== 'pass' || !domain || knownDomains.includes(domain)) return check;
  const lookalikeOf = knownDomains.find((known) => fold(known) === fold(domain) || oneEdit(known, domain));
  return lookalikeOf
    ? { ...check, firstSeen: true, lookalikeOf, reason: `This domain looks like ${lookalikeOf} but is not.` }
    : { ...check, firstSeen: true, reason: 'This domain has not written to you before.' };
}

/** Whether MoMo may offer a reply draft for a mail judged this way: the sender passed and is a known correspondent. */
export const mayOfferReply = (check: SenderCheck): boolean => check.status === 'pass' && !check.firstSeen;

/** Money or credentials in a mail: the subjects a sender check guards. Over-matching only adds a warning. */
const MONEY_OR_CREDENTIALS =
  /\b(?:invoice|payment|pay\b|wire|transfer|refund|bank|account number|iban|routing|credit card|gift cards?|password|credentials?|login|sign[- ]?in|verify your|bitcoin|crypto|billing|charge)\b|\u4ed8\u6b3e|\u53d1\u7968|\u8f6c\u8d26|\u94f6\u884c|\u5bc6\u7801|\u8d26\u53f7/i;
export const mentionsMoneyOrCredentials = (message: MailMessage): boolean =>
  MONEY_OR_CREDENTIALS.test(`${message.subject}\n${message.body}`);

/** Who a mail says it is from, for "This may not be from <name>": the display name when there is one, else the domain; short, with no links or codes. */
export function senderName(from: string): string {
  const display = /^\s*"?([^"<]+?)"?\s*</.exec(from)?.[1];
  return cleanText(display ?? fromDomain(from) ?? 'the sender', 40) || 'the sender';
}

/** Senders that write by machine: their "please" and "do not reply" are boilerplate, not a request to the owner. */
const AUTOMATED_LOCAL =
  /^(?:no-?reply|do-?not-?reply|donotreply|notifications?|mailer-daemon|bounces?|alerts?|news(?:letter)?|updates?|info|support|billing|receipts?)$/i;
export function isAutomated(message: MailMessage): boolean {
  const local = /([^<\s@]+)@[^>\s]+>?\s*$/.exec(message.from.trim())?.[1] ?? '';
  const auto = header(message, 'Auto-Submitted')?.trim().toLowerCase();
  return (
    AUTOMATED_LOCAL.test(local) || (auto !== undefined && auto !== '' && auto !== 'no') || header(message, 'List-Unsubscribe') !== undefined
  );
}
