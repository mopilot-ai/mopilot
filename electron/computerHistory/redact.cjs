// Computer History's redaction (#1363): what of a window title or a page address may be kept. Control characters and angle brackets go (a title must never close the context block it is later quoted in), as do token-like strings, long digit runs (card and account numbers), one-time codes and email addresses; an address keeps its host and path only.

const TITLE_MAX = 120;
const PATH_MAX = 120;

/** A word that looks like a secret: 24+ characters of a token alphabet with both letters and digits. */
const TOKEN = /\b(?=[A-Za-z0-9_\-+/=]*\d)(?=[A-Za-z0-9_\-+/=]*[A-Za-z])[A-Za-z0-9_\-+/=]{24,}\b/g;
/** 12 or more digits, possibly grouped by spaces or dashes (card, account and phone numbers). */
const DIGIT_RUN = /\d(?:[ -]?\d){11,}/g;
/** A 4-8 digit code next to a word that marks it as one. */
const CODE = /\b(code|otp|pin|passcode|verification|verify|2fa)\b(\W{0,3})\d{4,8}\b|\b\d{4,8}\b(?=\W{0,3}\b(is your|code)\b)/gi;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** At most `max` characters (by code point), with an ellipsis when cut. */
function cut(text, max) {
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : text;
}

/**
 * A window or page title as Computer History keeps it, or '' when nothing is left.
 * @param {unknown} title
 */
function redactTitle(title) {
  if (typeof title !== 'string') return '';
  // a title is cut long before the patterns below run, so an app's huge title costs little
  const t = title
    .slice(0, TITLE_MAX * 8)
    // control and format characters (bidi overrides included), then the brackets a wrapper tag needs
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/</g, '‹')
    .replace(/>/g, '›')
    .replace(EMAIL, '[email]')
    .replace(TOKEN, '[redacted]')
    .replace(DIGIT_RUN, '[number]')
    .replace(CODE, (m, word, gap) => (word ? `${word}${gap}[code]` : '[code]'))
    .replace(/\s+/g, ' ')
    .trim();
  return cut(t, TITLE_MAX);
}

/** A path segment's percent escapes decoded as UTF-8; a malformed one stays as it is, bytes that are no UTF-8 become U+FFFD. */
function decodeSegment(segment) {
  const bytes = [];
  const enc = new TextEncoder();
  for (let i = 0; i < segment.length; i++) {
    const hex = segment.slice(i + 1, i + 3);
    if (segment[i] === '%' && /^[0-9a-f]{2}$/i.test(hex)) {
      bytes.push(parseInt(hex, 16));
      i += 2;
    } else bytes.push(...enc.encode(segment[i]));
  }
  return new TextDecoder().decode(Uint8Array.from(bytes));
}

/**
 * A page's site and path as Computer History keeps them (the path decoded, for reading), or null for anything but
 * http(s): no user name or password, no query, no fragment; path segments are redacted like titles.
 * @param {unknown} url
 * @returns {{ site: string, path: string } | null}
 */
function cleanUrl(url) {
  if (typeof url !== 'string' || !url) return null;
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const site = u.hostname.toLowerCase().replace(/\.$/, '');
  if (!site) return null;
  const segments = u.pathname
    .split('/')
    .filter(Boolean)
    .map((s) => redactTitle(decodeSegment(s)))
    .filter(Boolean);
  return { site, path: cut(`/${segments.join('/')}`, PATH_MAX) };
}

module.exports = { redactTitle, cleanUrl, decodeSegment, TITLE_MAX, PATH_MAX };
