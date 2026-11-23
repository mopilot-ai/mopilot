// Skill links and SKILL.md documents (src/lib/skills.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { skillDocument, skillName, skillPath } from '../src/lib/skills.ts';

test('only local SKILL.md links are skill references', () => {
  assert.equal(skillPath('https://example.com/SKILL.md'), null);
  assert.equal(skillPath('file:///Users/me/.claude/skills/review/SKILL.md#top'), '/Users/me/.claude/skills/review/SKILL.md');
  assert.equal(skillPath('file:///C:/skills/x/skill.md:12'), 'C:/skills/x/skill.md');
  assert.equal(skillPath('C:\\skills\\x\\SKILL.md'), 'C:\\skills\\x\\SKILL.md');
  assert.equal(skillPath('/a/My%20Skill/SKILL.md:L3-5', undefined, true), '/a/My Skill/SKILL.md');
  assert.equal(skillPath('/a/100%/SKILL.md'), '/a/100%/SKILL.md');
  assert.equal(skillPath('skills/x/SKILL.md'), null);
  assert.equal(skillPath('skills/x/SKILL.md', '/repo'), '/repo/skills/x/SKILL.md');
  assert.equal(skillPath('/a/README.md'), null);
  assert.equal(skillName('/a/review/SKILL.md'), 'review');
});

test('a document without frontmatter is all body', () => {
  assert.deepEqual(skillDocument('# Title\n'), { body: '# Title\n', metadata: [] });
});

test('frontmatter fields: plain, quoted, block scalars and continuation lines', () => {
  const doc = skillDocument(
    [
      '\uFEFF---',
      '  stray indented line',
      'name: review',
      'title: "Code \\"review\\""',
      'bad: "unterminated \\"',
      "single: 'it''s'",
      'folded: >-',
      '  one',
      '  two',
      'literal: |',
      '  a',
      '  b',
      'description: first',
      '  continued',
      'not a field',
      '...',
      'Body',
    ].join('\n'),
  );
  assert.equal(doc.body, 'Body');
  assert.deepEqual(doc.metadata, [
    ['name', 'review'],
    ['title', 'Code "review"'],
    ['bad', '"unterminated \\"'],
    ['single', "it's"],
    ['folded', 'one two'],
    ['literal', 'a\nb'],
    ['description', 'first\n  continued'],
  ]);
  assert.equal(skillDocument('---\r\nname: x\r\n---').body, '');
});

test('file URL skill references separate query metadata from their local pathname', () => {
  assert.equal(skillPath('file:///a/review/SKILL.md?view=raw#usage'), '/a/review/SKILL.md');
  assert.equal(skillPath('file://localhost/a/My%23Skill/SKILL.md?raw=1'), '/a/My#Skill/SKILL.md');
  assert.equal(skillPath('file://server/share/review/SKILL.md?raw=1'), '//server/share/review/SKILL.md');
});

test('relative skill URI metadata is separate from literal tool filename characters', () => {
  assert.equal(skillPath('review/SKILL.md?view=raw#usage', '/repo', true), '/repo/review/SKILL.md');
  assert.equal(skillPath('/a/Review#2026/SKILL.md'), '/a/Review#2026/SKILL.md');
  assert.equal(skillPath('/a/Review?2026/SKILL.md'), '/a/Review?2026/SKILL.md');
  assert.equal(skillPath('/a/review/SKILL.md#usage'), '/a/review/SKILL.md');
});

test('literal skill filename percent sequences are preserved outside URI mode', () => {
  assert.equal(skillPath('/a/100%20done/SKILL.md'), '/a/100%20done/SKILL.md');
  assert.equal(skillPath('/a/100%20done/SKILL.md', undefined, true), '/a/100 done/SKILL.md');
});

test('an absolute Markdown skill link preserves the literal folder of the chat', () => {
  assert.equal(skillPath('/repo%2ffix/review/SKILL.md', '/repo%2ffix', true), '/repo%2ffix/review/SKILL.md');
});
