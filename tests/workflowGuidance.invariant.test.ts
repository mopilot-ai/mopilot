// Active multi-harness guides link to the current workflow owners instead of prescribing legacy test and merge procedures.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

export const GUARDS = ['docs/multi-harness/', 'docs/bug-prevention/'];

const folder = new URL('../docs/multi-harness/', import.meta.url);
const guides = readdirSync(folder)
  .filter((name) => /^(?:README|TESTING)\.md$/.test(name))
  .map((name) => ({ name, text: readFileSync(new URL(name, folder), 'utf8') }));

test('active handoff guides link to the policy and validation owners', () => {
  assert.equal(guides.length, 2);
  for (const { name, text } of guides) {
    assert.ok(/\]\(\.\.\/\.\.\/AGENTS\.md\)/.test(text), `${name} must link to the agent policy`);
    assert.ok(/\]\(\.\.\/unit-coverage\.md(?:#[^)]+)?\)/.test(text), `${name} must link to the validation owner`);
  }
});

test('active handoff guides do not prescribe superseded execution or merge commands', () => {
  for (const { name, text } of guides) {
    assert.ok(!/scripts\/handoff\/(?:localci|health|stack|watch)\.sh/.test(text), `${name} prescribes legacy automation`);
    assert.ok(!/npm test\b|git checkout -B|SAGE_E2E_BACKGROUND/.test(text), `${name} duplicates an execution procedure`);
    assert.ok(
      !/GitHub Actions is disabled|Co-Authored-By:|Generated with \[Claude Code\]/.test(text),
      `${name} carries obsolete workflow metadata`,
    );
  }
});

function duplicateRules(text: string): number[] {
  const seen = new Set<string>();
  const duplicates: number[] = [];
  let fence: string | null = null;
  let start = 0;
  let item: string[] = [];
  const flush = () => {
    const rule = item.join(' ').replace(/\s+/g, ' ').trim();
    if (rule.split(' ').length >= 20) {
      if (seen.has(rule)) duplicates.push(start);
      seen.add(rule);
    }
    item = [];
  };
  for (const [index, line] of text.split('\n').entries()) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      flush();
      if (fence === null) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
    } else if (fence === null) {
      if (line.startsWith('- ')) {
        flush();
        start = index + 1;
        item = [line];
      } else if (item.length && /^ {2,}\S/.test(line)) item.push(line.trim());
      else flush();
    }
  }
  flush();
  return duplicates;
}

test('the prose guard compares complete rules and leaves code examples alone', () => {
  const rule =
    '- Keep the current owner and all of its invalidators explicit when testing concurrent operations, cancellation, persistence and successful retries across supported harnesses.';
  assert.deepEqual(duplicateRules(`${rule}\n\n${rule}`), [3]);
  assert.deepEqual(duplicateRules(`${rule}\n  First continuation.\n${rule}\n  Different continuation.`), []);
  assert.deepEqual(duplicateRules(`${rule}\n\n\`\`\`md\n${rule}\n\`\`\``), []);
  assert.deepEqual(duplicateRules(`${rule}\n\n\`\`\`\`md\n\`\`\`\n${rule}\n\`\`\`\n\`\`\`\``), []);
});

test('a bug-class document keeps one copy of each substantive rule', () => {
  const folder = new URL('../docs/bug-prevention/', import.meta.url);
  const repeated = readdirSync(folder)
    .filter((name) => name.endsWith('.md'))
    .flatMap((name) => duplicateRules(readFileSync(new URL(name, folder), 'utf8')).map((line) => `${name}:${line}`));
  assert.deepEqual(repeated, []);
});
