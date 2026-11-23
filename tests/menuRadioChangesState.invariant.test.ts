// A menu row that draws as a choice (role menuitemradio or menuitemcheckbox, a check mark the user expects to move) must change something when clicked: a handler that only closes the menu looks like a picker and picks nothing (the host chip's machine rows, #3367). A row that can't be picked says so with `disabled`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

export const GUARDS = ['src/'];

const ROOT = path.join(import.meta.dirname, '..');
const files = (dir: string): string[] =>
  fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : e.name.endsWith('.tsx') ? [path.join(dir, e.name)] : []));

/** The text of every JSX opening tag in `src` that carries a choice role (a literal or an expression naming one). */
export function choiceTags(src: string): { text: string; line: number }[] {
  const tags: { text: string; line: number }[] = [];
  for (const m of src.matchAll(/role=(?:"menuitem(?:radio|checkbox)"|\{[^}]*'menuitem(?:radio|checkbox)')/g)) {
    // the tag starts at the nearest `<name` outside braces: a `<` inside an attribute's expression (a < b) is not it
    let start = m.index;
    for (let depth = 0; start > 0; start--) {
      const c = src[start];
      if (c === '}') depth++;
      else if (c === '{') depth--;
      else if (c === '<' && depth === 0 && /[A-Za-z]/.test(src[start + 1])) break;
    }
    // the tag ends at the first `>` outside braces and strings
    let depth = 0;
    let end = m.index;
    let quote = '';
    for (; end < src.length; end++) {
      const c = src[end];
      if (quote) {
        if (c === quote && src[end - 1] !== '\\') quote = '';
      } else if (c === '"' || c === "'" || c === '`') quote = c;
      else if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (c === '>' && depth === 0 && src[end - 1] !== '=') break;
    }
    tags.push({ text: src.slice(start, end + 1), line: src.slice(0, start).split('\n').length });
  }
  return tags;
}

/** The expression of `attr={...}` in a tag, braces balanced; null when the tag has none. */
function attrExpr(tag: string, attr: string): string | null {
  const at = tag.search(new RegExp(`\\s${attr}=\\{`));
  if (at < 0) return null;
  let i = tag.indexOf('{', at);
  const from = i + 1;
  for (let depth = 0; i < tag.length; i++) {
    if (tag[i] === '{') depth++;
    else if (tag[i] === '}' && --depth === 0) break;
  }
  return tag.slice(from, i).trim();
}

const CLOSE = /^[\w.?]*(?:close|dismiss|hide)\w*$/i;
/** True when `expr` only closes: a close function itself, or an arrow whose every statement calls one. */
export function onlyCloses(expr: string | null): boolean {
  if (expr === null) return true;
  if (CLOSE.test(expr)) return true;
  const arrow = expr.match(/^\(\s*\w*\s*\)\s*=>\s*([\s\S]*)$/);
  if (!arrow) return false;
  const body = arrow[1].trim().replace(/^\{([\s\S]*)\}$/, '$1');
  const statements = body
    .split(/[;\n]/)
    .map((x) => x.trim().replace(/^void\s+/, ''))
    .filter(Boolean);
  return statements.length > 0 && statements.every((x) => /^[\w.?]+\(\s*\)$/.test(x) && CLOSE.test(x.replace(/\(\s*\)$/, '')));
}

test('the matcher: a close-only handler is caught, one that picks is not', () => {
  for (const h of ['a.close', 'onClose', '() => a.close()', '() => { close(); }', '() => { a.close(); hide(); }', null])
    assert.equal(onlyCloses(h), true, String(h));
  for (const h of ['() => onPick(m)', '() => { a.close(); pick(m); }', '() => (close(), props.onPick(null))', 'choose'])
    assert.equal(onlyCloses(h), false, h);
  const tags = choiceTags(
    `<MenuRow role="menuitemradio" aria-checked={x > 1} onClick={a.close}>A</MenuRow><Row role={on ? 'menuitemcheckbox' : 'menuitemradio'} onClick={() => pick()} />` +
      `<Row onClick={close} aria-checked={n < 2} role="menuitemradio" />`,
  );
  assert.deepEqual(
    tags.map((t) => attrExpr(t.text, 'onClick')),
    ['a.close', '() => pick()', 'close'],
  );
});

test('I: every menuitemradio and menuitemcheckbox row in src changes state when clicked, or is disabled', () => {
  let seen = 0;
  const bad: string[] = [];
  for (const file of files(path.join(ROOT, 'src'))) {
    for (const { text, line } of choiceTags(fs.readFileSync(file, 'utf8'))) {
      seen++;
      // a row disabled outright never fires; one disabled only sometimes must still pick when it is on
      if (/\sdisabled(?:\s|>|=\{true\})/.test(text)) continue;
      if (onlyCloses(attrExpr(text, 'onClick'))) bad.push(`${path.relative(ROOT, file)}:${line}`);
    }
  }
  assert.ok(seen >= 10, `the choice rows were found (${seen})`);
  assert.deepEqual(bad, [], 'a choice row whose click only closes the menu picks nothing: pick in its handler, or disable it with why');
});
