import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';

const calls: unknown[][] = [];
let reply: any = { data: [] };
mock.module('../src/harness/adapters/codex.ts', {
  namedExports: { codexRequest: async (m: string, p: unknown) => (calls.push([m, p]), reply) },
});
const { listCodexSkills, setCodexSkillEnabled } = await import('../src/harness/codexSkills.ts');

const sk = (path: string, scope: string) => ({ name: path, description: '', path, scope, enabled: true });

test('lists once per SKILL.md: repo beats user beats system, whichever folder reported it first', async () => {
  reply = {
    data: [
      { cwd: '/a', skills: [sk('/x', 'user'), sk('/y', 'repo'), sk('/z', 'system'), sk('/w', 'user')] },
      { cwd: '/b', skills: [sk('/x', 'repo'), sk('/y', 'user'), sk('/z', 'user'), sk('/w', 'user')] },
      { cwd: '/c' },
    ],
  };
  const list = await listCodexSkills(['/a', '/b'], true);
  assert.deepEqual(calls[0], ['skills/list', { cwds: ['/a', '/b'], forceReload: true }]);
  assert.deepEqual(
    list.map((k) => [k.path, k.scope, k.cwd]),
    [
      ['/x', 'repo', '/b'],
      ['/y', 'repo', '/a'],
      ['/z', 'user', '/b'],
      ['/w', 'user', '/a'],
    ],
  );
  reply = {};
  assert.deepEqual(await listCodexSkills([]), []);
  assert.deepEqual(calls[1], ['skills/list', { cwds: [], forceReload: false }]);
});

test('turning a skill on or off writes its config by path', async () => {
  calls.length = 0;
  await setCodexSkillEnabled('/x', false);
  assert.deepEqual(calls, [['skills/config/write', { path: '/x', enabled: false }]]);
});
