// The gateway's rule matrix (shared/toolRules.mjs, #2999 C3), the one decider every listing and call uses (electron/gateway/policy.cjs): the most specific scope wins (a deeper project over a shallower one, a project over a harness, a harness over all), on a tie block beats ask beats allow; with no rule Full access allows, a read-only tool is allowed and the rest ask; a rule holds in every permission mode, so a block holds under Full access; unreadable rules make everything ask; a listing that doesn't know the chat's folder is uncertain wherever a project rule might apply; globs match the tool's own name, with escapes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideStance, globMatch, exactPattern, scopeRank, ruleOf, STANCES } from '../shared/toolRules.mjs';

// the files it reads, for the guards in tests/invariantGuards.invariant.test.ts
export const GUARDS = ['shared/toolRules.mjs', 'electron/gateway/'];

const S = 'srv-key';
const rule = (stance: string, scope = 'all', pattern = '*', connector = S): any => ({ connector, pattern, stance, scope });
const base = {
  connector: S,
  tool: 'create_issue',
  readOnly: false,
  harness: 'codex',
  project: '/work/app' as string | null | undefined,
  fullAccess: false,
};
const stance = (rules: any[], o: Partial<typeof base> & { unreadable?: boolean } = {}) => decideStance({ ...base, ...o, rules }).stance;

test('no rule: Full access allows; otherwise a read-only tool is allowed and every other one asks', () => {
  for (const fullAccess of [false, true])
    for (const readOnly of [false, true])
      assert.equal(stance([], { fullAccess, readOnly }), fullAccess || readOnly ? 'allow' : 'ask', `${fullAccess} ${readOnly}`);
  assert.equal(decideStance({ ...base, rules: [] }).why, 'default');
  assert.equal(decideStance({ ...base, rules: [], fullAccess: true }).why, 'full-access');
  assert.equal(decideStance({ ...base, rules: [], readOnly: true }).why, 'read-only');
});

test('a rule holds in every permission mode: block under Full access, ask for a read-only tool, allow for a change', () => {
  for (const s of STANCES)
    for (const fullAccess of [false, true])
      for (const readOnly of [false, true]) assert.equal(stance([rule(s)], { fullAccess, readOnly }), s, `${s} ${fullAccess} ${readOnly}`);
});

test('the most specific scope wins: deeper project > project > harness > all, whatever the stances', () => {
  const all = rule('block', 'all');
  const harness = rule('allow', 'harness:codex');
  const project = rule('block', 'project:/work');
  const deeper = rule('allow', 'project:/work/app');
  assert.equal(stance([all, harness]), 'allow');
  assert.equal(stance([harness, project]), 'block');
  assert.equal(stance([project, deeper]), 'allow');
  assert.equal(stance([deeper, project, harness, all]), 'allow');
  assert.equal(decideStance({ ...base, rules: [all, deeper] }).rule, deeper);
});

test('on a tie of scope block beats ask beats allow, in any order', () => {
  const orders = [
    ['allow', 'ask', 'block'],
    ['block', 'ask', 'allow'],
    ['ask', 'allow', 'block'],
  ];
  for (const order of orders) assert.equal(stance(order.map((s) => rule(s, 'harness:codex'))), 'block', order.join());
  assert.equal(stance([rule('allow'), rule('ask')]), 'ask');
  assert.equal(stance([rule('ask', 'project:/work'), rule('allow', 'project:/work/')]), 'ask', 'a trailing / is the same folder');
});

test('scopes: a harness by kind or family; a project folder or inside it, never a sibling with the same prefix', () => {
  assert.equal(scopeRank('harness:acp', { harness: 'acp:opencode', project: null }), 1);
  assert.equal(scopeRank('harness:acp:opencode', { harness: 'acp:opencode', project: null }), 1);
  assert.equal(scopeRank('harness:claude', { harness: 'codex', project: null }), -1);
  assert.equal(scopeRank('harness:', { harness: 'codex', project: null }), -1);
  assert.equal(scopeRank('harness:codex', { harness: null, project: null }), -1);
  assert.equal(stance([rule('block', 'project:/work/ap')]), 'ask', '/work/app is not inside /work/ap');
  assert.equal(stance([rule('block', 'project:/work/app')], { project: '/work/app/sub' }), 'block');
  assert.equal(stance([rule('block', 'project:/')]), 'block');
  assert.equal(stance([rule('block', 'project:/work')], { project: null }), 'ask', 'a chat with no folder is in no project');
  assert.equal(scopeRank('project:relative', { harness: null, project: '/x' }), -1);
  assert.equal(scopeRank('other:thing', { harness: 'codex', project: '/x' }), -1);
});

test('a rule applies only to its server (or every server with *), and to the tools its glob matches', () => {
  assert.equal(stance([rule('block', 'all', '*', 'other-key')]), 'ask');
  assert.equal(stance([rule('block', 'all', '*', '*')]), 'block');
  assert.equal(stance([rule('block', 'all', 'create_*')]), 'block');
  assert.equal(stance([rule('block', 'all', 'delete_*')]), 'ask');
  assert.equal(stance([rule('block', 'all', 'create_issu?')]), 'block');
  assert.equal(stance([rule('allow', 'all', 'x'), rule('nonsense' as any)]), 'ask', 'a stance that is no stance is ignored');
});

