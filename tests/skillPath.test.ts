// Where a chat's skill is on this Mac (src/session/harness/skillPath.ts): the Claude catalog's path for the chat's own folder,
// nothing for another harness, a chat on a machine, a folder not known yet or a skill the catalog does not list.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

const asked: unknown[][] = [];
let machine = ''; // '' = this Mac; anything else = a machine's id; a chat not known yet reads as no folder too
let files: Record<string, { path: string; description: string; scope: string }> | null = {};
let threads: Record<string, { cwd?: string }> = { c1: { cwd: '/repo' } };
mock.module('../src/store/core.ts', { namedExports: { useStore: (pick: (s: unknown) => unknown) => pick({ threads }) } });
mock.module('../src/lib/chatMachine.ts', {
  namedExports: { useFolderHere: (_id: string | null, cwd: string) => (machine === '' ? cwd : '') },
});
mock.module('../src/session/harness/claude.ts', {
  namedExports: { useClaudeSkillFiles: (...a: unknown[]) => (asked.push(a), files) },
});
const { useSkillFile, useSkillPath } = await import('../src/session/harness/skillPath.ts');

const FILE = { path: '/h/ship/SKILL.md', description: 'Ship it', scope: 'personal' };

test("a skill's path is the Claude catalog's for this chat's folder; a leading slash is ignored", () => {
  files = { ship: FILE };
  asked.length = 0;
  assert.equal(useSkillPath('c1', 'ship'), FILE.path);
  assert.equal(useSkillPath('c1', '/ship'), FILE.path);
  assert.equal(useSkillFile('c1', 'ship'), FILE);
  assert.deepEqual(asked.at(-1), ['c1', '/repo']);
});

test('no path for an unknown skill, another harness (no catalog), a chat on a machine, or a chat without a folder', () => {
  files = { ship: FILE };
  assert.equal(useSkillPath('c1', 'other'), null);
  assert.equal(useSkillPath('c1', ''), null);
  files = null;
  assert.equal(useSkillPath('c1', 'ship'), null, 'a chat on another harness');
  files = { ship: FILE };
  machine = 'm1';
  assert.equal(useSkillPath('c1', 'ship'), null, "a machine's folder is not on this Mac");
  machine = '';
  threads = { c1: {} };
  assert.equal(useSkillPath('c1', 'ship'), null, 'no folder');
  assert.equal(useSkillPath('missing', 'ship'), null, 'a chat not in the store');
  assert.equal(useSkillPath(null, 'ship'), null, 'no chat');
});

test('only own entries resolve: a skill named like an Object.prototype member has no path unless it is listed', () => {
  threads = { c1: { cwd: '/repo' } };
  files = { ship: FILE };
  const lookup = useSkillPath;
  for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) assert.equal(lookup('c1', name), null, name);
  // listed under such a name (an own key), it resolves
  files = JSON.parse('{"__proto__":{"path":"/h/p/SKILL.md","description":"","scope":"personal"}}');
  assert.equal(useSkillPath('c1', '__proto__'), '/h/p/SKILL.md');
});
