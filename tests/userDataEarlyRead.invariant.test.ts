// Invariant (#2326): no code reads a path from Electron's `app.getPath(...)` before `lifecycle.prepareApp()` has set the
// app's name and its userData folder (electron/main.cjs). Reading it earlier gives Electron's default folder, not the
// one the app uses (they differ whenever MOPILOT_USER_DATA / SAGE_USER_DATA is set, which every e2e, dev and VM
// instance does), so MoMo's Codex home was made outside the profile. Two shapes are refused: a read at module scope,
// and a read directly in the body of a factory that main.cjs calls before prepareApp (a read inside a function it
// returns or passes on, run later, is fine: read the folder when it is used).
//
// The scanner below is a small tokenizer, not a parser (the repository has no JavaScript parser): it drops comments,
// strings and templates, then tracks which function body each `app.getPath(` sits in. An arrow function with an
// expression body is a function that ends at the first `,` `;` or closing bracket at its own depth.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const electron = path.resolve(import.meta.dirname, '..', 'electron');

/** `code` with comments blanked and string/template/regex contents blanked, same length and line breaks. */
export function blank(code: string): string {
  let out = '';
  let i = 0;
  const keep = (s: string) => s.replace(/[^\n]/g, ' ');
  while (i < code.length) {
    const c = code[i];
    const n = code[i + 1];
    if (c === '/' && n === '/') {
      const e = code.indexOf('\n', i);
      const end = e < 0 ? code.length : e;
      out += keep(code.slice(i, end));
      i = end;
    } else if (c === '/' && n === '*') {
      const e = code.indexOf('*/', i + 2);
      const end = e < 0 ? code.length : e + 2;
      out += keep(code.slice(i, end));
      i = end;
    } else if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < code.length && code[j] !== c && code[j] !== '\n') j += code[j] === '\\' ? 2 : 1;
      out += c + keep(code.slice(i + 1, j)) + c;
      i = j + 1;
    } else if (c === '`') {
      // a template: keep `${ ... }` code (it can hold calls), blank the text
      let j = i + 1;
      out += '`';
      while (j < code.length && code[j] !== '`') {
        if (code[j] === '\\') {
          out += '  ';
          j += 2;
        } else if (code[j] === '$' && code[j + 1] === '{') {
          let depth = 1;
          let k = j + 2;
          while (k < code.length && depth) {
            if (code[k] === '{') depth++;
            else if (code[k] === '}') depth--;
            k++;
          }
          out += `  ${blank(code.slice(j + 2, k - 1))} `;
          j = k;
        } else {
          out += code[j] === '\n' ? '\n' : ' ';
          j++;
        }
      }
      out += '`';
      i = j + 1;
    } else if (c === '/' && /[=(,:;!&|?{}[\n]\s*$/.test(out.slice(-3) || '\n') && n !== ' ' && n !== '=') {
      // a regular expression literal
      let j = i + 1;
      let cls = false;
      while (j < code.length && code[j] !== '\n' && (cls || code[j] !== '/')) {
        if (code[j] === '\\') j++;
        else if (code[j] === '[') cls = true;
        else if (code[j] === ']') cls = false;
        j++;
      }
      out += `/${keep(code.slice(i + 1, j))}/`;
      i = j + 1;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

type Read = { line: number; fns: string[] };

/**
 * Every `app.getPath(` in `code`, with the functions around it, innermost last: a name (function declaration, or the
 * identifier a function is assigned to), or '' for an anonymous one.
 */
export function readsIn(code: string): Read[] {
  const src = blank(code);
  const found: Read[] = [];
  /** open scopes: a function body ('{' of a function), a plain block/object ('{'), a paren/bracket, or an expression-bodied arrow */
  type Scope = { kind: 'fn' | 'block' | 'group' | 'arrow'; name: string; depth: number };
  const stack: Scope[] = [];
  let line = 1;
  /** the function name waiting for its body's '{' (set by `function name(` / `name = (…) =>` / class method) */
  let pending: string | null = null;
  const fnNames = () => stack.filter((s) => s.kind === 'fn' || s.kind === 'arrow').map((s) => s.name);
  const closeArrows = () => {
    while (stack.length && stack[stack.length - 1].kind === 'arrow') stack.pop();
  };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '\n') line++;
    if (src.startsWith('app.getPath(', i) && !/[\w$.]/.test(src[i - 1] ?? ' ')) found.push({ line, fns: fnNames() });
    if (c === '=' && src[i + 1] === '>') {
      // arrow: the name is the identifier before `=` of `name = (...) =>` when pending was set by it
      let j = i + 2;
      while (/\s/.test(src[j])) j++;
      if (src[j] === '{') {
        stack.push({ kind: 'fn', name: pending ?? '', depth: stack.length });
        pending = null;
        i = j;
      } else {
        stack.push({ kind: 'arrow', name: pending ?? '', depth: stack.length });
        pending = null;
        i = j - 1;
      }
      continue;
    }
    if (c === '(' && /\bfunction\s*\*?\s*[\w$]*\s*$/.test(src.slice(Math.max(0, i - 80), i)))
      // the parameter list of a function declaration: its defaults run when it is called, not where it is declared
      stack.push({ kind: 'fn', name: pending ?? '', depth: stack.length });
    else if (c === '(' || c === '[') stack.push({ kind: 'group', name: '', depth: stack.length });
    else if (c === '{') {
      // `) {` after `function …(…)` or a class method opens a function body; `=> {` is handled above
      const before = src.slice(Math.max(0, i - 400), i);
      const isFn =
        /(?:function\s*\*?\s*[\w$]*\s*\([^()]*(?:\([^()]*\)[^()]*)*\)|(?:^|[\s;}{])[\w$]+\s*\([^()]*(?:\([^()]*\)[^()]*)*\))\s*$/.test(
          before,
        ) && !/(?:\b(?:if|for|while|switch|catch|with)\s*)\([^]*\)\s*$/.test(before.slice(before.lastIndexOf('\n') + 1));
      stack.push(isFn ? { kind: 'fn', name: pending ?? '', depth: stack.length } : { kind: 'block', name: '', depth: stack.length });
      if (isFn) pending = null;
    } else if (c === ')' || c === ']') {
      closeArrows();
      if (stack.length) stack.pop();
    } else if (c === '}') {
      closeArrows();
      if (stack.length) stack.pop();
    } else if (c === ',' || c === ';') {
      closeArrows();
    }
    // names: `function name`, `const name =`, `name:` before a function
    if (c === 'f' && /^function\s*\*?\s*([\w$]+)/.test(src.slice(i, i + 80)) && !/[\w$]/.test(src[i - 1] ?? ' '))
      pending = /^function\s*\*?\s*([\w$]+)/.exec(src.slice(i, i + 80))![1];
    const decl = /^(?:const|let|var)\s+([\w$]+)\s*=/.exec(src.slice(i, i + 80));
    if (decl && !/[\w$]/.test(src[i - 1] ?? ' ')) pending = decl[1];
  }
  return found;
}

const files = (dir: string, out: string[] = []) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'chrome-extension') continue;
    const f = path.join(dir, e.name);
    if (e.isDirectory()) files(f, out);
    else if (e.name.endsWith('.cjs')) out.push(f);
  }
  return out;
};

