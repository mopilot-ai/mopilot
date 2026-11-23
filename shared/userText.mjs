// What the user typed, from a user message as the thread holds it. Pure, so main reads messages with it
// too (the handoff record, electron/session/switch.cjs); src/lib/format.ts re-exports it.
import { maskMarkdownCode } from './markdownProse.mjs';
import { parseJson } from './jsonRecord.mjs';
import { parseDiffComments } from './diffComments.mjs';
import { hiddenBlockSource } from './hiddenBlock.mjs';
import { ATTACHED_FILES_TAG } from './attachedFiles.mjs';

const HIDDEN_BLOCK_TAGS = [
  'sage-chat-context',
  'sage-computer-history',
  'momo-context',
  'sage-browser-handoff',
  'sage-linked-sessions',
  'sage-routine-hint',
  ATTACHED_FILES_TAG,
];
const hidden = new RegExp(
  `^\\s*(?:<sage-handoff\\b[^>]*>[\\s\\S]*?</sage-handoff>\\s*|${HIDDEN_BLOCK_TAGS.map(hiddenBlockSource).join('|')})`,
);

/** Strip the `/bin/zsh -lc "..."` wrapper Codex puts around shell commands. */
export function prettyCommand(cmd) {
  const m = /^(?:\/bin\/)?(?:ba|z)?sh -l?c (['"])([\s\S]*)\1$/.exec(cmd.trim());
  if (m) return m[2].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  return cmd;
}

/**
 * A message without the blocks the app sends ahead of the user's own text for the agent alone: a mid-chat switch's
 * handoff record (design §05), referenced chats, shared Computer History memories (shared/computerHistory.mjs), MoMo's
 * memory (shared/momoContext.mjs), a
 * "Continue in Chrome" routing note (shared/chromeHandoff.mjs continueMessage) and the linked sessions' status
 * (shared/sideSessions.mjs withRosterBlock) and a saved routine's hint (routineMatch.cjs).
 * @param {string} raw
 */
export function withoutHiddenBlocks(raw) {
  for (let block = hidden.exec(raw); block; block = hidden.exec(raw)) raw = raw.slice(block[0].length);
  return raw;
}

/**
 * The official app prepends context sections to user messages — `<in-app-browser-context>`,
 * `# Chrome tabs:`, `# Files mentioned by the user:`, `# Response annotations:`, `# Diff comments:`,
 * `# Selected text:` — followed by a `## My request:` header. Recover what the user typed, plus the
 * annotations (diff comments among them, with their file), files and selected-text snippets.
 */
export function parseUserText(raw) {
  raw = withoutHiddenBlocks(raw);
  const out = parseContextSections(raw);
  // the request after a context preamble (a selection, an annotation) may start with a hidden block too
  out.text = withoutHiddenBlocks(out.text);
  // The official app records async question answers as an XML-wrapped JSON array.
  // Keep readable copy/edit text, with metadata for the combined question/answer bubble.
  // Masking only blanks text, so a marker that isn't in a message is not in its mask: each mask here is made only for a
  // message that has the marker. This runs for every message of a chat, and a parse is far slower than the rest of it.
  let bodyMarkers = null;
  out.text = out.text.replace(
    /<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>/g,
    (block, json, offset) => {
      bodyMarkers ??= maskMarkdownCode(out.text);
      if (bodyMarkers[offset] !== '<') return block;
      try {
        const entries = JSON.parse(json);
        if (
          !Array.isArray(entries) ||
          !entries.length ||
          !entries.every((entry) => entry && typeof entry.question === 'string' && typeof entry.answer === 'string')
        )
          return block;
        if (entries.length === 1) {
          if (out.text.trim() === block) {
            out.questionReply = { question: entries[0].question, annotationIndex: out.annotations.length };
          }
          out.annotations.push({ text: entries[0].question, annotation: undefined });
          return entries[0].answer;
        }
        // Keep multiple questions beside their answers, including when copied or edited.
        return entries.map((entry) => `${entry.question}\n${entry.answer}`).join('\n\n');
      } catch {
        return block;
      }
    },
  );
  const replies = extractReplyQuotes(out.text);
  if (replies) {
    out.text = replies.text;
    out.annotations = [...out.annotations, ...replies.annotations];
  }
  // the line Chrome's side panel adds naming the tab it was on (electron/capabilities/browser/chromePanel.cjs tabLine)
  const tab = CHROME_TAB.exec(out.text);
  if (tab) {
    out.text = out.text.slice(0, tab.index) + out.text.slice(tab.index + tab[0].length);
    out.chromeTab = tab[1];
  }
  return out;
}

/**
 * The side panel's tab line after a blank line, `[Chrome tab: <http(s) address>]`: at the message's end, or before only
 * the lines Claude Code adds after the text for its attachments (electron/harness/claude/message.cjs: `@<path>`, or
 * `[<name> couldn't be attached]`).
 */
const CHROME_TAB = /\n\n\[Chrome tab: (https?:\/\/\S+)\](?=(?:\n(?:@.+|\[[^\n]+ couldn't be attached\]))*\s*$)/;

/**
 * Quote-replies from Claude desktop: a `<!-- reply N -->` marker line followed by `>` quote lines.
 * Each quote becomes an annotation; with several quotes, the text after a quote (up to the next
 * marker) is that quote's comment, and the text after the last quote is the message itself.
 * Plain Markdown quotes without a marker are left alone.
 */
export function extractReplyQuotes(raw) {
  if (!raw.includes('<!-- reply ')) return null;
  const markers = maskMarkdownCode(raw);
  if (!/^<!-- reply \d+ -->[ \t]*$/m.test(markers)) return null;
  const lines = raw.split(/\r?\n/);
  const markerLines = markers.split(/\r?\n/);
  const before = [];
  const quotes = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^<!-- reply \d+ -->[ \t]*$/.test(markerLines[i])) {
      const q = [];
      while (i + 1 < lines.length && /^>/.test(lines[i + 1])) q.push(lines[++i].replace(/^> ?/, ''));
      quotes.push({ text: q.join('\n').trim(), after: [] });
    } else (quotes.length ? quotes[quotes.length - 1].after : before).push(lines[i]);
  }
  const annotations = quotes
    .filter((q) => q.text)
    .map((q, i, all) => ({ text: q.text, annotation: i < all.length - 1 ? q.after.join('\n').trim() || undefined : undefined }));
  // the marker test above guarantees at least one quote
  const tail = quotes[quotes.length - 1].after.join('\n').trim();
  return { text: [before.join('\n').trim(), tail].filter(Boolean).join('\n\n'), annotations };
}

function parseContextSections(raw) {
  const out = { text: raw, annotations: [], files: [], selections: [] };
  // Older plain-text selections have no framing; keep their original separator fallback for unfinished Markdown.
  const header = raw.includes('## My request:')
    ? (/^## My request:[ \t]*$/m.exec(maskMarkdownCode(maskContextPayloads(raw))) ?? /^## My request:[ \t]*$/m.exec(raw))
    : null;
  const preamble = header ? raw.slice(0, header.index).trim() : '';
  if (
    header &&
    /^(<[\w-]+-context\b|# (Response annotations|Files mentioned by the user|Chrome tabs|Diff comments|Selected text):)/.test(preamble)
  ) {
    const request = raw.slice(header.index + header[0].length);
    const requestMarkers = maskMarkdownCode(request);
    out.text = request
      .replace(/<image name=\[Image #\d+\][^>]*>\s*(<\/image>)?/g, (block, _end, offset) => (requestMarkers[offset] === '<' ? '' : block))
      .replace(/^(?:[ \t]*\r?\n)+/, '')
      .trimEnd();
    const preambleMarkers = maskMarkdownCode(maskContextPayloads(preamble));
    const json = [...preamble.matchAll(/<response-annotations>\s*([\s\S]*?)\s*<\/response-annotations>/g)].find(
      (m) => preambleMarkers[m.index] === '<',
    )?.[1];
    // malformed annotations (not a JSON list): the message text shows without them
    const parsed = json ? parseJson(json) : null;
    if (parsed?.ok && Array.isArray(parsed.value))
      out.annotations = parsed.value.filter((a) => a?.text).map((a) => ({ text: a.text, annotation: a.annotation || undefined }));
    out.annotations.push(
      ...parseDiffComments(
        contextSection(
          preamble,
          /^# Diff comments:\n/m,
          /^# (?:Response annotations|Files mentioned by the user|Chrome tabs|Selected text|Browser comments|Failing PR checks):/m,
        ),
      ),
    );
    const files = contextSection(preamble, /^# Files mentioned by the user:\n/m, /^# /m);
    const fileMarkers = maskMarkdownCode(files);
    for (const m of files.matchAll(/^## (.+?): ((?:\/|[A-Za-z]:[\\/]).+)$/gm))
      if (fileMarkers[m.index] === '#') out.files.push({ name: m[1], path: m[2] });
    // `## Selection N` snippets run until the next known section, since a snippet may contain its own headings
    const selected = contextSection(
      preamble,
      /^# Selected text:\n/m,
      /^# (?:Response annotations|Files mentioned by the user|Chrome tabs|Diff comments|Browser comments|Failing PR checks):/m,
    );
    const payload = /^\s*<selected-text>\s*([\s\S]*?)\s*<\/selected-text>\s*$/.exec(selected);
    if (payload) {
      try {
        const values = JSON.parse(payload[1]);
        out.selections = Array.isArray(values) && values.every((v) => typeof v === 'string') ? values : [selected.trim()];
      } catch {
        out.selections = [selected.trim()];
      }
      return out;
    }
    const snippets = [...maskMarkdownCode(selected).matchAll(/^## Selection \d+.*$/gm)];
    out.selections = snippets.map((m, i) => selected.slice(m.index + m[0].length, snippets[i + 1]?.index).trim());
    return out;
  }
  // Older messages: leading ambient `<*-context>` blocks without a recognised preamble.
  const block = /^\s*<([\w-]+-context)\b[^>]*>[\s\S]*?<\/\1>\s*/;
  let t = raw;
  for (let m = block.exec(t); m; m = block.exec(t)) t = t.slice(m[0].length);
  if (t !== raw) out.text = t.replace(/^#+\s*My request:[ \t]*\n?/, '').trim();
  return out;
}

/** A transport section ends at the next prose heading, never a heading inside a selected code example. */
function contextSection(text, heading, nextHeading) {
  const markers = maskMarkdownCode(maskContextPayloads(text));
  const start = heading.exec(markers);
  if (!start) return '';
  const offset = start.index + start[0].length;
  const end = nextHeading.exec(markers.slice(offset));
  return text.slice(offset, end ? offset + end.index : undefined);
}

/** Metadata payloads are JSON, so their backticks cannot open Markdown code across a transport separator. */
function maskContextPayloads(text) {
  return text.replace(
    /<(response-annotations|selected-text)>([\s\S]*?)<\/\1>/g,
    (_block, tag, payload) => `<${tag}>${payload.replace(/[^\r\n]/g, ' ')}</${tag}>`,
  );
}
