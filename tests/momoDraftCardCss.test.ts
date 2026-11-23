// The draft card's stylesheet (src/components/momo/momoDraftCard.module.css): every custom property it reads without a fallback is declared by the app's tokens, because an undeclared one makes its declaration invalid at computed-value time (the primary button's text fell back to the inherited black on a near-black pill and had no visible label), and the primary button's text and fill are two different tokens.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import postcss from 'postcss';

const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
const css = postcss.parse(read('src/components/momo/momoDraftCard.module.css'));
const declared = new Set([...read('src/styles/tokens.css').matchAll(/^\s*(--[\w-]+)\s*:/gm)].map((m) => m[1]));

test('every token the card reads without a fallback is declared in the app’s tokens', () => {
  const missing = new Set<string>();
  css.walkDecls((decl) => {
    for (const m of decl.value.matchAll(/var\(\s*(--[\w-]+)\s*(,)?/g))
      if (!m[2] && !declared.has(m[1]))
        missing.add(`${m[1]} (${decl.parent && 'selector' in decl.parent ? decl.parent.selector : ''} ${decl.prop})`);
  });
  assert.deepEqual([...missing], []);
  assert.ok(declared.has('--main') && declared.has('--text'), 'the check reads the real token file');
});

test('the primary button’s label and fill are different tokens, so its label shows', () => {
  let color = '';
  let background = '';
  css.walkRules('.primary', (rule) => {
    if (rule.selector !== '.primary') return;
    rule.walkDecls('color', (d) => void (color = d.value));
    rule.walkDecls('background', (d) => void (background = d.value));
  });
  assert.ok(color && background);
  assert.notEqual(color, background);
});
