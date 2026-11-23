// Finds the interface text in a renderer source file and wraps each piece in a catalog lookup (docs/i18n.md).
import { parseSync } from 'rolldown/utils';

/** JSX props whose literal value is shown to the user. */
const TEXT_PROPS = new Set([
  'addLabel',
  'alt',
  'aria-label',
  'closeLabel',
  'desc',
  'description',
  'detail',
  'empty',
  'hint',
  'label',
  'message',
  'placeholder',
  'subtitle',
  'title',
  'tooltip',
  'unsetLabel',
]);
/** Object keys whose literal value is shown to the user, where {@link objectTextIn} says objects hold interface text. */
const TEXT_KEYS = new Set(['desc', 'description', 'detail', 'hint', 'label', 'note', 'placeholder', 'subtitle', 'title', 'tooltip', 'why']);
/** Keys that hold words in some tables and state ids in others (`failed: 'danger'`): only a capitalized value is a word. */
const WORD_KEYS = new Set(['doing', 'done', 'failed', 'verb']);
/** Calls that show arguments to the user, and which. Diagnostics (noteIgnored, ignoring) stay English on purpose. */
const TEXT_CALLS = new Map([
  ['copyText', [1]],
  ['setErr', [0]],
  ['setError', [0]],
  ['setNotice', [0]],
  ['setPageError', [0]],
  ['toast', [0]],
  ['toastFailure', [0]],
]);
/** Names that say a value goes to an agent or a program: whatever it reads like, it isn't interface text. */
export const NOT_FOR_PEOPLE =
  /[Pp]rompt|[Rr]ejection|[Ii]nstruction|[Cc]ommand|[Cc]md|[Qq]uery|[Rr]egex|[Pp]attern|[Uu]rl|URL|[Pp]ath|[Gg]roup|GROUP|[Cc]lass|^id$|Id$|^key$|Key$/;
/** Elements whose content is code or markup, never prose. */
const RAW_ELEMENTS = new Set(['code', 'kbd', 'pre', 'samp', 'script', 'style', 'svg']);
/** Elements React only lets hold text, so a sentence with holes stays one string. */
const STRING_ELEMENTS = new Set(['option', 'textarea', 'title']);
/** A sentence with more holes than this is a layout, not a sentence: its text pieces go one by one. */
const MAX_HOLES = 6;
/** What opts a whole file out, for one whose literals are not interface text. */
export const OPT_OUT = '@no-i18n';

