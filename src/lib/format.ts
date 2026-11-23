// Path helpers live in ./paths (POSIX and Windows paths). The only runtime import here has an explicit
// extension: unit tests load this file directly with Node's type stripping, which doesn't resolve
// extensionless paths. Parsing a user message (parseUserText, prettyCommand) is in shared/userText.mjs,
// since main reads messages with it too (the handoff record).
import { comboFromEvent as shortcutCombo } from '../../shared/shortcutKeys.mjs';
import { parseUserText as parseUserTextUncached, type ParsedUserText } from '../../shared/userText.mjs';
import { installedNative } from './native';
export { extractReplyQuotes, prettyCommand } from '../../shared/userText.mjs';
export type { ResponseAnnotation, ParsedUserText } from '../../shared/userText.mjs';

/** The app runs on macOS (the bridge's platform; see ./platform, which this mirrors), read when asked. */
const onMac = () => (installedNative()?.platform || 'darwin') === 'darwin';

export function formatDuration(ms: number | null | undefined) {
  if (ms == null || !isFinite(ms)) return '';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m < 60) return r ? `${m}m ${r}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/** How long ago `sec` (Unix seconds, not ms) was, as now, 5m, 3h, 2d, 1w, 4mo or 2y. */
export function relativeTime(sec: number | null | undefined) {
  if (!sec) return '';
  const d = Date.now() / 1000 - sec;
  if (d < 60) return 'now';
  if (d < 3600) return `${Math.floor(d / 60)}m`;
  if (d < 86400) return `${Math.floor(d / 3600)}h`;
  if (d < 86400 * 7) return `${Math.floor(d / 86400)}d`;
  if (d < 86400 * 30) return `${Math.floor(d / 86400 / 7)}w`;
  if (d < 86400 * 365) return `${Math.floor(d / 86400 / 30)}mo`;
  return `${Math.floor(d / 86400 / 365)}y`;
}

/**
 * A count in short form: 950, 1.2k (`kDigits` decimals), 165.4k, 2.1M. The unit is picked after rounding, so
 * 999,950 reads 1M, not 1000k.
 */
export function compactCount(n: number, kDigits = 1): string {
  if (n < 1000) return String(n);
  const k = Number((n / 1000).toFixed(kDigits));
  return k < 1000 ? `${k}k` : `${Number((n / 1_000_000).toFixed(1))}M`;
}

export function formatTokens(n: number) {
  return compactCount(n, n >= 10000 ? 0 : 1);
}

// named the same in the Chrome side panel's menu (shared/modelLabels.mjs)
export { modelLabel, EFFORT_LABELS, effortLabel } from '../../shared/modelLabels.mjs';

export function pluralize(n: number, word: string, plural = word + 's') {
  return `${n} ${n === 1 ? word : plural}`;
}

const PARSED_TEXTS = 512;
/** A longer message is parsed each time rather than held: the cache keeps its key. */
const PARSED_TEXT_CHARS = 16_000;
const parsedTexts = new Map<string, ParsedUserText>();

/**
 * parseUserText (shared/userText.mjs) remembered per message text: a sent message never changes, yet the thread's
 * selectors and renders read it on every store commit while any chat streams. The result is shared, so callers read
 * it and never modify it. The oldest of PARSED_TEXTS entries goes first.
 */
export function parseUserText(raw: string): ParsedUserText {
  const hit = parsedTexts.get(raw);
  if (hit) return hit;
  const parsed = parseUserTextUncached(raw);
  if (raw.length <= PARSED_TEXT_CHARS) {
    if (parsedTexts.size >= PARSED_TEXTS) parsedTexts.delete(parsedTexts.keys().next().value as string);
    parsedTexts.set(raw, parsed);
  }
  return parsed;
}

/** What the user typed, without the context sections the official app prepends. */
export function stripInjectedContext(text: string): string {
  return parseUserText(text).text;
}

/**
 * The mark shown next to a link: the site's first letter on a colour taken from its name. Drawn
 * locally, so no link domain in a chat is sent to anyone (no favicon service, no request to the site).
 */
export function linkMark(href: string): { letter: string; hue: number } | null {
  try {
    const { protocol, hostname } = new URL(href);
    if (!/^https?:$/.test(protocol) || !hostname) return null;
    const name = hostname.replace(/^www\./i, '');
    let h = 0;
    for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
    return { letter: (name.match(/[a-z0-9]/i)?.[0] ?? '?').toUpperCase(), hue: h };
  } catch {
    return null;
  }
}

/** Voice-mode handoffs arrive as `<realtime_delegation>` user messages; recover what was said. */
export function parseDelegation(text: string): { flush: boolean; input: string } | null {
  const t = text.trimStart();
  if (!t.startsWith('<realtime_delegation>')) return null;
  const flush = /<source>\s*transcript_tail_flush\s*<\/source>/.test(t);
  const input = /<input>([\s\S]*?)<\/input>/.exec(t)?.[1]?.trim() ?? '';
  return { flush, input };
}

/** Normalize physical keys consistently with native menu and browser input. */
export function comboFromEvent(e: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>, mac = onMac()) {
  return shortcutCombo(e, mac);
}
