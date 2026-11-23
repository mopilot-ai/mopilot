// Self-contained serialized REPL transformations for persistent declarations and returned expressions.

/**
 * Top-level declarations made to outlive the call, as in a REPL: `let`/`const`/`var` statements at the
 * top level become assignments to the context's globals (`;(a = 1, b = undefined)`), classes become
 * `C = class C {…};`, and function declarations are copied to globals at the start (they are hoisted).
 * Only the code's own text moves: line numbers stay. Strings, comments, templates and regular
 * expressions are skipped. The caller falls back to the code as is when the result doesn't compile.
 */
function persist(code) {
  // the code with strings, templates, comments and regular expressions blanked (same length)
  let m = '';
  let prev = '';
  for (let i = 0; i < code.length; ) {
    const c = code[i];
    let end = -1;
    if (c === '/' && code[i + 1] === '/') {
      end = code.indexOf('\n', i);
      if (end < 0) end = code.length;
    } else if (c === '/' && code[i + 1] === '*') {
      end = code.indexOf('*/', i + 2);
      end = end < 0 ? code.length : end + 2;
    } else if (c === '"' || c === "'" || c === '`' || (c === '/' && (!prev || /[(,=:[!&|?{};+\-*%<>~^]/.test(prev)))) {
      let j = i + 1;
      let cls = false;
      while (j < code.length && (code[j] !== c || cls)) {
        if (code[j] === '\\') j++;
        else if (c === '/' && code[j] === '[') cls = true;
        else if (c === '/' && code[j] === ']') cls = false;
        j++;
      }
      end = Math.min(code.length, j + 1);
    }
    if (end >= 0) {
      // a literal reads as one value (`_`, line breaks too); a comment as blanks, its line breaks kept
      const comment = c === '/' && (code[i + 1] === '/' || code[i + 1] === '*');
      m += comment ? code.slice(i, end).replace(/[^\n]/g, ' ') : '_'.repeat(end - i);
      if (!comment) prev = '_';
      i = end;
    } else {
      m += c;
      if (!/\s/.test(c)) prev = c;
      i++;
    }
  }
  const OPEN = '([{';
  const CLOSE = ')]}';
  const closing = (at) => {
    let depth = 0;
    for (let i = at; i < m.length; i++) {
      if (OPEN.includes(m[i])) depth++;
      else if (CLOSE.includes(m[i]) && --depth === 0) return i;
    }
    return m.length;
  };
  /** Whether a statement may start at `at`: only blanks since the start of the code, a `;`, a `}` or a line break. */
  const starts = (at) => {
    let i = at - 1;
    while (i >= 0 && (m[i] === ' ' || m[i] === '\t')) i--;
    return i < 0 || m[i] === ';' || m[i] === '}' || m[i] === '\n';
  };
  /** Whether a declarator (m[a..b)) gives a value: an `=` of its own, outside brackets. */
  const valued = (a, b) => {
    for (let j = a, d = 0; j < b; j++) {
      if (OPEN.includes(m[j])) d++;
      else if (CLOSE.includes(m[j])) d--;
      else if (d === 0 && m[j] === '=' && !'=>'.includes(m[j + 1]) && !'=!<>'.includes(m[j - 1])) return true;
    }
    return false;
  };
  const KEYWORD =
    /(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(|class\s+([A-Za-z_$][\w$]*)[^{]*\{|(?:let|const|var)\s+(?=[A-Za-z_$[{])/y;
  const edits = []; // [from, to, text], applied from the end
  const fns = [];
  let depth = 0;
  for (let i = 0; i < m.length; i++) {
    const c = m[i];
    if (OPEN.includes(c)) depth++;
    else if (CLOSE.includes(c)) depth--;
    if (depth !== 0 || !/[a-z]/.test(c) || (i > 0 && /[\w$.]/.test(m[i - 1])) || !starts(i)) continue;
    KEYWORD.lastIndex = i;
    const k = KEYWORD.exec(m);
    if (!k) continue;
    if (k[1]) {
      fns.push(k[1]);
      continue;
    }
    if (k[2]) {
      const close = closing(i + k[0].length - 1);
      edits.push([i, i, `${k[2]} = `], [close + 1, close + 1, ';']);
      i = close;
      continue;
    }
    // the statement: to a `;` or a line break at its own level that doesn't continue an expression
    const from = i + k[0].length;
    let end = m.length;
    const commas = [];
    for (let j = from, d = 0; j < m.length; j++) {
      const x = m[j];
      if (OPEN.includes(x)) d++;
      else if (CLOSE.includes(x) && --d < 0) {
        end = j;
        break;
      } else if (d === 0 && x === ';') {
        end = j;
        break;
      } else if (d === 0 && x === ',') commas.push(j);
      else if (
        d === 0 &&
        x === '\n' &&
        !/[,=+\-*/%&|^!?:<>.(]$/.test(m.slice(from, j).trimEnd()) &&
        !/^[.?:+\-*/%&|^,=)\]}]/.test(m.slice(j + 1).trimStart())
      ) {
        end = j;
        break;
      }
    }
    edits.push([i, from, ';(']);
    let a = from;
    for (const b of [...commas, end]) {
      // a name without a value starts undefined, as a declaration would
      if (!valued(a, b) && /^\s*[A-Za-z_$][\w$]*\s*$/.test(m.slice(a, b))) edits.push([b, b, ' = undefined']);
      a = b + 1;
    }
    edits.push([end, end, ')']);
    i = end - 1;
  }
  let out = code;
  edits.forEach((e, n) => e.push(n));
  // from the end; at one place, the later edit first so the earlier one ends up in front of it
  for (const [a, b, text] of edits.sort((x, y) => y[0] - x[0] || y[3] - x[3])) out = out.slice(0, a) + text + out.slice(b);
  return fns.length ? `${fns.map((f) => `globalThis.${f} = ${f};`).join(' ')} ${out}` : out;
}

/**
 * The script's code as the body of an async function, with its last expression returned (as a REPL
 * would): the shortest tail of lines that compiles as `return (tail)` wins; with none, the code as is.
 */
function withReturn(vm, code) {
  const lines = code.replace(/\s+$/, '').split('\n');
  const compiles = (body) => {
    try {
      new vm.Script(`(async () => {\n${body}\n})`);
      return true;
    } catch {
      return false;
    }
  };
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 40); i--) {
    const tail = lines.slice(i).join('\n').replace(/;\s*$/, '');
    if (!tail.trim() || /^\s*(\/\/|return\b)/.test(lines[i])) continue;
    const body = `${lines.slice(0, i).join('\n')}${i ? '\n' : ''}return (${tail}\n)`;
    if (compiles(body)) return body;
  }
  return code;
}

module.exports = { persist, withReturn };
