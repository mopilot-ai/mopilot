import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { mergeSkills, skillException, skillTitle } from '../src/components/skills/mergeSkills.ts';

const codexSkill = (name: string, o: Record<string, unknown> = {}) => ({
  name,
  description: `${name} long text`,
  path: `/c/${name}/SKILL.md`,
  enabled: true,
  ...o,
});
const plugin = (name: string, skills: string[], o: Record<string, unknown> = {}) =>
  ({
    id: `${name}@acme`,
    enabled: true,
    harnesses: {},
    spec: { name, skills: skills.map((s) => ({ name: s, description: `${s} from ${name}`, file: `/p/${name}/${s}.md` })) },
    ...o,
  }) as any;

test('titles: a display name wins, else the last segment in title case', () => {
  assert.equal(skillTitle('frontend-design'), 'Frontend Design');
  assert.equal(skillTitle('acme:test_cards'), 'Test Cards');
  assert.equal(skillTitle('x', 'Mine'), 'Mine');
});

test('the same skill from every source is one row; a plugin skill reaches each harness its plugin is on for', () => {
  const rows = mergeSkills({
    codex: [codexSkill('acme:s', { enabled: false, interface: { displayName: 'Shiny', shortDescription: 'short' } }), codexSkill('mine')],
    claude: ['ACME:s', 'mine', 'only-claude'],
    plugins: [plugin('acme', ['s']), plugin('gone', ['g'], { spec: null }), plugin('off', ['o'], { enabled: false })],
  });
  assert.deepEqual(
    rows.map((r) => r.title),
    ['Mine', 'O', 'Only Claude', 'Shiny'],
  );
  const shiny = rows.find((r) => r.title === 'Shiny')!;
  assert.equal(shiny.plugin, 'acme@acme');
  assert.equal(shiny.description, 's from acme');
  assert.deepEqual(shiny.copies.codex, { on: false, file: '/c/acme:s/SKILL.md' });
  assert.deepEqual(shiny.copies.claude, { on: true, file: '/p/acme/s.md' });
  assert.deepEqual(shiny.copies.acp, { on: true, file: '/p/acme/s.md' });
  assert.equal(shiny.codex?.name, 'acme:s');
  // a description missing from the first source comes from the next
  assert.equal(rows.find((r) => r.title === 'O')!.description, 'o from off');
  assert.equal(mergeSkills({ codex: [codexSkill('d', { description: '' })], claude: [], plugins: [] })[0].description, '');
  const late = mergeSkills({
    codex: [codexSkill('acme:t', { description: 'from codex' })],
    claude: [],
    plugins: [{ ...plugin('acme', ['t']), spec: { name: 'acme', skills: [{ name: 't', file: '/f' }] } }],
  });
  assert.equal(late[0].description, 'from codex');
});

test('a plugin turned off for one harness reads off there; the Claude catalog says it is loaded', () => {
  const [row] = mergeSkills({
    codex: [],
    claude: ['acme:s'],
    plugins: [plugin('acme', ['s'], { harnesses: { codex: false, claude: false } })],
  });
  assert.equal(row.copies.codex?.on, false);
  assert.equal(row.copies.claude?.on, true);
  assert.equal(skillException(row), 'Off on Codex');
});

test('the one line says only what differs', () => {
  const on = { on: true };
  const off = { on: false };
  const row = (copies: any) => ({ key: 'k', title: 'K', description: '', copies });
  assert.equal(skillException(row({ codex: on, claude: on, acp: on })), null);
  assert.equal(skillException(row({ codex: on })), 'Only on Codex');
  assert.equal(skillException(row({ codex: on, claude: on })), 'Only on Codex, Claude Code');
  assert.equal(skillException(row({ codex: off, claude: on })), 'Off on Codex · Only on Claude Code');
  assert.equal(skillException(row({ codex: off, claude: off })), 'Off');
  assert.equal(skillException(row({})), 'Off');
});
