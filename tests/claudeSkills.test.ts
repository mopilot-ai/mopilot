// Skills read from disk before a session has reported them (electron/harness/claude/skills.cjs): stray files are skipped, linked
// skill folders count, and a skill named twice is listed once. Data is made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const { scanSkills, skillRoots, skillName } = createRequire(import.meta.url)('../electron/harness/claude/skills.cjs');

test('skills come from the account folder and the project, named by front matter or folder', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sage-skills-'));
  const cfg = path.join(tmp, 'cfg');
  const proj = path.join(tmp, 'proj');
  fs.mkdirSync(path.join(cfg, 'skills', 'tidy'), { recursive: true });
  fs.writeFileSync(path.join(cfg, 'skills', 'tidy', 'SKILL.md'), '---\nname: tidy-notes\ndescription: x\n---\nbody');
  fs.mkdirSync(path.join(proj, '.claude', 'skills', 'plain'), { recursive: true });
  fs.writeFileSync(path.join(proj, '.claude', 'skills', 'plain', 'SKILL.md'), 'no front matter');
  fs.mkdirSync(path.join(cfg, 'skills', 'empty'), { recursive: true }); // no SKILL.md: not a skill
  assert.deepEqual(scanSkills(skillRoots(cfg, proj)), ['plain', 'tidy-notes']);
  assert.deepEqual(scanSkills(skillRoots(path.join(tmp, 'none'), null)), []);
  assert.equal(skillName('---\nname: "quoted"\n---\n'), 'quoted');
});

test('files are not skills, linked folders are, and a repeated name is listed once', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sage-skills-cov-'));
  const a = path.join(tmp, 'a');
  const b = path.join(tmp, 'b');
  const elsewhere = path.join(tmp, 'elsewhere', 'linked');
  fs.mkdirSync(elsewhere, { recursive: true });
  fs.writeFileSync(path.join(elsewhere, 'SKILL.md'), '---\nname: linked-skill\n---\n');
  fs.mkdirSync(path.join(a, 'one'), { recursive: true });
  fs.writeFileSync(path.join(a, 'one', 'SKILL.md'), '---\nname: shared\n---\n');
  fs.writeFileSync(path.join(a, 'README.md'), 'not a skill');
  fs.symlinkSync(elsewhere, path.join(a, 'link'));
  fs.mkdirSync(path.join(b, 'two'), { recursive: true });
  fs.writeFileSync(path.join(b, 'two', 'SKILL.md'), '---\nname: shared\n---\n');
  assert.deepEqual(scanSkills([a, b]), ['linked-skill', 'shared']);
});
