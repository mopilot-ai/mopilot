// Instruction budgets measure real UTF-8 input, discover marked skills, and reject broken local references.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { auditInstructions, instructionEntries, LIMITS, main } from '../scripts/instruction-budget.mjs';

function fixture(t: any, text = '# Rules\n') {
  const root = mkdtempSync(path.join(tmpdir(), 'instruction-budget-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, '.agents/skills'), { recursive: true });
  writeFileSync(path.join(root, 'AGENTS.md'), text);
  return {
    root,
    put(file: string, body: string) {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      writeFileSync(path.join(root, file), body);
    },
  };
}
const marked = (body: string) => '---\nname: workflow\nmetadata:\n  instruction_budget: workflow\n---\n' + body;

test('only marked skill entrypoints count; references and unrelated files remain conditional', (t) => {
  const f = fixture(t);
  f.put('.agents/skills/a/SKILL.md', marked('small'));
  f.put('.agents/skills/a/references/details.md', 'x'.repeat(20000));
  f.put('.agents/skills/b/SKILL.md', 'unmarked');
  f.put('.agents/skills/empty/notes.txt', 'not a skill');
  f.put('.agents/skills/notes.txt', 'not a directory');
  f.put('.agents/skills/c/SKILL.md', marked('other').replaceAll('\n', '\r\n'));
  f.put('.agents/skills/d/SKILL.md', '---\nmetadata: null\n---\n');
  f.put('.agents/skills/e/SKILL.md', '---\n# Empty YAML\n---\n');
  f.put('.agents/skills/f/SKILL.md', '---\nname: unmarked\n---\n');
  assert.deepEqual(
    instructionEntries(f.root).map((e: any) => e.file),
    ['AGENTS.md', '.agents/skills/a/SKILL.md', '.agents/skills/c/SKILL.md'],
  );
  assert.deepEqual(auditInstructions(f.root).issues, []);
});

test('limits use UTF-8 bytes and allow the exact ceiling', (t) => {
  const f = fixture(t, 'a'.repeat(LIMITS.instructions));
  assert.equal(auditInstructions(f.root).totals.instructions, LIMITS.instructions);
  assert.deepEqual(auditInstructions(f.root).issues, []);
  f.put('AGENTS.md', 'é'.repeat(LIMITS.instructions));
  assert.match(auditInstructions(f.root).issues[0], /instructions: 12288 bytes exceeds 6144/);
  f.put('.agents/skills/a/SKILL.md', marked('x'.repeat(LIMITS.workflows)));
  assert.match(auditInstructions(f.root).issues[1], /workflows:/);
});

test('quoted markers count and malformed front matter cannot bypass admission', (t) => {
  const f = fixture(t);
  f.put('.agents/skills/a/SKILL.md', marked('x'.repeat(LIMITS.workflows)).replace('budget: workflow', 'budget: "workflow"'));
  assert.match(auditInstructions(f.root).issues[0], /workflows:/);
  f.put('.agents/skills/a/SKILL.md', '---\nname: x\nmetadata: [broken\n');
  assert.throws(() => auditInstructions(f.root), /front matter/i);
  f.put('.agents/skills/a/SKILL.md', '---\nname: x\nmetadata: [broken\n---\nbody');
  assert.throws(() => auditInstructions(f.root), /front matter/i);
});

test('reference links, percent-encoded paths and inline titles resolve as Markdown does', (t) => {
  const f = fixture(t, '[guide][procedure]\n\n[procedure]: missing.md\n');
  assert.match(auditInstructions(f.root).issues[0], /missing.md/);
  f.put('missing.md', 'found');
  f.put('a b.md', 'space');
  f.put('AGENTS.md', '[guide][procedure] [space](a%20b.md "Title")\n\n[procedure]: missing.md\n');
  assert.deepEqual(auditInstructions(f.root).issues, []);
  f.put('AGENTS.md', '![image](missing.md?raw=1) [web](//example.com/path) ` [code](gone.md) `');
  assert.deepEqual(auditInstructions(f.root).issues, []);
  f.put('AGENTS.md', '[invalid](bad%ZZ.md)');
  assert.throws(() => auditInstructions(f.root), URIError);
});

test('local paths resolve from each entrypoint; anchors and external links need no disk file', (t) => {
  const f = fixture(
    t,
    '[local](guide.md#part) [anchor](#here) [web](https://example.com) [mail](mailto:a@example.com) [angle](<guide.md>)',
  );
  f.put('guide.md', '# Guide\n');
  f.put('.agents/skills/a/SKILL.md', marked('[own](references/detail.md) [missing](references/gone.md)'));
  f.put('.agents/skills/a/references/detail.md', 'detail');
  assert.deepEqual(auditInstructions(f.root).issues, ['.agents/skills/a/SKILL.md: missing local reference references/gone.md']);
  f.put('.agents/skills/a/references/gone.md', 'found');
  assert.deepEqual(auditInstructions(f.root).issues, []);
});

test('the CLI reports JSON, bounded text and failures without mutating inputs', (t) => {
  const f = fixture(t);
  const output: string[] = [];
  assert.equal(main(['--json'], { root: f.root, log: (s: string) => output.push(s) }), 0);
  assert.deepEqual(JSON.parse(output.pop()!).issues, []);
  assert.equal(main([], { root: f.root, log: (s: string) => output.push(s) }), 0);
  assert.match(output.pop()!, /local references intact/);
  f.put('AGENTS.md', '[gone](gone.md)');
  assert.equal(main([], { root: f.root, log: (s: string) => output.push(s) }), 1);
  assert.match(output.pop()!, /missing local reference/);
  assert.throws(() => main(['--bad'], { root: f.root }), /Usage:/);
  const run = spawnSync(process.execPath, ['scripts/instruction-budget.mjs', '--json'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.equal(JSON.parse(run.stdout).issues.length, 0);
  const bad = spawnSync(process.execPath, ['scripts/instruction-budget.mjs', '--bad'], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /Usage:/);
});
