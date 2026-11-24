// What "the same kind of notice" means for a sender, and how it is written as a pattern key: the sender's domain, except for public mail services (gmail.com and the like), where a domain is thousands of unrelated people, so the full address is the key. Everything is normalised (case, trailing dots, internationalised names to punycode) and a key is built only from characters that cannot add a separator or an instruction, so a crafted address cannot change the pattern or the label shown on the Rules page.
import { domainToASCII } from 'node:url';

/** The prefix of every sender pattern. */
export const SENDER_PREFIX = 'notice:sender:';
/**
 * Where a domain is not one sender: public mailbox providers (a gmail.com address is any of a billion people) and shared-hosting names (every github.io page is somebody else's), so the key there is the full address. To add one, put its domain in the matching list below (a provider with country variants, like outlook.fr or yahoo.co.jp, goes in `PUBLIC_MAIL_FAMILIES`); a domain *under* a shared-hosting suffix (`foo.github.io`) is one owner's and keys on its own.
 */
export const PUBLIC_MAIL_DOMAINS: ReadonlySet<string> = new Set([
  'gmail.com',
  'googlemail.com',
  'live.com',
  'msn.com',
  'ymail.com',
  'rocketmail.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
  'protonmail.ch',
  'pm.me',
  'hey.com',
  'fastmail.com',
  'fastmail.fm',
  'tutanota.com',
  'tuta.io',
  'gmx.com',
  'gmx.net',
  'gmx.de',
  'web.de',
  't-online.de',
  'freenet.de',
  'mail.com',
  'mail.ru',
  'inbox.ru',
  'list.ru',
  'bk.ru',
  'yandex.com',
  'yandex.ru',
  'rambler.ru',
  'zoho.com',
  'naver.com',
  'daum.net',
  'hanmail.net',
  'kakao.com',
  'qq.com',
  'vip.qq.com',
  'foxmail.com',
  '163.com',
  '126.com',
  '188.com',
  'yeah.net',
  'aliyun.com',
  'sina.com',
  'sina.cn',
  'sohu.com',
  'comcast.net',
  'verizon.net',
  'att.net',
  'sbcglobal.net',
  'bellsouth.net',
  'cox.net',
  'charter.net',
  'earthlink.net',
  'btinternet.com',
  'sky.com',
  'orange.fr',
  'free.fr',
  'laposte.net',
  'wanadoo.fr',
  'libero.it',
  'virgilio.it',
  'seznam.cz',
  'wp.pl',
  'o2.pl',
  'interia.pl',
  'rediffmail.com',
  '189.cn',
  '139.com',
  'tom.com',
  '21cn.com',
  'gmx.at',
  'gmx.ch',
  'gmx.co.uk',
  'gmx.fr',
  'gmx.es',
  'gmx.it',
]);
/** Providers that have a mailbox domain in many countries: outlook.fr, hotmail.co.uk, yahoo.co.jp, live.com.au and the like. */
export const PUBLIC_MAIL_FAMILIES: readonly RegExp[] = [
  // outlook.fr, hotmail.co.uk, yahoo.co.jp, live.com.au: a provider name over a country or second-level suffix (never yahoo.dev, a company's own tld)
  /^(outlook|hotmail|live|yahoo|msn)\.(?:com?\.)?(?:[a-z]{2}|com|net|org)$/,
  /^aol\.(?:[a-z]{2}|co\.uk|com\.au|com)$/,
  /^gmx\.(?:[a-z]{2}|com|net)$/,
];
/** Shared-hosting and platform suffixes: the name alone is no one owner (mail from `github.io` itself, `blogspot.com`, `amazonaws.com`). */
export const SHARED_HOSTING_DOMAINS: ReadonlySet<string> = new Set([
  'github.io',
  'githubusercontent.com',
  'gitlab.io',
  'blogspot.com',
  'wordpress.com',
  'wixsite.com',
  'weebly.com',
  'tumblr.com',
  'web.app',
  'firebaseapp.com',
  'pages.dev',
  'workers.dev',
  'vercel.app',
  'netlify.app',
  'herokuapp.com',
  'azurewebsites.net',
  'appspot.com',
  'amazonaws.com',
  'cloudfront.net',
  'fly.dev',
  'onrender.com',
  'glitch.me',
  'repl.co',
]);

