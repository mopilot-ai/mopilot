// Pre-checks that may only answer "quiet": bulk or list mail Gmail filed as noise, auto-replies, calendar responses, and mail that holds a login code or reset link.
import { proseLinks } from '../proseLinks.mjs';
import { hasRiskSignal, holdsCode, SECRET_WORDS, secretLinks } from './signals.ts';
import type { MailMessage } from './types.d.ts';

/*
 * The four noise rules are vendored from OpenDuet (CopilotKit/openduet, openbot/server/src/openduet/triage.ts), MIT License,
 * Copyright (c) 2026 CopilotKit; the "access secret" rule re-implements the definition in n8n nod's mail-check.ts
 * (Apache-2.0, Copyright 2026 n8n GmbH) as plain patterns. The full notices are in THIRD_PARTY.md next to this file.
 *
 * A rule that said "needs you" would be a keyword list, so these only ever answer quiet, and they are narrow on purpose:
 * Updates and Forums labels are not noise ("payment failed" lands there), and auto-generated mail is not auto-reply
 * (bank alerts are auto-generated).
 */

export function header(message: Pick<MailMessage, 'headers'>, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(message.headers)) if (key.toLowerCase() === wanted) return value;
  return undefined;
}

/** Gmail's own verdict that a message is marketing or social noise. */
const NOISE_CATEGORIES = ['CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL'];
const hasNoiseLabel = (message: MailMessage) => message.labels.some((label) => NOISE_CATEGORIES.includes(label));

/** RFC 2369's unsubscribe link or RFC 2076's `Precedence`: sent to many people at once. */
const sentToMany = (message: MailMessage) =>
  header(message, 'List-Unsubscribe') !== undefined || /^(bulk|list|junk)$/i.test(header(message, 'Precedence')?.trim() ?? '');

type Rule = { id: string; reason: string; matches: (message: MailMessage) => boolean };

const RULES: Rule[] = [
  // List headers alone are not enough: a security@ group report and a vendor's "rotate your credentials" notice carry them. Only with Gmail's own noise label.
  { id: 'bulk', reason: 'Bulk mail: a newsletter, promotion or digest.', matches: (m) => sentToMany(m) && hasNoiseLabel(m) },
  { id: 'category', reason: 'Gmail filed it under Promotions or Social.', matches: hasNoiseLabel },
  // RFC 3834; `auto-generated` is not here.
  {
    id: 'auto-reply',
    reason: 'An automatic reply, such as an out-of-office.',
    matches: (m) => header(m, 'Auto-Submitted')?.trim().toLowerCase() === 'auto-replied',
  },
  // the latest message of the thread is the user's own reply: the matter is theirs to have finished
  { id: 'sent', reason: 'You sent this yourself.', matches: (m) => m.labels.includes('SENT') },
  {
    id: 'calendar-response',
    reason: 'Someone answered an invitation; nothing to do.',
    matches: (m) => /^(accepted|declined|tentatively accepted):/i.test(m.subject.trim()),
  },
];

/**
 * Whether the mail supplies an access secret: a one-time code, a magic sign-in link, or a reset or recovery link. Such mail is
 * kept private (never quoted in a push or brief); it is silenced only when nothing says an account or payment is at risk.
 */
export function holdsAccessSecret(message: MailMessage): boolean {
  const text = `${message.subject}\n${message.body}`;
  return holdsCode(text) || secretLinks(text).length > 0 || (SECRET_WORDS.test(text) && proseLinks(text).length > 0);
}

export type PreCheck = {
  /** Always quiet: a pre-check never says anything else. */
  verdict: 'quiet';
  reason: string;
  decidedBy: `rule:${string}`;
  /** True when the mail holds an access secret: it is kept out of every push and brief. */
  private: boolean;
};

/** The quiet answer a rule can reach on its own, or null when the reading turn has to look. */
export function preCheck(message: MailMessage): PreCheck | null {
  // a security alert or a failed payment that also carries a link or code is not noise: it goes to the reading turn, secrets redacted
  if (holdsAccessSecret(message) && !hasRiskSignal(`${message.subject}\n${message.body}`))
    return {
      verdict: 'quiet',
      reason: 'Holds a sign-in code or reset link, kept private.',
      decidedBy: 'rule:access-secret',
      private: true,
    };
  const rule = RULES.find((candidate) => candidate.matches(message));
  return rule ? { verdict: 'quiet', reason: rule.reason, decidedBy: `rule:${rule.id}`, private: false } : null;
}
