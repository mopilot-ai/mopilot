// What MoMo's approval card says (#2139, src/components/momo/MomoActionCard.tsx): one question, one line on why it asks, the exact detail, and a label for each scope the rule allows. Short, as Claude's and ChatGPT's cards are.
import type { MomoActionParams, MomoActionScope } from './native';

type Reach = Pick<MomoActionParams, 'hosts' | 'recipients' | 'recipientCount'>;

/** How many places an action reaches in all: the recipients it counts (the card's list is cut, the count is not) and the hosts. */
export const reachCount = (p: Reach) => Math.max(p.recipientCount, p.recipients.length) + p.hosts.length;

/** The places it sends to, first ones named; null when it sends nowhere it can name. */
export function destinationText(p: Reach, named = 2): string | null {
  const all = [...p.recipients, ...p.hosts];
  if (!all.length) return null;
  const shown = all.slice(0, named).join(', ');
  const total = reachCount(p);
  return total > named ? `${shown} and ${total - named} more` : shown;
}

/** Every place it reaches, as the card's To row says it: all the names it has, then how many more there are. */
export function reachText(p: Reach & Pick<MomoActionParams, 'unknown' | 'blocked'>): string {
  const all = [...p.recipients, ...p.hosts];
  if (!all.length) return p.blocked ? 'Nobody MoMo can name' : p.unknown ? "Somewhere MoMo can't tell" : '';
  const more = reachCount(p) - all.length;
  return more > 0 ? `${all.join(', ')} and ${more} more` : all.join(', ');
}

/** The card's question. */
export function momoActionTitle(p: MomoActionParams): string {
  if (p.blocked) return "MoMo can't tell who this reaches";
  const to = destinationText(p, 1);
  if (to) return p.opens ? `Allow MoMo to open ${to}?` : `Allow MoMo to send to ${to}?`;
  if (p.unknown) return 'Allow MoMo to send data out?';
  return p.action === 'read' ? `Allow MoMo to read ${p.source}?` : `Allow MoMo to change ${p.source}?`;
}

/** Why it asks, in one line: the first reason that makes it ask every time, else the source's level. */
export function momoActionWhy(p: MomoActionParams): string {
  if (p.blocked === 'no-recipients') return "This reaches people but names none, so MoMo can't allow it.";
  if (p.blocked) return "MoMo can't read who this reaches, so it can't allow it.";
  if (p.reasons.includes('many-opens')) return 'MoMo opened sites many times in this chat, so it asks again.';
  if (p.reasons.includes('carries-data')) return 'This chat read your private data, and this address may carry some.';
  if (p.reasons.includes('egress'))
    return p.opens
      ? 'This chat read your private data, and this site is new to it.'
      : 'This chat read your private data, and this goes somewhere new.';
  if (p.reasons.includes('uncertain')) return 'An earlier try may already have gone through.';
  if (p.reasons.includes('unknown-destination')) return "MoMo can't tell where this goes.";
  return p.action === 'read' ? `${p.source} is set to ask first.` : `${p.source} is set to ask before changes.`;
}

/** Each scope's button label. */
export const SCOPE_LABEL: Record<MomoActionScope, string> = {
  once: 'Allow once',
  chat: 'Allow for this chat',
  today: 'Allow today',
  '30d': 'Allow for 30 days',
  site: 'Always allow this site',
};

/** "Always allow <host>": opening pages on that one host, in every MoMo chat (electron/momo/sentinelSites.cjs). */
export const siteScopeLabel = (host: string | undefined) => (host ? `Always allow ${host}` : SCOPE_LABEL.site);

/** What "Always allow" covers, as its tooltip says: the widest scope past this chat. */
const ALWAYS_HINT: Partial<Record<MomoActionScope, string>> = {
  '30d': 'For 30 days, in every MoMo chat',
  today: 'Until tonight, in every MoMo chat',
};

export interface MomoActionChoice {
  scope: MomoActionScope;
  label: string;
  hint?: string;
}

/**
 * The card's choices, as Muse's card has them: Allow once, Allow for this chat and Always allow (the widest scope past this
 * chat the rule allows) as buttons; any other scope goes under More options. Once is always offered.
 */
export function momoActionChoices(
  scopes: readonly MomoActionScope[],
  host?: string,
  blocked = false,
): { shown: MomoActionChoice[]; more: MomoActionChoice[] } {
  // a card that can't be allowed offers nothing but Deny
  if (blocked) return { shown: [], more: [] };
  const shown: MomoActionChoice[] = [{ scope: 'once', label: SCOPE_LABEL.once }];
  if (scopes.includes('site')) shown.push({ scope: 'site', label: siteScopeLabel(host), hint: 'Opening pages here, in every MoMo chat' });
  if (scopes.includes('chat')) shown.push({ scope: 'chat', label: SCOPE_LABEL.chat });
  const wide = (['30d', 'today'] as const).filter((s) => scopes.includes(s));
  if (wide.length) shown.push({ scope: wide[0], label: 'Always allow', hint: ALWAYS_HINT[wide[0]] });
  const more = wide.slice(1).map((scope) => ({ scope, label: SCOPE_LABEL[scope] }));
  return { shown, more };
}
