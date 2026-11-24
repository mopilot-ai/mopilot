// Skills read from disk before a session has reported them (electron/harness/claude/skills.cjs): stray files are skipped, linked
// skill folders count, and a skill named twice is listed once. Data is made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { useFakeFs } from './support/ports/fs.ts';

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

const { indexSkills, indexRoots, skillFilesFor, skillDescription } = createRequire(import.meta.url)(
  '../electron/harness/claude/skills.cjs',
);
const { createCatalog, mergeCatalog } = createRequire(import.meta.url)('../electron/harness/claude/catalog.cjs');

const put = (dir: string, text: string) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), text);
};

test('descriptions: one line, quoted, folded or literal block, absent, or no front matter', () => {
  assert.equal(skillDescription('---\nname: a\ndescription: Plain words\n---\n'), 'Plain words');
  assert.equal(skillDescription('---\ndescription: "Quoted: yes"\n---\n'), 'Quoted: yes');
  assert.equal(skillDescription("---\ndescription: 'single'\n---\n"), 'single');
  assert.equal(skillDescription('---\ndescription: >-\n  first line\n  second line\nname: x\n---\n'), 'first line second line');
  assert.equal(skillDescription('---\ndescription: |\n  kept\n\n  going\n---\n'), 'kept  going');
  assert.equal(skillDescription('---\nname: a\n---\n'), '');
  assert.equal(skillDescription('no front matter'), '');
});

test('the index finds each skill by front matter name and by folder name, with its path, description and scope', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sage-skills-index-'));
  const cfg = path.join(tmp, 'cfg');
  const proj = path.join(tmp, 'proj');
  const plug = path.join(tmp, 'plug');
  put(path.join(cfg, 'skills', 'tidy'), '---\nname: tidy-notes\ndescription: Tidy my notes\n---\nbody');
  put(path.join(proj, '.claude', 'skills', 'plain'), 'no front matter');
  put(path.join(plug, 'skills', 'review'), '---\nname: deep-review\ndescription: Review deeply\n---\n');
  // a folder reached through a link counts, a file or an empty folder does not
  const elsewhere = path.join(tmp, 'elsewhere', 'linked');
  put(elsewhere, '---\nname: linked-skill\n---\n');
  fs.symlinkSync(elsewhere, path.join(cfg, 'skills', 'link'));
  fs.writeFileSync(path.join(cfg, 'skills', 'README.md'), 'x');
  fs.mkdirSync(path.join(cfg, 'skills', 'empty'));
  const index = indexSkills(indexRoots(cfg, proj, [{ name: 'acme', path: plug }, { name: 'nopath', path: null }, { path: '/x' }]));
  const tidy = { name: 'tidy-notes', path: path.join(cfg, 'skills', 'tidy', 'SKILL.md'), description: 'Tidy my notes', scope: 'personal' };
  assert.deepEqual(index.get('tidy-notes'), tidy);
  assert.equal(index.get('tidy'), index.get('tidy-notes'), 'the folder name reaches the same skill');
  assert.equal(index.get('plain').scope, 'project');
  assert.equal(index.get('plain').description, '');
  assert.equal(index.get('acme:deep-review').scope, 'plugin');
  assert.equal(index.get('acme:review'), index.get('acme:deep-review'));
  assert.equal(index.get('linked-skill').path, path.join(cfg, 'skills', 'link', 'SKILL.md'));
  assert.equal(index.get('empty'), undefined);
  assert.equal(index.get('deep-review'), undefined, 'a plugin skill is only its namespaced name');
  // without a project folder or plugins, only the account's skills
  assert.equal(indexSkills(indexRoots(cfg, null)).has('plain'), false);
  assert.deepEqual(indexSkills(indexRoots(path.join(tmp, 'none'), undefined)).size, 0);
});

