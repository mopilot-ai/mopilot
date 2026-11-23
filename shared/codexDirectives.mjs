// Codex answer formatting (heartbeat reports, citations, annotations, follow-ups, visualizations) shared by the renderer and transcript exports.

import { basename } from './paths.mjs';
import { mapProse, maskMarkdownCode } from './markdownProse.mjs';
import { heartbeatMessage } from './heartbeatMessage.mjs';

// The official Codex app has the model write inline directives (generic-directive syntax,
// `:name[label]{key="value" …}`) into its answers:
//   :codex-file-citation{path="/abs/notes.pdf" purpose="source"}   a file the answer relies on
//   :codex-annotation{index="1"}                                   which user annotation a sentence answers
//   :codex-followup[Add tests]{prompt="Add unit tests for the parser"}   a suggested next prompt
//   \uE200visualize\uE202{"path":"/abs/preview.html","mode":"wide"}\uE201   an HTML preview
// Markdown.tsx turns citations/annotations into `codex-directive:` links it renders as chips,
// and lifts follow-ups out into buttons under the message.

/** @typedef {{ name: string, label: string, attrs: Record<string, string> }} Directive */

const ATTR = String.raw`[\w:.-]+(?:\s*=\s*(?:"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|[^\s"'=<>\x60{}]+))?`;
const DIRECTIVE = String.raw`:codex-(file-citation|annotation|followup)(?:\[((?:[^\]\\\n]|\\.)*)\])?\{\s*((?:${ATTR}\s*)*)\}`;
const VISUALIZE = String.raw`\uE200visualize\uE202([^\uE201]*)\uE201`;
const PARTIAL_VISUALIZE = String.raw`(\uE200(?:visualize|v|vi|vis|visu|visua|visual|visuali|visualiz)?(?:\uE202[^\uE201]*)?$)`;
// mapProse excludes code before directive tokens are decoded.
const TOKEN = new RegExp(String.raw`${DIRECTIVE}|${VISUALIZE}|${PARTIAL_VISUALIZE}`, 'g');
// The tail of a directive that is still streaming in.
const PARTIAL = /:codex-[\w-]*(?:\[[^\]\n]*\]?)?(?:\{[^}\n]*)?$/;
const REMOVED = '\u0000';

export const SCHEME = 'codex-directive:';

function parseAttrs(s) {
  /** @type {Record<string, string>} */
  const attrs = {};
  for (const m of s.matchAll(/([\w:.-]+)(?:\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^\s"'=<>`{}]+)))?/g))
    attrs[m[1]] = unescape(m[2] ?? m[3] ?? m[4] ?? '');
  return attrs;
}

// Backslash escapes only apply to ASCII punctuation (so `C:\Users` survives).
const unescape = (/** @type {string} */ s) => s.replace(/\\([!-/:-@[-`{-~])/g, '$1');

/** Rewrite each directive outside code with `render`; returning null drops it (and a line left empty by that). */
/** @param {string} md @param {(d: Directive) => string | null} render @returns {string} */
function rewrite(md, render) {
  const partial = PARTIAL.exec(md);
  const text = partial && maskMarkdownCode(md)[partial.index] === ':' ? md.slice(0, partial.index) : md;
  const out = mapProse(
    text,
    (/** @type {string} */ prose) => {
      const markers = maskMarkdownCode(prose);
      return prose.replace(
        TOKEN,
        (
          /** @type {string} */ whole,
          /** @type {string} */ name,
          /** @type {string} */ label,
          /** @type {string} */ attrs,
          /** @type {string} */ visualization,
          /** @type {string} */ partialVisualization,
          /** @type {number} */ offset,
        ) => {
          if (markers[offset] !== prose[offset]) return whole;
          if (partialVisualization) return REMOVED;
          if (visualization !== undefined) {
            /** @type {Record<string, string>} */
            const values = {};
            try {
              /** @type {unknown} */
              const data = JSON.parse(visualization);
              if (!data || typeof data !== 'object' || Array.isArray(data)) return REMOVED;
              for (const key of ['path', 'mode', 'title']) {
                const value = /** @type {Record<string, unknown>} */ (data)[key];
                if (typeof value === 'string') values[key] = value;
              }
            } catch {
              return REMOVED;
            }
            return render({ name: 'visualize', label: '', attrs: values }) ?? REMOVED;
          }
          return render({ name, label: unescape(label ?? ''), attrs: parseAttrs(attrs) }) ?? REMOVED;
        },
      );
    },
    undefined,
    false,
  );
  if (!out.includes(REMOVED)) return out;
  return out
    .replace(new RegExp(String.raw`^[ \t]*(?:(?:[-*+]|\d+[.)])[ \t]+)?(?:${REMOVED}[ \t]*)+\n?`, 'gm'), '')
    .replaceAll(REMOVED, '')
    .trimEnd();
}

/** Prepare an assistant message for Markdown.tsx: inline directives become links, follow-ups are returned separately. */
/** @param {string} md @param {boolean} [streaming] @returns {{ markdown: string, followups: Directive[] }} */
export function parseDirectives(md, streaming = false) {
  md = heartbeatMessage(md, streaming);
  /** @type {Directive[]} */
  const followups = [];
  if (!md.includes(':codex-') && !md.includes('\uE200')) return { markdown: md, followups };
  const markdown = rewrite(md, (d) => {
    if (d.name === 'followup') {
      if (d.attrs.prompt || d.label) followups.push(d);
      return null;
    }
    return `[](<${SCHEME}${d.name}?${new URLSearchParams(d.attrs)}>)`;
  });
  return { markdown, followups };
}

/** The directive behind a link produced by parseDirectives, if any. */
/** @param {string | undefined} href @returns {Directive | null} */
export function directiveFromHref(href) {
  if (!href?.startsWith(SCHEME)) return null;
  const [name, query = ''] = href.slice(SCHEME.length).split('?', 2);
  return { name, label: '', attrs: Object.fromEntries(new URLSearchParams(query)) };
}

/**
 * Text without directives, for export and previews: file citations and visualizations become
 * Markdown links (or just the file name when `plain`), annotations and follow-ups are dropped.
 */
/** @param {string} md @param {boolean} [plain] @param {{ reply?: boolean, streaming?: boolean }} [options] @returns {string} */
export function stripDirectives(md, plain = false, { reply = true, streaming = false } = {}) {
  if (reply) md = heartbeatMessage(md, streaming);
  if (!md.includes(':codex-') && !md.includes('\uE200')) return md;
  return rewrite(md, (d) => {
    const path = (d.name === 'file-citation' || d.name === 'visualize') && d.attrs.path;
    if (!path) return null;
    if (plain) return basename(path);
    return `[${basename(path).replace(/[\\[\]]/g, '\\$&')}](<${path.replace(/[<>]/g, encodeURIComponent)}>)`;
  });
}
