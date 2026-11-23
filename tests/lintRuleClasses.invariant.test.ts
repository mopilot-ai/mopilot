// Every lint rule of ours names its class and links the class page in each of its messages, so a warning leads to the
// class (docs/bug-prevention/README.md#the-lint-ratchet) and no table lists the rules for every new rule to edit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const GUARDS = ['docs/bug-prevention/', 'docs/code-quality.md', 'lint/rules/'];

const ROOT = path.join(import.meta.dirname, '..');
const RULES = path.join(ROOT, 'lint/rules');
const MESSAGE = /message\s*=\s*"((?:[^"\\]|\\.)*)"/g;
const CLASS_LINK = /docs\/bug-prevention\/([a-z][a-z-]*)\.md|docs\/code-quality\.md/g;

/** The rule's name and messages missing a link to an existing class page (or the code-quality page), from the rule's text. */
function unlinked(name: string, text: string, exists = (page: string) => existsSync(path.join(ROOT, 'docs/bug-prevention', `${page}.md`))) {
  const messages = [...text.matchAll(MESSAGE)].map((m) => m[1]);
  if (!messages.length) return [`${name}: no message`];
  return messages
    .filter((message) => {
      const links = [...message.matchAll(CLASS_LINK)];
      return !links.length || links.some((link) => link[1] !== undefined && !exists(link[1])) || !message.includes(`[${name}]`);
    })
    .map((message) => `${name}: ${message.slice(0, 60)}`);
}

test('every message of every lint rule carries its [name] tag and links an existing class page', () => {
  const rules = readdirSync(RULES).filter((f) => f.endsWith('.grit'));
  assert.ok(rules.length > 10, 'expected the lint rules');
  const problems = rules.flatMap((f) => unlinked(f.slice(0, -5), readFileSync(path.join(RULES, f), 'utf8')));
  assert.deepEqual(problems, [], 'put (docs/bug-prevention/<class>.md) in each message, so the warning leads to its class');
});

test('the check tells a linked message from one without a link, a tag or an existing page', () => {
  const rule = (message: string) => `register_diagnostic(span=$x, message="${message}", severity="warn")`;
  const exists = (page: string) => page === 'wrong-scope';
  assert.deepEqual(unlinked('a', rule('[a] bad (docs/bug-prevention/wrong-scope.md).'), exists), []);
  assert.deepEqual(unlinked('a', rule('[a] bad (docs/code-quality.md#type-scale).'), exists), []);
  assert.equal(unlinked('a', rule('[a] bad.'), exists).length, 1);
  assert.equal(unlinked('a', rule('[b] bad (docs/bug-prevention/wrong-scope.md).'), exists).length, 1);
  assert.equal(unlinked('a', rule('[a] bad (docs/bug-prevention/gone.md).'), exists).length, 1);
  assert.deepEqual(unlinked('a', '// no diagnostic', exists), ['a: no message']);
  // a dead link after a good one, and a message written with spaces around the equals sign, are both seen
  assert.equal(unlinked('a', rule('[a] bad (docs/code-quality.md) (docs/bug-prevention/gone.md).'), exists).length, 1);
  assert.equal(unlinked('a', 'register_diagnostic(span=$x, message = "[a] bad.")', exists).length, 1);
  assert.deepEqual(unlinked('a', rule('[a] one (docs/bug-prevention/wrong-scope.md).') + rule('[a] two.'), exists).length, 1);
});
