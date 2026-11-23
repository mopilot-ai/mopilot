// The Chrome extension's stylesheets keep every colour in a token (#3046 batch B8): a literal colour outside a :root block is right in one scheme only (white on a dark page, a light grey fill),
// and a light token with no dark value is the same mistake one level up. Both are found here by reading the stylesheets, not by looking at the panel in each scheme.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DARK, colourLiterals, extensionStylesheets, parseRules, tokensFor } from './helpers/chromePanelCss.ts';

/** A literal colour that may stay outside a :root block, with the reason it is right in both schemes. Empty: every colour is a token. */
const LITERAL_ALLOWED: { file: string; selector: string; value: string; why: string }[] = [];

/** A colour token the dark scheme does not redefine, with the reason its light value is right on a dark page too. */
const SAME_IN_DARK: Record<string, string> = {
  '--accent': "Claude's brand clay #d97757 is the same in its dark mode (brand-100/200); it is 4.9:1 on the dark page",
  '--ok': 'a status dot only (3:1 needed): #1e8e3e is 3.6:1 on the dark page',
  '--wait': 'a dot and a notice border (3:1 needed): #d97706 is 4.8:1 on the dark page',
  '--off': 'a dot for the idle state (3:1 needed): #9a9a9a is 5.4:1 on the dark page',
  '--rec': 'the recording mic is white on #d33 in both schemes (4.6:1), a fill that carries its own text colour',
  '--on-rec': 'the text on --rec, see above',
};

const sheets = extensionStylesheets();

test('the stylesheets are found by folder and include the side panel and the shared one', () => {
  const names = sheets.map((s) => s.file);
  assert.ok(names.includes('panel.css') && names.includes('sidepanel.css'), names.join(', '));
});

test('no stylesheet draws a colour literal outside a :root token block', () => {
  const stray: string[] = [];
  for (const { file, css } of sheets)
    for (const rule of parseRules(css)) {
      for (const d of rule.decls) {
        // a :root rule is where the tokens are defined: only its custom properties may hold a literal
        if (rule.selector === ':root' && d.prop.startsWith('--')) continue;
        for (const literal of colourLiterals(d.value, d.prop)) {
          const allowed = LITERAL_ALLOWED.some((a) => a.file === file && a.selector === rule.selector && a.value === literal);
          if (!allowed) stray.push(`${file}: ${rule.selector} { ${d.prop}: ${d.value} } uses the literal ${literal}`);
        }
      }
    }
  assert.deepEqual(
    stray,
    [],
    'put the colour in a token with a light and a dark value (sidepanel.css :root), or explain it in LITERAL_ALLOWED',
  );
});

test('every allowed literal still exists, so the list cannot go stale', () => {
  for (const a of LITERAL_ALLOWED) {
    assert.ok(a.why.length > 20, `${a.file} ${a.selector}: say why`);
    const used = sheets
      .filter((s) => s.file === a.file)
      .flatMap((s) => parseRules(s.css))
      .some((r) => r.selector === a.selector && r.decls.some((d) => colourLiterals(d.value, d.prop).includes(a.value)));
    assert.ok(used, `${a.file} ${a.selector} no longer uses ${a.value}`);
  }
});

test('every light colour token has a dark value, unless it is explained as the same in both', () => {
  const light = tokensFor(sheets, 'light');
  const dark = new Map<string, string>();
  for (const { css } of sheets)
    for (const rule of parseRules(css))
      if (rule.selector === ':root' && rule.context.length === 1 && rule.context[0] === DARK)
        for (const d of rule.decls) dark.set(d.prop, d.value);
  const missing = [...light]
    .filter(([name, value]) => colourLiterals(value).length > 0 && !dark.has(name) && !(name in SAME_IN_DARK))
    .map(([name, value]) => `${name}: ${value}`);
  assert.deepEqual(missing, [], 'give the token a value in the prefers-color-scheme: dark block, or explain it in SAME_IN_DARK');
  for (const name of Object.keys(SAME_IN_DARK)) {
    assert.ok(light.has(name), `${name} is no longer a token`);
    assert.ok(!dark.has(name), `${name} has a dark value now: drop it from SAME_IN_DARK`);
  }
});

