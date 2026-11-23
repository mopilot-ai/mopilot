// Readable messages from native automation heartbeat envelopes, without changing transcripts or literal code examples.
import { maskMarkdownCode } from './markdownProse.mjs';

const OPEN = '<heartbeat>';
const HEADER =
  /^<heartbeat>\s*<automation_id>[^<>\s](?:[^<>]*[^<>\s])?<\/automation_id>\s*<decision>\s*(?:NOTIFY|DONT_NOTIFY)\s*<\/decision>\s*<message>/;
const CLOSE = /<\/message>\s*<\/heartbeat>\s*$/;

/**
 * Only the documented single terminal envelope is unwrapped; arbitrary XML and saved malformed replies stay literal.
 * A complete opening tag identifies the envelope; shorter prefixes could still become ordinary text or HTML.
 * While streaming, hold the envelope until the item settles: a quoted closing tag is not proof the stream ended.
 * Decisions describe notification delivery elsewhere; both messages remain readable in chat history.
 * @param {string} text @param {boolean} [streaming] @returns {string}
 */
export function heartbeatMessage(text, streaming = false) {
  if (!text.includes(OPEN)) return text;
  const markers = /<heartbeat>/g;
  let visible;
  for (const match of text.matchAll(markers)) {
    const start = match.index;
    if (start > 0 && (visible ??= maskMarkdownCode(text))[start] !== '<') continue;
    const remaining = text.slice(start);
    const header = HEADER.exec(remaining);
    if (streaming && (header || !remaining.includes('</heartbeat>'))) return text.slice(0, start);
    const end = CLOSE.exec(remaining);
    if (!header || !end) return text;
    const message = remaining.slice(header[0].length, end.index).replace(/^(?:[ \t]*\r?\n)+|(?:\r?\n[ \t]*)+$/g, '');
    if (!message.trim()) return text;
    if (message.includes(OPEN)) {
      // Ignore transport closes when finding code boundaries: a close appended to a code fence must not hide a second envelope.
      const body = message.replace(/<\/message>\s*<\/heartbeat>/g, (close) => close.replace(/[^\r\n]/g, ' '));
      if (maskMarkdownCode(body).includes(OPEN)) return text;
    }
    return text.slice(0, start) + message;
  }
  return text;
}