test('a skill in both the account and the project is the account one; an unreadable SKILL.md is not a skill', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sage-skills-dup-'));
  const cfg = path.join(tmp, 'cfg');
  const proj = path.join(tmp, 'proj');
  put(path.join(cfg, 'skills', 'ship'), '---\nname: ship\ndescription: personal one\n---\n');
  put(path.join(proj, '.claude', 'skills', 'ship'), '---\nname: ship\ndescription: project one\n---\n');
  put(path.join(proj, '.claude', 'skills', 'only-here'), '---\nname: only-here\n---\n');
  const hit = indexSkills(indexRoots(cfg, proj)).get('ship');
  assert.equal(hit.scope, 'personal');
  assert.equal(hit.description, 'personal one');
  // a SKILL.md that is a folder cannot be read
  fs.mkdirSync(path.join(proj, '.claude', 'skills', 'broken', 'SKILL.md'), { recursive: true });
  const index = indexSkills(indexRoots(cfg, proj));
  assert.equal(index.has('broken'), false);
  assert.deepEqual(skillFilesFor(['ship', 'only-here', 'broken', 'built-in'], cfg, proj, []), {
    ship: { path: path.join(cfg, 'skills', 'ship', 'SKILL.md'), description: 'personal one', scope: 'personal' },
    'only-here': { path: path.join(proj, '.claude', 'skills', 'only-here', 'SKILL.md'), description: '', scope: 'project' },
  });
});

test('the catalog carries skillFiles for the listed skills that resolve, recomputed when skills or plugins change', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sage-skills-cat-'));
  const cfg = path.join(tmp, 'cfg');
  const plug = path.join(tmp, 'plug');
  put(path.join(cfg, 'skills', 'ship'), '---\nname: ship\ndescription: Ship it\n---\n');
  put(path.join(plug, 'skills', 'lint'), '---\nname: lint\n---\n');
  const where = { configDir: cfg, cwd: path.join(tmp, 'proj') };
  const a = mergeCatalog(undefined, { skills: ['ship', 'acme:lint', 'built-in'] }, where);
  assert.deepEqual(Object.keys(a.skillFiles), ['ship'], 'the plugin is not known yet');
  const b = mergeCatalog(a, { plugins: [{ name: 'acme', path: plug }] }, where);
  assert.deepEqual(Object.keys(b.skillFiles), ['ship', 'acme:lint']);
  assert.equal(b.skillFiles['acme:lint'].scope, 'plugin');
  // nothing new: null; commands alone leave skillFiles as they were; without a location they are kept
  assert.equal(mergeCatalog(b, { skills: ['ship', 'acme:lint', 'built-in'] }, where), null);
  assert.equal(mergeCatalog(b, { commands: [{ name: 'x' }] }, where).skillFiles, b.skillFiles);
  assert.equal(mergeCatalog(b, { skills: ['ship'] }).skillFiles, b.skillFiles);
  assert.deepEqual(mergeCatalog(undefined, { commands: [] }).skillFiles, {});
});

test('init and the disk prefetch both fill skillFiles, in the account that asked', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sage-skills-flow-'));
  const cfg = path.join(tmp, 'cfg');
  const proj = path.join(tmp, 'proj');
  put(path.join(cfg, 'skills', 'ship'), '---\nname: ship\n---\n');
  put(path.join(proj, '.claude', 'skills', 'local'), '---\nname: local\n---\n');
  const sent: any[] = [];
  const state = { sessions: new Map(), broadcastCatalog: (e: any) => sent.push(e), activeAccount: () => 'a' };
  const auth = { cleanEnv: (account: string) => (account === 'a' ? { CLAUDE_CONFIG_DIR: cfg } : {}) };
  const queries = { extras: async () => ({ commands: [] }) };
  const cat = createCatalog(state, { auth, queries });
  // a folder no session has run in: skills are read from disk
  const fetched = await cat.catalog('/bin/claude', proj, undefined);
  assert.deepEqual(Object.keys(fetched.skillFiles).sort(), ['local', 'ship']);
  assert.equal(await cat.catalog('/bin/claude', proj, 'a'), fetched, 'a kept catalog is answered as it is');
  // a live session's init message replaces them
  const s = { account: 'a', cwd: proj, key: 'k', q: {}, commandsRead: true };
  cat.noteCatalog(s, { skills: ['ship', { name: 'gone' }], plugins: [] });
  assert.deepEqual(Object.keys(sent.at(-1).catalog.skillFiles), ['ship']);
  // an account with no config folder falls back to the home default; with no skills listed nothing is read there
  const other = createCatalog(state, { auth: { cleanEnv: () => ({}) }, queries });
  assert.deepEqual(other.setCatalog('b', path.join(tmp, 'x'), { skills: [] }).skillFiles, {});
});