test('the dark block never sets a token the light block does not know', () => {
  const light = tokensFor(sheets, 'light');
  const stray = [...tokensFor(sheets, 'dark').keys()].filter((name) => !light.has(name));
  assert.deepEqual(stray, []);
});

// the scanners themselves, on small stylesheets: a guard that finds nothing proves nothing
test('the scanner finds hex, functions and names, and skips tokens, url(), strings and var()', () => {
  assert.deepEqual(colourLiterals('1px solid #fff'), ['#fff']);
  assert.deepEqual(colourLiterals('0 2px 8px rgb(0 0 0 / 0.1), 0 0 0 1px rgba(1, 2, 3, .5)'), ['rgb(', 'rgba(']);
  assert.deepEqual(colourLiterals('Red'), ['red']);
  assert.deepEqual(colourLiterals('linear-gradient(90deg, var(--muted) 0, white 50%)'), ['white']);
  assert.deepEqual(colourLiterals(`url("data:image/svg+xml,%3Csvg stroke='black' fill='#000'%3E") center / contain no-repeat`), []);
  assert.deepEqual(colourLiterals(`' ✓'`), []);
  assert.deepEqual(colourLiterals('Canvas'), ['canvas']);
  assert.deepEqual(colourLiterals('Tan Pearl', 'font-family'), []);
  assert.deepEqual(colourLiterals('linen-fade 1s', 'animation'), []);
  assert.deepEqual(colourLiterals('Tan', 'color'), ['tan']);
  assert.deepEqual(colourLiterals('var(--error) currentColor transparent inherit none'), []);
  assert.deepEqual(colourLiterals('color-mix(in srgb, var(--fg) 50%, hsl(0 0% 0%))'), ['color-mix(', 'hsl(']);
});

test('a statement at-rule before a rule does not hide the rule', () => {
  assert.deepEqual(
    parseRules('@import "a.css"; .a { color: red }').map((r) => r.selector),
    ['.a'],
  );
});

test('the parser refuses a declaration it cannot read', () => {
  assert.throws(() => parseRules('.x { color red }'), /not a declaration/);
});

test('the parser reads nested at-rules, comments and values with semicolons and braces in quotes', () => {
  const rules = parseRules(`/* a { color: red } */
    :root { --a: #fff; --u: url("data:x;y{z}"); }
    @media (prefers-color-scheme: dark) { :root { --a: #000; } .x { color: #111; } }
    @keyframes k { 0% { opacity: 0; } }
    .y { background: url('a;b') }`);
  assert.deepEqual(
    rules.map((r) => [r.selector, r.context, r.decls.map((d) => d.prop)]),
    [
      [':root', [], ['--a', '--u']],
      [':root', [DARK], ['--a']],
      ['.x', [DARK], ['color']],
      ['0%', ['@keyframes k'], ['opacity']],
      ['.y', [], ['background']],
    ],
  );
});

test('a :root rule may hold a literal only in a custom property, and an at-rule that holds declarations is scanned', () => {
  const stray = (css: string) =>
    parseRules(css).flatMap((rule) =>
      rule.decls
        .filter((d) => !(rule.selector === ':root' && d.prop.startsWith('--')))
        .flatMap((d) => colourLiterals(d.value, d.prop).map((literal) => `${rule.selector} ${d.prop} ${literal}`)),
    );
  assert.deepEqual(stray(':root { --a: #fff; }'), []);
  assert.deepEqual(stray(':root { background: #fff; }'), [':root background #fff']);
  assert.deepEqual(stray('@media (min-width: 1px) { :root { color: black } }'), [':root color black']);
  assert.deepEqual(stray('@property --x { syntax: "<color>"; initial-value: #fff; inherits: true }'), ['@property --x initial-value #fff']);
  assert.deepEqual(stray('@font-face { font-family: x; src: url(a.woff) }'), []);
});