/** Whether a (normalised) domain is no one sender: its mail is keyed on the full address. @param {string} domain */
export const isPublicMail = (domain: string): boolean =>
  PUBLIC_MAIL_DOMAINS.has(domain) || SHARED_HOSTING_DOMAINS.has(domain) || PUBLIC_MAIL_FAMILIES.some((re) => re.test(domain));

const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const DOMAIN = new RegExp(`^(?=.{3,80}$)${LABEL}(?:\\.${LABEL})+$`);
const LOCAL = /^[a-z0-9._%+-]{1,64}$/;

/** A domain written in its one plain form, or null when it is not a real domain name. @param {unknown} value */
export function normalDomain(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const ascii = domainToASCII(value.trim().toLowerCase().replace(/\.+$/, ''));
  return DOMAIN.test(ascii) ? ascii : null;
}

/** An address in its one plain form (lower case, domain in punycode), or null. @param {unknown} value */
export function normalAddress(value: unknown): { address: string; domain: string } | null {
  if (typeof value !== 'string') return null;
  const at = value.trim().lastIndexOf('@');
  if (at < 1) return null;
  const local = value.trim().slice(0, at).toLowerCase();
  const domain = normalDomain(value.trim().slice(at + 1));
  return domain && LOCAL.test(local) ? { address: `${local}@${domain}`, domain } : null;
}

export interface SenderKey {
  /** The pattern the reactions are counted under. */
  pattern: string;
  /** What the Rules page says: "mail from acme.com" or "mail from ana@gmail.com". */
  label: string;
  domain: string;
  /** Set only for a public mail service: the sender's full address. */
  address: string | null;
}

/** The key of a sender, or null when there is nothing usable (a public mail service with no address, a name that is not a domain). */
export function senderKey(input: { domain?: unknown; address?: unknown }): SenderKey | null {
  const full = normalAddress(input.address);
  const domain = normalDomain(input.domain) ?? full?.domain ?? null;
  if (!domain) return null;
  if (!isPublicMail(domain)) return { pattern: `${SENDER_PREFIX}${domain}`, label: `mail from ${domain}`, domain, address: null };
  if (!full || full.domain !== domain) return null;
  return { pattern: `${SENDER_PREFIX}address:${full.address}`, label: `mail from ${full.address}`, domain, address: full.address };
}

/** Whether a pattern is a sender pattern this module made (and so is safe to read back), and what sender it names. @param {string} pattern */
export function senderOfPattern(pattern: string): { domain: string; address: string | null } | null {
  if (!pattern.startsWith(SENDER_PREFIX)) return null;
  const rest = pattern.slice(SENDER_PREFIX.length);
  if (rest.startsWith('address:')) {
    const full = normalAddress(rest.slice('address:'.length));
    return full && isPublicMail(full.domain) && `address:${full.address}` === rest ? { domain: full.domain, address: full.address } : null;
  }
  const domain = normalDomain(rest);
  return domain && domain === rest && !isPublicMail(domain) ? { domain, address: null } : null;
}

/** The domains and addresses a piece of the owner's words names, as whole words: "notacme.com" is not "acme.com" and "bana@gmail.com" is not "ana@gmail.com". */
export function namedSenders(text: string): { domains: Set<string>; addresses: Set<string> } {
  const domains = new Set<string>();
  const addresses = new Set<string>();
  // a name is a run of the characters a domain or an address is written with; anything else ends it (a space, `/`, `*`, `|`, a dash, Chinese or full-width punctuation, a Chinese word right after it)
  for (const raw of text.toLowerCase().match(/[a-z0-9\u00c0-\u024f][a-z0-9\u00c0-\u024f._%+@-]*/g) ?? []) {
    const word = raw.replace(/^[.@]+/, '').replace(/\.+$/, '');
    if (word.includes('@')) {
      const full = normalAddress(word);
      if (full) addresses.add(full.address);
    } else {
      const domain = normalDomain(word);
      if (domain) domains.add(domain);
    }
  }
  return { domains, addresses };
}

/** Whether the owner's words name this sender: an address names only that address (never "bana@" for "ana@", and never a whole public mail service). A domain-wide sender is named by its domain, and also by an address at it: the more specific wish wins, and a domain-wide quiet rule would otherwise silence mail the owner asked to hear. A longer name that ends the same way (`notacme.com`) names nothing. */
export function namesSender(text: string, who: { domain: string; address: string | null }): boolean {
  const named = namedSenders(text);
  if (who.address) return named.addresses.has(who.address);
  return named.domains.has(who.domain) || [...named.addresses].some((a) => a.endsWith(`@${who.domain}`));
}