test('the scanner tells a read at module scope, in a factory body and in a function it returns apart', () => {
  const code = [
    "const early = app.getPath('userData');",
    'function createA({ app }) {',
    "  const here = path.join(app.getPath('userData'), 'x');",
    "  const lazy = () => path.join(app.getPath('userData'), 'y');",
    "  return { dir: () => app.getPath('userData'), also: function later() { return app.getPath('home'); } };",
    '}',
    "const createB = ({ app }) => ({ file: path.join(app.getPath('userData'), 'z'), fn() { return app.getPath('logs'); } });",
    "// app.getPath('userData') in a comment, and 'app.getPath(' in a string",
  ].join('\n');
  const reads = readsIn(code).map((r) => `${r.line}:${r.fns.join('>')}`);
  assert.deepEqual(reads, ['1:', '3:createA', '4:createA>lazy', '5:createA>', '5:createA>later', '7:createB', '7:createB>']);
});

test('no module reads app.getPath at its top level', () => {
  const found: string[] = [];
  for (const file of files(electron)) {
    for (const r of readsIn(fs.readFileSync(file, 'utf8'))) if (!r.fns.length) found.push(`${path.relative(electron, file)}:${r.line}`);
  }
  assert.deepEqual(found, []);
});

test('no factory main.cjs calls before prepareApp reads app.getPath in its own body', () => {
  const main = fs.readFileSync(path.join(electron, 'main.cjs'), 'utf8');
  const cut = main.indexOf('\nlifecycle.prepareApp()');
  assert.ok(cut > 0, 'main.cjs calls lifecycle.prepareApp() at its top level');
  const before = blank(main.slice(0, cut));
  // name -> file, for what main.cjs requires from relative modules by destructuring
  const imported = new Map<string, string>();
  for (const m of main.slice(0, cut).matchAll(/const\s*\{([^}]*)\}\s*=\s*require\('(\.[^']*)'\)/g)) {
    const file = path.resolve(electron, m[2].endsWith('.cjs') ? m[2] : `${m[2]}.cjs`);
    for (const part of m[1].split(',')) {
      const name = part.split(':').pop()!.trim();
      if (name) imported.set(name, file);
    }
  }
  const raw = main.slice(0, cut);
  const found: string[] = [];
  const checked = new Set<string>();
  // main's top-level calls `createX(...)` / `new X(...)` before prepareApp
  for (const m of before.matchAll(/(?:\bnew\s+)?\b([A-Za-z_$][\w$]*)\s*\(/g)) {
    const file = imported.get(m[1]);
    if (!file || !fs.existsSync(file)) continue;
    // calls inside a function body main only defines are not run before prepareApp
    if (readsIn(`${raw.slice(0, m.index)}app.getPath(`).at(-1)?.fns.length) continue;
    checked.add(m[1]);
    for (const r of readsIn(fs.readFileSync(file, 'utf8')))
      if (r.fns.length === 1 && r.fns[0] === m[1]) found.push(`${path.relative(electron, file)}:${r.line} (in ${m[1]})`);
  }
  // the check sees the factories main runs early (the one that made MoMo's home too early among them)
  assert.ok(checked.has('createCodexServer') && checked.has('createAppState'), [...checked].join(','));
  assert.deepEqual([...new Set(found)], []);
});
