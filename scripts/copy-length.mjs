// The user-facing prose in a source file, measured for the copy-length guard (tests/copyLength.test.ts, docs/ui-copy.md).
import { parseAst } from 'rolldown/parseAst';

/** What a `${…}` or `{…}` inside a measured string counts as: about the length of a site, app or harness name. */
export const SLOT = 8;
/** Attributes that hold code, not words. */
const CODE_ATTRS = new Set(['className', 'd', 'href', 'style', 'key', 'id', 'role', 'type', 'src', 'name', 'value', 'data-kind']);
/** Calls whose strings only reach the log: console.*, and the helpers that note an ignored failure. */
const DIAGNOSTIC = new Set(['ignoring', 'noteIgnored']);
/** Prose: three words or more. */
const PROSE = /\S+\s+\S+\s+\S+/;

/** @param {any} n */
const diagnostic = (n) => (n.callee.type === 'MemberExpression' ? n.callee.object.name === 'console' : DIAGNOSTIC.has(n.callee.name));

/**
 * Every prose string in `text` (string and template literals, and JSX text with its `{…}` slots), whitespace folded,
 * with its line. A template's or JSX run's expressions count as SLOT characters each.
 * @param {string} text
 * @param {string} file
 * @returns {{ line: number; text: string; length: number }[]}
 */
export function proseStrings(text, file) {
  /** @type {{ line: number; text: string; length: number }[]} */
  const out = [];
  const lineAt = (/** @type {number} */ pos) => text.slice(0, pos).split('\n').length;
  /** @param {number} pos @param {string} s @param {number} slots */
  const add = (pos, s, slots) => {
    const folded = s.replace(/\s+/g, ' ').trim();
    if (PROSE.test(folded)) out.push({ line: lineAt(pos), text: folded, length: folded.length + slots * SLOT });
  };
  /** @param {any} n */
  const visit = (n) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) return n.forEach(visit);
    if (n.type === 'ImportDeclaration' || n.type === 'ExportAllDeclaration' || (n.type === 'ExportNamedDeclaration' && n.source)) return;
    if (n.type === 'JSXAttribute' && CODE_ATTRS.has(n.name.name)) return;
    if (n.type === 'CallExpression' && diagnostic(n)) return;
    if (n.type === 'Literal' && typeof n.value === 'string') return add(n.start, n.value, 0);
    if (n.type === 'TemplateLiteral') {
      add(n.start, n.quasis.map((q) => q.value.raw).join(''), n.expressions.length);
      return visit(n.expressions);
    }
    if (n.type === 'JSXElement' || n.type === 'JSXFragment') {
      visit(n.openingElement);
      // a run of text and {…} between child elements reads as one line
      let run = { start: -1, text: '', slots: 0 };
      const flush = () => {
        if (run.start >= 0) add(run.start, run.text, run.slots);
        run = { start: -1, text: '', slots: 0 };
      };
      for (const c of n.children) {
        // a {/* comment */} is not a break in the line
        if (c.type === 'JSXExpressionContainer' && c.expression.type === 'JSXEmptyExpression') continue;
        if (c.type === 'JSXText') {
          if (run.start < 0 && c.value.trim()) run.start = c.start + c.value.search(/\S/);
          run.text += c.value;
        } else if (c.type === 'JSXExpressionContainer') {
          if (run.start < 0) run.start = c.start;
          run.slots++;
          run.text += ' ';
          visit(c.expression);
        } else {
          flush();
          visit(c);
        }
      }
      return flush();
    }
    for (const k of Object.keys(n)) if (k !== 'type' && k !== 'start' && k !== 'end') visit(n[k]);
  };
  visit(parseAst(text, { lang: file.endsWith('x') ? 'tsx' : 'ts' }, file));
  return out;
}