const ENTITIES = {
  amp: '&',
  apos: "'",
  bull: '•',
  copy: '©',
  gt: '>',
  hellip: '…',
  ldquo: '“',
  lsquo: '‘',
  lt: '<',
  mdash: '—',
  middot: '·',
  nbsp: '\u00a0',
  ndash: '–',
  quot: '"',
  rarr: '→',
  rdquo: '”',
  rsquo: '’',
  times: '×',
};
const ENTITY = /&(?:#(\d+)|#x([\da-f]+)|(\w+));/gi;
function entityText(_entity, decimal, hex, name) {
  if (decimal) return String.fromCodePoint(Number(decimal));
  if (hex) return String.fromCodePoint(Number.parseInt(hex, 16));
  return ENTITIES[name];
}
const decodeEntities = (text) => text.replace(ENTITY, (...match) => entityText(...match) ?? match[0]);
/** Text with an entity this can't name stays as written: its key would show the entity itself. */
const knownEntities = (text) => [...text.matchAll(ENTITY)].every((match) => entityText(...match) !== undefined);

/** Is every string in this file's lists interface text, one word too? Search words are the words on screen. */
export const listsTextIn = (file) => /(^|\/)src\/lib\/settingsSearch\.ts$/.test(file);

/** Does this file's object literals hold interface text? Stores and harness code keep ids, prompts and saved data in theirs. */
export const objectTextIn = (file) =>
  /(^|\/)src\/(components\/|harness\/(commands|copy)\.ts$|lib\/(agentNarration\/|(prInbox|scheduleTask|settingsNav|settingsSearch|tasks)\.ts$))/.test(
    file,
  );

/** Is this literal prose rather than an id, a path or a command? @param {string} text */
export function isInterfaceText(text) {
  const trimmed = text.trim();
  if (!/\p{L}{2}/u.test(trimmed) || trimmed.includes('://')) return false;
  if (/^[/.\-#@~$<>(]/.test(trimmed) || /^(sk|xai)-|^(brew|claude|codex|gh|git|npm|npx)( |$)/.test(trimmed)) return false;
  // one word: a label ("Save", "open"), unless it is shaped like an identifier or a path
  return /\s/.test(trimmed) || !/^[a-z]+[A-Z]|[_/\\=.:]\S/.test(trimmed);
}

/** A sentence or a phrase: where only the shape says a literal is interface text, one word could as well be a tool or a key name. */
export const isProse = (text) => /^[A-Z][\p{L}'’-]*[ ,]\s*\S/u.test(text) && isInterfaceText(text);

/** The text JSX keeps of a raw JSXText, by the language's rule: lines are trimmed and joined, blank ones dropped. */
export function jsxText(raw) {
  const lines = raw.split(/\r\n|\n|\r/);
  const kept = [];
  lines.forEach((line, i) => {
    let text = line.replace(/\t/g, ' ');
    if (i > 0) text = text.replace(/^ +/, '');
    if (i < lines.length - 1) text = text.replace(/ +$/, '');
    if (text) kept.push(text);
  });
  return kept.join(' ');
}

const quote = (text) => JSON.stringify(text);
const isString = (node) => node?.type === 'Literal' && typeof node.value === 'string';

/**
 * Wrap the interface text of one source file.
 * @param {string} code the file's source
 * @param {string} file its path, which sets the parser's language and whether objects are read
 * @param {{ runtime?: string }} [options] `runtime`: the module to import the lookups from
 * @returns {{ code: string, messages: string[] }} the rewritten source and the English text it looks up
 */
export function wrapInterfaceText(code, file, { runtime = '' } = {}) {
  if (code.includes(OPT_OUT)) return { code, messages: [] };
  const { program, errors } = parseSync(file, code, { lang: /\.tsx$/.test(file) ? 'tsx' : /\.ts$/.test(file) ? 'ts' : 'jsx' });
  if (errors.length) return { code, messages: [] };
  const objects = objectTextIn(file);
  const lists = listsTextIn(file);
  const messages = new Set();
  /** @type {{ start: number, end: number, text: string }[]} */
  const edits = [];
  const wrapped = new Set();
  const edit = (start, end, text) => edits.push({ start, end, text });
  let lookups = false;

  /** One string the app shows: rewrite the range, remember the message. */
  function lookup(start, end, message, fn = '__t') {
    messages.add(message);
    lookups = true;
    edit(start, end, `${fn}(${quote(message)})`);
  }

  /** The text-bearing branches of an expression: only literals are ever wrapped, so what the app holds at runtime never is. */
  function wrapExpression(node) {
    if (!node || wrapped.has(node)) return;
    wrapped.add(node);
    if (isString(node)) {
      if (isInterfaceText(node.value)) lookup(node.start, node.end, node.value);
    } else if (node.type === 'TemplateLiteral') {
      wrapTemplate(node);
    } else if (node.type === 'ConditionalExpression') {
      wrapExpression(node.consequent);
      wrapExpression(node.alternate);
    } else if (node.type === 'LogicalExpression') {
      if (node.operator !== '&&') wrapExpression(node.left);
      wrapExpression(node.right);
    } else if (['ParenthesizedExpression', 'TSAsExpression', 'TSNonNullExpression', 'TSSatisfiesExpression'].includes(node.type)) {
      wrapExpression(node.expression);
    }
  }

  /** Where only the shape says a literal is interface text: a conditional's branch, a returned or a listed string. */
  function wrapProse(node) {
    if (!objects || !node || wrapped.has(node)) return;
    if (isString(node)) {
      if (isProse(node.value)) wrapExpression(node);
    } else if (node.type === 'TemplateLiteral') {
      if (isProse(node.quasis.map((q) => q.value.cooked).join('x'))) wrapExpression(node);
    } else if (node.type === 'ConditionalExpression') {
      wrapProse(node.consequent);
      wrapProse(node.alternate);
    } else if (node.type === 'LogicalExpression') {
      wrapProse(node.right);
    } else if (node.type === 'ParenthesizedExpression') {
      wrapProse(node.expression);
    }
  }

  /** A word key's value: its capitalized branches are text, and a lower-case one is an id. */
  function wrapCapitalized(node) {
    if (!node) return;
    if (node.type === 'ConditionalExpression') [node.consequent, node.alternate].forEach(wrapCapitalized);
    else if (node.type === 'LogicalExpression') [node.operator === '&&' ? null : node.left, node.right].forEach(wrapCapitalized);
    else if (/^(Parenthesized|TSAs|TSNonNull|TSSatisfies)/.test(node.type)) wrapCapitalized(node.expression);
    else if (/^[A-Z]/.test(isString(node) ? node.value : (node.quasis?.[0].value.cooked ?? ''))) wrapExpression(node);
  }

  /** A value whose name says it isn't for people: its own literals stay, and interface text deeper in it is still read. */
  function leaveAlone(node) {
    if (!node || typeof node.type !== 'string') return;
    if (isString(node) || node.type === 'TemplateLiteral') wrapped.add(node);
    // interface text inside it is still read: what it renders, the toasts it raises and its objects' text keys
    if (/^JSX|^ObjectExpression$/.test(node.type)) return;
    if (node.type === 'CallExpression' && TEXT_CALLS.has(node.callee.type === 'Identifier' ? node.callee.name : '')) return;
    for (const key of Object.keys(node)) {
      if (SKIPPED_KEYS.has(key)) continue;
      const child = node[key];
      if (Array.isArray(child)) child.forEach(leaveAlone);
      else if (child && typeof child === 'object') leaveAlone(child);
    }
  }

  /** `Delete ${name}` becomes one message with a hole, so a translation can move the name. */
  function wrapTemplate(node) {
    const { quasis, expressions } = node;
    const message = quasis.map((q, i) => q.value.cooked + (i < expressions.length ? `{${i}}` : '')).join('');
    const prose = quasis.map((q) => q.value.cooked).join(' ');
    expressions.forEach(wrapExpression);
    if (!isInterfaceText(prose)) return;
    if (!expressions.length) return lookup(node.start, node.end, message);
    messages.add(message);
    lookups = true;
    edit(node.start, expressions[0].start, `__t(${quote(message)},[`);
    for (let i = 1; i < expressions.length; i++) edit(expressions[i - 1].end, expressions[i].start, ',');
    edit(expressions.at(-1).end, node.end, '])');
  }

  /** What a JSX child contributes to its parent's sentence. */
  function classify(node) {
    if (node.type === 'JSXText') {
      const raw = code.slice(node.start, node.end);
      if (!knownEntities(raw)) return { node, kind: 'verbatim', text: '' };
      const text = jsxText(decodeEntities(raw));
      return { node, kind: text ? 'text' : 'blank', text, raw };
    }
    if (node.type === 'JSXSpreadChild') return { node, kind: 'verbatim', text: '' };
    if (node.type === 'JSXExpressionContainer') {
      if (node.expression.type === 'JSXEmptyExpression') return { node, kind: 'blank', text: '' };
      if (isString(node.expression)) return { node, kind: 'literal', text: node.expression.value };
    }
    return { node, kind: 'hole', text: '' };
  }

  /** Where a child's words sit: a JSXText keeps its surrounding whitespace, which JSX gives its own meaning. */
  function wordsOf(item) {
    if (item.kind !== 'text') return { start: item.node.start, end: item.node.end, leading: 0, trailing: 0 };
    const leading = item.raw.search(/\S/);
    const trailing = item.raw.length - item.raw.trimEnd().length;
    return { start: item.node.start + leading, end: item.node.end - trailing, leading, trailing };
  }

  /** A sentence's first or last child: the text between its outer edge's whitespace, left in place, and its other end. */
  function edgeText(item, first, last) {
    if (item.kind !== 'text') return item.text;
    const { leading, trailing } = wordsOf(item);
    return jsxText(decodeEntities(item.raw.slice(first ? leading : 0, item.raw.length - (last ? trailing : 0))));
  }

  /** Children that read as one sentence become one message, so a translation can reorder around what sits inside it. */
  function wrapChildren(element, tag) {
    const items = element.children.map(classify);
    if (items.some((item) => item.kind === 'verbatim')) {
      for (const item of items.filter(({ kind }) => kind === 'hole')) visit(item.node);
      return;
    }
    const prose = (item) => (item.kind === 'text' || item.kind === 'literal') && isInterfaceText(item.text);
    const first = items.findIndex(prose);
    const last = items.findLastIndex(prose);
    const run = first < 0 ? [] : items.slice(first, last + 1);
    const holes = run.filter((item) => item.kind === 'hole');
    const sentence = run.length > 0 && holes.length <= MAX_HOLES;
    if (sentence) wrapSentence(run, holes, STRING_ELEMENTS.has(tag));
    for (const item of items) {
      if (item.kind === 'hole') visit(item.node);
      if (!sentence && item.kind === 'text' && prose(item)) wrapSentence([item], [], false);
      if (!sentence && item.kind === 'literal') wrapExpression(item.node.expression);
      if (item.node.type === 'JSXExpressionContainer' && item.kind === 'hole') wrapExpression(item.node.expression);
    }
  }

  function wrapSentence(run, holes, stringOnly) {
    let index = 0;
    const pieces = run.map((item, i) => (item.kind === 'hole' ? `{${index++}}` : edgeText(item, i === 0, i === run.length - 1)));
    // spaces at a sentence's ends are layout: no translation should have to keep them, and the sentence still needs them
    const whole = pieces.join('');
    const message = whole.trim();
    const lead = whole.slice(0, whole.length - whole.trimStart().length);
    const tail = whole.slice(whole.trimEnd().length);
    const before = lead && `{${quote(lead)}}`;
    const after = tail && `{${quote(tail)}}`;
    const firstWords = wordsOf(run[0]);
    const lastWords = wordsOf(run.at(-1));
    messages.add(message);
    lookups = true;
    if (!holes.length) {
      edit(firstWords.start, lastWords.end, `${before}{__t(${quote(message)})}${after}`);
      return;
    }
    edit(firstWords.start, firstWords.end, `${before}{${stringOnly ? '__t' : '__tj'}(${quote(message)},[`);
    let seen = 0;
    for (const item of run.slice(1, -1)) {
      if (item.kind !== 'hole') {
        edit(item.node.start, item.node.end, '');
        continue;
      }
      if (seen++) edit(item.node.start, item.node.start, ',');
      if (item.node.type === 'JSXExpressionContainer') {
        edit(item.node.start, item.node.start + 1, '(');
        edit(item.node.end - 1, item.node.end, ')');
      }
    }
    edit(run.at(-1).node.start, lastWords.end, `])}${after}`);
  }

  function visitElement(node) {
    const name = node.openingElement.name;
    const tag = name.type === 'JSXIdentifier' ? name.name : '';
    visit(node.openingElement);
    if (!RAW_ELEMENTS.has(tag)) wrapChildren(node, tag);
  }

  function visitAttribute(node) {
    const name = node.name.type === 'JSXIdentifier' ? node.name.name : '';
    const { value } = node;
    if (TEXT_PROPS.has(name)) {
      if (isString(value)) {
        const text = decodeEntities(value.value);
        if (isInterfaceText(text) && knownEntities(value.value)) {
          messages.add(text);
          lookups = true;
          edit(value.start, value.end, `{__t(${quote(text)})}`);
        }
      } else if (value?.type === 'JSXExpressionContainer') wrapExpression(value.expression);
    }
    if (value?.type === 'JSXExpressionContainer') visit(value.expression);
  }

  function visitProperty(node) {
    const key = node.key.type === 'Identifier' ? node.key.name : node.key.value;
    const value = node.value.type === 'AssignmentPattern' ? node.value.right : node.value;
    if (typeof key === 'string' && NOT_FOR_PEOPLE.test(key)) leaveAlone(value);
    else if (objects && !node.computed && !node.method && (!node.shorthand || value !== node.value)) {
      if (TEXT_KEYS.has(key)) wrapExpression(value);
      else if (WORD_KEYS.has(key)) wrapCapitalized(value);
      else wrapProse(value);
    }
    visit(node.value);
  }

  function visitCall(node) {
    const name = node.callee.type === 'Identifier' ? node.callee.name : '';
    for (const index of TEXT_CALLS.get(name) ?? []) wrapExpression(node.arguments[index]);
    // a narration line: what the agent is doing, then what it did (src/lib/agentNarration)
    if (name === 'line' && objects) node.arguments.slice(0, 2).forEach(wrapExpression);
    // a string a developer wrapped by hand: already a lookup, and only its message is collected
    if (name === 't' && isString(node.arguments[0])) messages.add(node.arguments[0].value);
    for (const key of ['callee', 'arguments']) visit(node[key]);
  }

  const SKIPPED_KEYS = new Set(['returnType', 'typeAnnotation', 'typeArguments', 'typeParameters']);
  /** @param {any} node */
  function visit(node) {
    if (Array.isArray(node)) return void node.forEach(visit);
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'JSXElement') return visitElement(node);
    if (node.type === 'JSXFragment') return wrapChildren(node, '');
    if (node.type === 'JSXAttribute') return visitAttribute(node);
    if (node.type === 'Property') return visitProperty(node);
    if (node.type === 'CallExpression') return visitCall(node);
    // only this shape: a component called CommandMenu or PathRow is full of interface text
    if (node.type === 'FunctionDeclaration' && /^[a-z]\w*Prompt$/.test(node.id?.name ?? '')) leaveAlone(node.body);
    if (node.type === 'VariableDeclarator') {
      if (node.id.type === 'Identifier' && NOT_FOR_PEOPLE.test(node.id.name)) leaveAlone(node.init);
      else wrapProse(node.init);
    }
    if (node.type === 'ConditionalExpression') wrapProse(node);
    if (node.type === 'ReturnStatement') wrapProse(node.argument);
    if (node.type === 'ArrowFunctionExpression' && node.expression) wrapProse(node.body);
    if (node.type === 'ArrayExpression') node.elements.forEach(lists ? wrapExpression : wrapProse);
    if (/^(Import|Export(All|Named)Declaration$|TS(Interface|TypeAlias|Declare|Enum|Module))/.test(node.type) && !node.declaration) return;
    for (const key of Object.keys(node)) if (!SKIPPED_KEYS.has(key)) visit(node[key]);
  }

  visit(program.body);
  if (!lookups) return { code, messages: [...messages] };
  edits.sort((a, b) => a.start - b.start || a.end - b.end);
  let out = '';
  let at = 0;
  for (const { start, end, text } of edits) {
    out += code.slice(at, start) + text;
    at = end;
  }
  out += code.slice(at);
  // an import hoists, so it can go last, where it moves no line of the file
  if (runtime) out += `\nimport { __t, __tj } from ${quote(runtime)};\n`;
  return { code: out, messages: [...messages] };
}