test('a skill folder named like an Object.prototype member is an own entry; a listed name with no file is not found', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sage-skills-proto-'));
  const cfg = path.join(tmp, 'cfg');
  put(path.join(cfg, 'skills', '__proto__'), '---\nname: __proto__\ndescription: odd name\n---\n');
  const found = skillFilesFor(['__proto__', 'constructor', 'toString'], cfg, null, []);
  assert.deepEqual(Object.keys(found), ['__proto__']);
  assert.equal(Object.hasOwn(found, '__proto__'), true);
  assert.equal(Object.hasOwn(found, 'constructor'), false);
  assert.equal(JSON.parse(JSON.stringify(found))['__proto__'].path, path.join(cfg, 'skills', '__proto__', 'SKILL.md'));
  // the catalog's own-change check still sees it
  const where = { configDir: cfg, cwd: null };
  const first = mergeCatalog(undefined, { skills: ['__proto__', 'constructor'] }, where);
  assert.deepEqual(Object.keys(first.skillFiles), ['__proto__']);
  assert.equal(mergeCatalog(first, { skills: ['__proto__', 'constructor'] }, where), null);
});

test("a folder name never shadows another skill's own name, whichever order the folders come in", () => {
  for (const order of [
    ['a', 'b'],
    ['b', 'a'],
  ]) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sage-skills-alias-'));
    const cfg = path.join(tmp, 'cfg');
    const proj = path.join(tmp, 'proj');
    // folder a/ is named x, folder b/ is named a: "a" is b's skill, and a/ is reached as "x" (a project one is shadowed too)
    const files: Record<string, string> = { a: '---\nname: x\n---\n', b: '---\nname: a\n---\n' };
    for (const folder of order) put(path.join(cfg, 'skills', folder), files[folder]);
    put(path.join(proj, '.claude', 'skills', 'x'), '---\nname: other\n---\n');
    const index = indexSkills(indexRoots(cfg, proj));
    assert.equal(index.get('a').path, path.join(cfg, 'skills', 'b', 'SKILL.md'), order.join());
    assert.equal(index.get('x').path, path.join(cfg, 'skills', 'a', 'SKILL.md'), order.join());
    assert.equal(index.get('b').path, path.join(cfg, 'skills', 'b', 'SKILL.md'), 'a folder name still reaches its own skill');
    // the project's folder x is named other; "x" stays the personal one, as personal wins
    assert.equal(index.get('other').scope, 'project');
  }
});

test('a SKILL.md that has not changed is stat-ed, not read again; an edited one is read; a deleted one is gone', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sage-skills-cache-'));
  const cfg = path.join(tmp, 'cfg');
  const file = path.join(cfg, 'skills', 'cached', 'SKILL.md');
  put(path.dirname(file), '---\nname: cached\ndescription: first\n---\n');
  const reads: string[] = [];
  useFakeFs(t, {
    readFileSync: (p: string, ...rest: any[]) => (reads.push(String(p)), fs.readFileSync(p, ...(rest as [any]))),
  });
  const files = () => skillFilesFor(['cached'], cfg, null, []);
  assert.equal(files().cached.description, 'first');
  assert.equal(files().cached.description, 'first');
  assert.deepEqual(reads, [file], 'the second call only stat-ed it');
  // a new size is read again
  fs.writeFileSync(file, '---\nname: cached\ndescription: second, longer\n---\n');
  assert.equal(files().cached.description, 'second, longer');
  assert.equal(reads.length, 2);
  // the same size with a new mtime is read again too
  fs.writeFileSync(file, '---\nname: cached\ndescription: second, LONGER\n---\n');
  fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
  assert.equal(files().cached.description, 'second, LONGER');
  assert.equal(reads.length, 3);
  // a deleted file is not listed, and listing it again after it returns reads it afresh
  fs.rmSync(file);
  assert.deepEqual(files(), {});
  put(path.dirname(file), '---\nname: cached\ndescription: back\n---\n');
  assert.equal(files().cached.description, 'back');
  assert.equal(reads.length, 4);
});
