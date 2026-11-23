// electron/session/orchestration/family.cjs: who belongs to a chat's family of linked sessions, what each is doing,
// and which member a `to` names. A damaged chain of links can't loop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  rootOf,
  familyOf,
  isDescendant,
  nameOf,
  stateWord,
  resolveMember,
  rosterFor,
} = require('../electron/session/orchestration/family.cjs');

/** top → api, docs; api → tests */
function journal(children: Record<string, any> = {}) {
  const all: Record<string, any> = {
    api: { parentId: 'top', name: 'api', createdAt: 1, driven: [] },
    docs: { parentId: 'top', name: 'docs', createdAt: 2, driven: [] },
    tests: { parentId: 'api', name: 'tests', createdAt: 3, driven: [] },
    ...children,
  };
  return {
    data: { children: all, queue: [{ id: 'q', chatId: 'waiting' }] },
    child: (id: string) => all[id] ?? null,
    childrenOf: (id: string) =>
      Object.entries(all)
        .filter(([, c]) => c.parentId === id)
        .sort(([, a], [, b]) => a.createdAt - b.createdAt)
        .map(([k]) => k),
  };
}
function controller(states: Record<string, any> = {}) {
  return { state: { get: (id: string) => ({ turn: 'idle', queue: [], ...states[id] }) } };
}

test('the family is the top chat and every chat below it, children in the order they were started', () => {
  const j = journal();
  assert.equal(rootOf(j, 'tests'), 'top');
  assert.equal(rootOf(j, 'top'), 'top');
  assert.deepEqual(familyOf(j, 'tests'), ['top', 'api', 'tests', 'docs']);
  assert.deepEqual(familyOf(j, 'alone'), ['alone']);
  assert.equal(isDescendant(j, 'tests', 'top'), true);
  assert.equal(isDescendant(j, 'tests', 'api'), true);
  assert.equal(isDescendant(j, 'docs', 'api'), false);
  assert.equal(isDescendant(j, 'top', 'api'), false);
  assert.equal(nameOf(j, 'top'), 'top');
  assert.equal(nameOf(j, 'docs'), 'docs');
});

test('a chain of links that loops or runs too deep is cut instead of looping', () => {
  const loop = journal({ a: { parentId: 'b', name: 'a', createdAt: 9 }, b: { parentId: 'a', name: 'b', createdAt: 9 } });
  assert.ok(['a', 'b'].includes(rootOf(loop, 'a')));
  assert.ok(familyOf(loop, 'a').length <= 2);
  assert.equal(isDescendant(loop, 'a', 'zzz'), false);
  const self = journal({ me: { parentId: 'me', name: 'me', createdAt: 1 } });
  assert.equal(rootOf(self, 'me'), 'me');
  const deep: Record<string, any> = {};
  for (let i = 1; i <= 40; i++) deep[`n${i}`] = { parentId: `n${i - 1}`, name: `n${i}`, createdAt: i };
  const dj = journal(deep);
  assert.equal(rootOf(dj, 'n40'), 'n8');
  assert.equal(familyOf(dj, 'n0').length, 33);
  // a cycle under the top is visited once
  const cyc = journal({ x: { parentId: 'top', name: 'x', createdAt: 5 }, top: { parentId: 'x', name: 'top', createdAt: 6 } });
  assert.equal(new Set(familyOf(cyc, 'x')).size, familyOf(cyc, 'x').length);
});

test('stateWord: waiting on the user, working, failed (harness quit or last turn failed), else idle', () => {
  const j = journal({
    f: { parentId: 'top', name: 'f', createdAt: 9, lastReport: { how: 'failed' } },
    l: { parentId: 'top', name: 'l', createdAt: 9, lastReport: { how: 'lost' } },
  });
  const c = controller({ a: { turn: 'awaitingUser' }, r: { turn: 'running' }, q: { queue: [1] }, x: { turn: 'crashed' } });
  assert.equal(stateWord(c, j, 'a'), 'needs the user');
  assert.equal(stateWord(c, j, 'r'), 'working');
  assert.equal(stateWord(c, j, 'q'), 'working');
  assert.equal(stateWord(c, j, 'x'), 'failed');
  assert.equal(stateWord(c, j, 'f'), 'failed');
  assert.equal(stateWord(c, j, 'l'), 'failed');
  assert.equal(stateWord(c, j, 'docs'), 'idle');
  assert.equal(stateWord(c, j, 'waiting'), 'queued');
  assert.equal(
    stateWord(controller({ waiting: { turn: 'running' } }), j, 'waiting'),
    'working',
    'a running turn outranks its waiting item',
  );
});

test('resolveMember: "parent", a member id, or a member name; nothing outside the family', () => {
  const j = journal();
  assert.equal(resolveMember(j, 'tests', 'parent'), 'api');
  assert.equal(resolveMember(j, 'tests', ' PARENT '), 'api');
  assert.equal(resolveMember(j, 'top', 'parent'), null);
  assert.equal(resolveMember(j, 'tests', 'docs'), 'docs');
  assert.equal(resolveMember(j, 'tests', 'DOCS'), 'docs');
  assert.equal(resolveMember(j, 'tests', 'top'), 'top');
  assert.equal(resolveMember(j, 'docs', 'tests'), 'tests');
  assert.equal(resolveMember(j, 'docs', 'stranger'), null);
  assert.equal(resolveMember(j, 'docs', ''), null);
  assert.equal(resolveMember(j, 'docs', undefined), null);
});

test('rosterFor names the parent, the others with their state, and who started a grandchild; archived ones are left out', () => {
  const j = journal();
  const c = controller({ docs: { turn: 'running' } });
  const fromTests = rosterFor(c, j, 'tests');
  assert.match(fromTests, /top = top \(idle\); parent \(api\) = api \(idle\); docs = docs \(working\)/);
  const fromTop = rosterFor(c, j, 'top', (id: string) => id === 'docs');
  assert.match(fromTop, /api = api \(idle\); tests = tests \(idle, started by api\)\./);
  assert.ok(!fromTop.includes('docs ='));
  assert.equal(rosterFor(c, j, 'alone'), '');
});