test('globs: * and ? wildcards, \\ escapes, regex characters are literal, the whole name must match', () => {
  assert.equal(globMatch('a*', 'abc'), true);
  assert.equal(globMatch('a?c', 'abc'), true);
  assert.equal(globMatch('a?c', 'ac'), false);
  assert.equal(globMatch('a.c', 'abc'), false);
  assert.equal(globMatch('a+b(c)[d]{e}|^$', 'a+b(c)[d]{e}|^$'), true);
  assert.equal(globMatch('a\\*b', 'a*b'), true);
  assert.equal(globMatch('a\\*b', 'axb'), false);
  assert.equal(globMatch('ab\\', 'ab\\'), true, 'a trailing \\ is itself');
  assert.equal(globMatch('*', 'line\nbreak'), true);
  assert.equal(globMatch('b', 'abc'), false);
  for (const name of ['a*b', 'q?', 'back\\slash', 'plain']) {
    assert.equal(globMatch(exactPattern(name), name), true, name);
    assert.equal(globMatch(exactPattern(name), `${name}x`), false, name);
  }
  assert.equal(globMatch(exactPattern('a*b'), 'axxb'), false);
});

test('rules that can’t be read: every call without a block or an ask asks, read-only and Full access too; no allow last read is trusted', () => {
  for (const fullAccess of [false, true])
    for (const readOnly of [false, true]) assert.equal(stance([], { unreadable: true, fullAccess, readOnly }), 'ask');
  assert.equal(decideStance({ ...base, rules: [], unreadable: true }).why, 'unreadable');
  assert.equal(stance([rule('block')], { unreadable: true }), 'block');
  assert.equal(stance([rule('ask')], { unreadable: true, fullAccess: true }), 'ask');
  assert.equal(stance([rule('allow')], { unreadable: true }), 'ask');
  assert.equal(stance([rule('allow', 'project:/work/app'), rule('block', 'all')], { unreadable: true }), 'block');
});

test('a rule that also names a harness applies only there; it ties with the same scope without it, and a block wins the tie', () => {
  const allowCodexHere = { ...rule('allow', 'project:/work/app'), harness: 'codex' };
  assert.equal(stance([allowCodexHere]), 'allow');
  assert.equal(stance([allowCodexHere], { harness: 'claude' }), 'ask', 'not for another harness');
  assert.equal(stance([allowCodexHere, rule('block', 'project:/work/app')]), 'block', 'a later block at the same scope wins');
  assert.equal(stance([{ ...rule('allow'), harness: 'codex' }, rule('block')], { fullAccess: true }), 'block');
  assert.equal(stance([{ ...rule('allow'), harness: 'acp' }], { harness: 'acp:opencode' }), 'allow');
  assert.equal(stance([{ ...rule('allow', 'project:/work/app'), harness: 'claude' }, rule('block', 'harness:codex')]), 'block');
});

test('folders: a `/` path or a Windows drive’s `C:/` one, compared as written (the caller gives real paths), never by prefix', () => {
  assert.equal(stance([rule('block', 'project:C:/work')], { project: 'C:/work/app' }), 'block');
  assert.equal(stance([rule('block', 'project:C:/')], { project: 'C:/work' }), 'block');
  assert.equal(stance([rule('block', 'project:C:/work')], { project: 'C:/workshop' }), 'ask');
  assert.equal(stance([rule('block', 'project:D:/work')], { project: 'C:/work' }), 'ask');
  assert.equal(stance([rule('block', 'project:/Work/App')]), 'ask', 'case as written: the real path has the disk’s own');
  assert.equal(scopeRank('project:C:/work', { harness: null, project: 'C:/work/app' }), 9);
  assert.equal(stance([rule('block', 'project://srv/share')], { project: '//srv/share/app' }), 'block');
  assert.equal(stance([rule('block', 'project://srv/share')], { project: '//srv/shared' }), 'ask');
  assert.equal(stance([rule('block', 'project:/')], { project: '//srv/share' }), 'block');
});

test('a listing that doesn’t know the chat’s folder is uncertain where a project rule might apply, and certain otherwise', () => {
  const unknown = { project: undefined };
  const all = decideStance({ ...base, ...unknown, rules: [rule('block')] });
  assert.deepEqual([all.stance, all.certain], ['block', true]);
  const maybe = decideStance({ ...base, ...unknown, rules: [rule('block'), rule('allow', 'project:/work')] });
  assert.deepEqual([maybe.stance, maybe.certain], ['block', false]);
  // a project rule for another server or tool doesn't make it uncertain
  const other = decideStance({ ...base, ...unknown, rules: [rule('block'), rule('allow', 'project:/work', 'delete_*')] });
  assert.equal(other.certain, true);
  // nor one that would give the same stance anyway
  assert.equal(decideStance({ ...base, ...unknown, rules: [rule('block'), rule('block', 'project:/work')] }).certain, true);
  assert.equal(decideStance({ ...base, ...unknown, fullAccess: true, rules: [rule('allow', 'project:/elsewhere')] }).certain, true);
  assert.equal(decideStance({ ...base, ...unknown, fullAccess: true, rules: [rule('block', 'project:/elsewhere')] }).certain, false);
  assert.equal(scopeRank('project:/work', { harness: null, project: undefined }), undefined);
});

test('ruleOf takes only well-formed rules', () => {
  assert.deepEqual(ruleOf({ connector: '*', pattern: 'a*', stance: 'block', scope: 'project:/x', extra: 1 }), {
    connector: '*',
    pattern: 'a*',
    stance: 'block',
    scope: 'project:/x',
  });
  for (const bad of [
    null,
    [],
    {},
    { connector: '', pattern: 'a', stance: 'allow', scope: 'all' },
    { connector: 'k'.repeat(8193), pattern: 'a', stance: 'allow', scope: 'all' },
    { connector: 'k', pattern: '', stance: 'allow', scope: 'all' },
    { connector: 'k', pattern: 'p'.repeat(257), stance: 'allow', scope: 'all' },
    { connector: 'k', pattern: 'a\nb', stance: 'allow', scope: 'all' },
    { connector: 'k', pattern: 'a', stance: 'maybe', scope: 'all' },
    { connector: 'k', pattern: 'a', stance: 'allow', scope: 'everywhere' },
    { connector: 'k', pattern: 'a', stance: 'allow', scope: 'harness:Codex!' },
    { connector: 'k', pattern: 'a', stance: 'allow', scope: 'project:relative' },
    { connector: 'k', pattern: 'a', stance: 'allow', scope: 'project:/a/../b' },
    { connector: 'k', pattern: 'a', stance: 'allow', scope: 'project:/a/..' },
    { connector: 'k', pattern: 'a', stance: 'allow', scope: `project:/${'x'.repeat(4096)}` },
    { connector: 'k', pattern: 'a', stance: 'allow', scope: 'all\u0007' },
    { connector: 'k', pattern: 'a', stance: 'allow', scope: 5 },
    { connector: 'k', pattern: 'a', stance: 'allow', scope: 'project:/a/./b' },
    { connector: 'k', pattern: 'a', stance: 'allow', scope: 'project:/a//b' },
    { connector: 'k', pattern: 'a', stance: 'allow', scope: 'project:/a/.' },
    { connector: 'k', pattern: 'a', stance: 'allow', scope: 'all', harness: 'Codex!' },
    { connector: 'k', pattern: 'a', stance: 'allow', scope: 'all', harness: 5 },
    { connector: 'k', pattern: 'a', stance: 'allow', scope: 'project:C:\\work' },
    { connector: 'k', pattern: 'a', stance: 'allow', scope: 'project:c:/work' },
    { connector: 'k', pattern: 'a', stance: 'allow', scope: 'project://' },
    { connector: 'k', pattern: 'a', stance: 'allow', scope: 'project://srv' },
    { connector: 'k', pattern: 'a', stance: 'allow', scope: 'harness:/etc' },
    { connector: 'k', pattern: 'a', stance: 'allow', scope: 'blockall/x' },
    { connector: 'k', pattern: 'a', stance: 'allow', scope: 'xxxxxxxxC:/y' },
    { connector: 'k', pattern: 'a', stance: 'allow', scope: 'project:C:work' },
  ])
    assert.equal(ruleOf(bad), null, JSON.stringify(bad));
  assert.ok(ruleOf({ connector: 'k', pattern: 'a', stance: 'ask', scope: 'harness:acp:opencode' }));
  // the same folder is always the same text: a trailing / goes (a root's stays); a network share keeps its //
  const scopeOf = (scope: string) => ruleOf({ connector: 'k', pattern: 'a', stance: 'ask', scope })?.scope;
  assert.equal(scopeOf('project:/a/'), 'project:/a');
  assert.equal(scopeOf('project:/a///'), 'project:/a');
  assert.equal(scopeOf('project:/'), 'project:/');
  assert.equal(scopeOf('project:C:/w/'), 'project:C:/w');
  assert.equal(scopeOf('project:C:/'), 'project:C:/');
  assert.equal(scopeOf('project:C://'), 'project:C:/', 'a drive root keeps its /');
  assert.equal(scopeOf('project:C:///'), 'project:C:/');
  assert.equal(scopeOf('project://srv/share/app/'), 'project://srv/share/app');
  assert.deepEqual(ruleOf({ connector: 'k', pattern: 'a', stance: 'allow', scope: 'project:/a/.b', harness: 'codex' }), {
    connector: 'k',
    pattern: 'a',
    stance: 'allow',
    scope: 'project:/a/.b',
    harness: 'codex',
  });
});
