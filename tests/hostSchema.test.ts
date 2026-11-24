// The Host wire's parsers and version gates (shared/host/schema.mjs): missing, wrong and extra fields on every method (B1-B3), the refuse-not-degrade gates, and the tool names a client cannot choose (B8).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const S = require('../shared/host/schema.mjs');

const key = 'req-0000001';
const scope = { chatId: 'claude:abc', epoch: 3 };
const send = { ...scope, key, text: ' hi ' };
const proof = { publicKey: 'MCowBQYDK2VwAyEA', nonce: 'a1b2c3d4', signature: 'c2lnbmF0dXJl' };
const valid: Record<string, any> = {
  'chat.attach': { ...scope, key, imageId: '0'.repeat(64), offset: 0, size: 1, mime: 'image/png', data: 'eA==' },
  'chat.history': { ...scope, generation: 'g', rev: 1, index: 0, offset: 0 },
  'chat.image': { ...scope, imageId: '0'.repeat(64), offset: 0 },
  'chat.switch': { ...scope, key, harness: 'codex' },
  'chat.goal': { ...scope, key, action: 'pause' },
  'chat.rename': { ...scope, key, name: 'Mine' },
  'host.hello': S.helloParams(),
  'host.status': {},
  'host.login': { harness: 'gemini', methodId: 'oauth-personal' },
  'host.loginStatus': { harness: 'gemini' },
  'host.loginCancel': { harness: 'gemini' },
  'host.logout': { harness: 'claude' },
  'host.modelKey': { harness: 'claude', key: 'sk-ant-test-0000000000000000' },
  'host.orgLease': { harness: 'claude', identity: '0'.repeat(32), token: null },
  'host.loginInput': { harness: 'claude', text: 'abc#123' },
  'host.install': { harness: 'codex' },
  'host.installStatus': { harness: 'codex' },
  'host.installCancel': { harness: 'gemini' },
  'host.policy': { doc: { version: 1 } },
  'host.scheduleSync': {
    tasks: [
      {
        id: 't1',
        name: 'N',
        rrule: 'FREQ=DAILY',
        zone: 'UTC',
        prompt: 'p',
        harness: 'claude',
        cwd: '/srv',
        status: 'ACTIVE',
        scheduleFrom: 0,
      },
    ],
  },
  'host.scheduleRuns': { after: 0 },
  'host.toolsSync': { tools: [{ name: 'browser_open', policy: 'act' }] },
  'host.toolResult': { chatId: 'acp:fake:a', epoch: 0, callId: 'call-1', ok: true, content: [{ type: 'text', text: 'ok' }] },
  'host.challenge': {},
  'host.clients': {},
  'host.auditRead': { after: 0, limit: 10 },
  'host.clientAdd': { publicKey: 'AAAA', kind: 'phone', name: 'Pocket iPhone' },
  'host.clientRemove': { fingerprint: 'a'.repeat(64) },
  'host.clientRename': { name: 'Work MacBook Pro' },
  'host.homeLinkRepair': {},
  'host.gitCommit': { path: '/srv/app', message: 'm', files: null },
  'host.gitDiscard': { path: '/srv/app', file: null },
  'host.relayEnroll': {
    relayUrl: 'wss://relay.example/v1/ws',
    hostId: 'h_host0000000000001',
    secret: 'S'.repeat(43),
    pairId: 'p_hostpair01',
    appPub: Buffer.alloc(32, 1).toString('base64'),
    appEphPub: Buffer.alloc(32, 2).toString('base64'),
  },
  'host.relayForget': { hostId: 'h_host0000000000001' },
  'host.relayStatus': {},
  'host.momoStatus': {},
  'host.momoGrant': { account: 'a1', features: ['momo'] },
  'host.momoChat': { harness: 'claude' },
  'host.momoHomeStart': { homeId: 'home-aaaa-1111', name: 'Studio' },
  'host.momoHomeLook': {},
  'host.momoStandDown': { homeId: 'home-bbbb-2222', leaseEpoch: 2, name: 'Mini' },
  'host.momoTurn': { turnId: 'key-00000001' },
  'host.momoReset': {},
  'host.momoPrefs': {},
  'host.momoMemory': { op: 'list' },
  'host.momoBriefNow': {},
  'host.momoIntent': { key: 'dana-1', action: 'dismiss' },
  'host.momoMove': { op: 'begin', moveId: 'move-0001' },
  'host.momoCards': {},
  'host.momoCardAnswer': { cardId: 'card-1', decision: 'allow' },
  'host.momoNotes': {},
  'host.momoNoteAct': { op: 'undo', journalId: 'j-1' },
  'host.momoRules': {},
  'host.momoRuleAct': { op: 'confirm', ruleId: 'r-1' },
  'host.momoReact': { cardId: 'card-1', kind: 'deny' },
  'host.momoGoogle': { op: 'status' },
  'host.momoRows': {},
  'host.momoLaneIntent': { intent: { kind: 'task.stop', id: 't-1' } },
  'host.momoTasks': { op: 'view' },
  'host.momoLink': { op: 'key' },
  'host.momoNotice': { op: 'state' },
  'host.pair': { ...proof, code: 'ABCD-EFGH-JKMN' },
  'host.auth': proof,
  'chat.start': { ...scope, key, harness: 'codex', text: 'go', projectId: null },
  'chat.send': send,
  'chat.stop': { ...scope, key },
  'chat.permit': { ...scope, key, value: 'auto' },
  'chat.answer': { ...scope, key, requestId: 'acpperm-1-abcd1234', optionId: 'allow' },
  'chat.subscribe': scope,
  'chat.prepareContinue': { ...scope, key, harness: 'claude', cwd: '/home/u/b', handoff: 'the chat so far' },
  'chat.commitContinue': { chatId: 'claude:abc', expectedEpoch: 3, targetHostId: 'host-b', preparedId: 'prepared-0001' },
  'chat.release': { ...scope, preparedId: 'prepared-0001' },
  'chat.remove': { ...scope, key },
  'chat.login': { ...scope, key, login: 'work' },
  'fs.list': { path: '/home/u' },
  'git.clone': { key, url: 'https://github.com/a/b.git', dest: '/home/u/b' },
  'git.worktree': { key, repo: '/home/u/b', branch: 'feat/x' },
  'git.inspect': { path: '/home/u/b' },
  'git.carryPush': { key, path: '/home/u/b' },
  'git.carryApply': { key, path: '/home/u/b', branch: 'mopilot/carry/abcdefgh', commit: 'a'.repeat(40), parent: 'b'.repeat(40) },
  'git.carryPlan': { path: '/home/u/b' },
  'git.status': { path: '/home/u/b' },
  'host.gitBranches': { path: '/home/u/b' },
  'host.gitSwitch': { path: '/home/u/b', branch: 'feat/x' },
  'host.gitTurnDiff': { path: '/home/u/b', turnId: 'turn-1' },
  'fs.tree': { path: '/home/u/b' },
  'git.diff': { path: '/home/u/b', scope: 'branch' },
  'fs.read': { path: '/home/u/b/a.txt', limit: 100 },
  'fs.search': { path: '/home/u/b', query: 'main' },
  'git.carryDrop': { path: '/home/u/b', branch: 'mopilot/carry/abcdefgh' },
  'host.pending': {},
  'host.chats': { limit: 50 },
  'host.chats.watch': {},
  'host.commands': { harness: 'claude', cwd: '/home/u/b' },
};
const invalid = (fn: () => unknown) => assert.throws(fn, (e: any) => e instanceof S.SchemaError && e.code === 'invalid');

test('every method has a parser and a valid request parses (B1)', () => {
  // the browser requests have their own parser test (hostBrowserWire.test.ts), the desktop's are in hostDesktop.test.ts
  assert.deepEqual(
    Object.keys(S.PARSERS)
      .filter((m) => !m.startsWith('browser.') && !m.startsWith('desktop.'))
      .sort(),
    Object.keys(valid).sort(),
  );
  for (const [m, p] of Object.entries(valid)) assert.ok(S.parseParams(m, p));
  assert.equal(S.parseParams('chat.send', send).text, 'hi');
});

test('B1: unknown methods and non-object params are refused or read as empty', () => {
  invalid(() => S.parseParams('chat.nope', {}));
  assert.equal(S.knownMethod(5), false);
  assert.deepEqual(S.parseParams('host.status', null), {});
  invalid(() => S.parseParams('chat.send', 'text'));
});

test('B1: a chat request without its chat, epoch or key is refused, field by field', () => {
  for (const m of ['chat.start', 'chat.send', 'chat.stop', 'chat.permit', 'chat.answer', 'chat.subscribe']) {
    for (const field of ['chatId', 'epoch'] as const) {
      const { [field]: _drop, ...rest } = valid[m];
      invalid(() => S.parseParams(m, rest));
    }
  }
  for (const m of [
    'chat.start',
    'chat.send',
    'chat.stop',
    'chat.permit',
    'chat.answer',
    'git.clone',
    'git.worktree',
    'git.carryPush',
    'git.carryApply',
  ]) {
    const { key: _drop, ...rest } = valid[m];
    invalid(() => S.parseParams(m, rest));
  }
  invalid(() => S.parseParams('host.hello', {}));
});

test('B1: a pairing request without its key, challenge, signature or code, or with one that is too long, is refused', () => {
  for (const m of ['host.pair', 'host.auth']) {
    for (const field of ['publicKey', 'nonce', 'signature'] as const) {
      const { [field]: _drop, ...rest } = valid[m];
      invalid(() => S.parseParams(m, rest));
      invalid(() => S.parseParams(m, { ...valid[m], [field]: 5 }));
      invalid(() => S.parseParams(m, { ...valid[m], [field]: '' }));
      invalid(() => S.parseParams(m, { ...valid[m], [field]: 'x'.repeat(201) }));
    }
  }
  const { code: _code, ...noCode } = valid['host.pair'];
  invalid(() => S.parseParams('host.pair', noCode));
  invalid(() => S.parseParams('host.pair', { ...valid['host.pair'], code: 'x'.repeat(65) }));
  assert.deepEqual(S.parseParams('host.auth', { ...proof, extra: 1 }), proof, 'a field the method does not name is dropped');
  assert.deepEqual(S.parseParams('host.challenge', { junk: 1 }), {});
});

test('B2: wrong types and ranges are refused, never coerced', () => {
  for (const epoch of ['3', -1, 1.5, null, NaN, Number.MAX_SAFE_INTEGER + 2])
    invalid(() => S.parseParams('chat.stop', { ...valid['chat.stop'], epoch }));
  for (const k of [3, '', 'short', 'has space 1234', 'x'.repeat(129)])
    invalid(() => S.parseParams('chat.stop', { ...valid['chat.stop'], key: k }));
  invalid(() => S.parseParams('chat.subscribe', { ...scope, fromRev: -1 }));
  invalid(() => S.parseParams('chat.subscribe', { ...scope, fromRev: '4' }));
  assert.equal(S.parseParams('chat.subscribe', { ...scope, fromRev: 0 }).fromRev, 0);
  invalid(() => S.parseParams('chat.send', { ...send, text: '   ' }));
  invalid(() => S.parseParams('chat.send', { ...send, text: 'x'.repeat(100_001) }));
  invalid(() => S.parseParams('chat.send', { ...send, text: 5 }));
  invalid(() => S.parseParams('chat.start', { ...valid['chat.start'], harness: 'gemini' }));
  invalid(() => S.parseParams('chat.start', { ...valid['chat.start'], harness: undefined }));
  invalid(() => S.parseParams('chat.start', { ...valid['chat.start'], cwd: 'a\0b' }));
  invalid(() => S.parseParams('chat.permit', { ...valid['chat.permit'], value: {} }));
  invalid(() => S.parseParams('fs.list', { path: '' }));
  invalid(() => S.parseParams('fs.list', { path: 'x'.repeat(4097) }));
});

test('B2: a clone address that Git could read as an option or a local path is refused', () => {
  for (const url of ['--upload-pack=x', '-u', 'file:///etc', '/etc/passwd', 'https://a b', 'https://a\nb', 'x'.repeat(2049), 5, undefined])
    invalid(() => S.parseParams('git.clone', { ...valid['git.clone'], url }));
  for (const url of ['ssh://git@h/a/b', 'git@github.com:a/b.git'])
    assert.equal(S.parseParams('git.clone', { ...valid['git.clone'], url }).url, url);
  invalid(() => S.parseParams('git.clone', { ...valid['git.clone'], dest: '' }));
  assert.equal(S.parseParams('git.clone', valid['git.clone']).branch, undefined);
  assert.equal(S.parseParams('git.clone', { ...valid['git.clone'], branch: 'feat/x' }).branch, 'feat/x');
  for (const branch of ['', '-x', 'a b', 5]) invalid(() => S.parseParams('git.clone', { ...valid['git.clone'], branch }));
  invalid(() => S.parseParams('git.inspect', { path: '' }));
  invalid(() => S.parseParams('git.inspect', {}));
  assert.doesNotThrow(() => S.requireFeatures('git.inspect', { features: [] }));
  // reading a folder through the Host needs the feature on both ends
  invalid(() => S.parseParams('git.status', { path: '' }));
  assert.throws(
    () => S.requireFeatures('git.status', { features: [] }),
    (e: any) => e.code === 'feature_missing' && e.missing?.includes(S.READ_FEATURE),
  );
  assert.doesNotThrow(() => S.requireFeatures('git.status', { features: [S.READ_FEATURE] }));
  // a search: the query is text (any, even empty or starting with dashes), bounded; the limit a count in range, 50 by default
  assert.deepEqual(S.parseParams('fs.search', { path: '/p', query: '--help', limit: 7 }), { path: '/p', query: '--help', limit: 7 });
  assert.deepEqual(S.parseParams('fs.search', { path: '/p', query: '' }), { path: '/p', query: '', limit: 50 });
  for (const bad of [
    { query: 'a' },
    { path: '/p' },
    { path: '/p', query: 7 },
    { path: '/p', query: 'a\0b' },
    { path: '/p', query: 'x'.repeat(201) },
  ])
    invalid(() => S.parseParams('fs.search', bad));
  for (const limit of [0, 201, 1.5, '5', null]) invalid(() => S.parseParams('fs.search', { path: '/p', query: 'a', limit }));
  assert.throws(
    () => S.requireFeatures('fs.search', { features: [] }),
    (e: any) => e.code === 'feature_missing',
  );
});

test('B1: a worktree request needs a repository and a branch Git could take', () => {
  assert.deepEqual(S.parseParams('git.worktree', { ...valid['git.worktree'], extra: 1 }), { key, repo: '/home/u/b', branch: 'feat/x' });
  for (const branch of ['', '-x', 'a b', 'a\nb', 'x'.repeat(256), 5, undefined])
    invalid(() => S.parseParams('git.worktree', { ...valid['git.worktree'], branch }));
  invalid(() => S.parseParams('git.worktree', { ...valid['git.worktree'], repo: '' }));
  assert.throws(() => S.requireFeatures('git.worktree', { features: [] }), /lacks dedupe/);
});

test('B1: a worktree may name the branch it starts from, which an older Host would drop, so a Host without the branch feature is refused; the branch list and the switch need it too', () => {
  const asked = { ...valid['git.worktree'], from: 'main' };
  assert.deepEqual(S.parseParams('git.worktree', asked), { key, repo: '/home/u/b', branch: 'feat/x', from: 'main' });
  for (const from of ['', '-x', 'a b', 5]) invalid(() => S.parseParams('git.worktree', { ...asked, from }));
  assert.throws(
    () => S.requireFeatures('git.worktree', { features: ['dedupe'] }, S.parseParams('git.worktree', asked)),
    (e: any) => e.code === 'feature_missing' && /gitBranch/.test(e.message),
  );
  S.requireFeatures('git.worktree', { features: ['dedupe'] }, S.parseParams('git.worktree', valid['git.worktree']));
  S.requireFeatures('git.worktree', { features: ['dedupe', 'gitBranch'] }, S.parseParams('git.worktree', asked));
  assert.deepEqual(S.parseParams('host.gitBranches', { path: '/home/u/b', extra: 1 }), { path: '/home/u/b' });
  assert.deepEqual(S.parseParams('host.gitSwitch', { ...valid['host.gitSwitch'], extra: 1 }), { path: '/home/u/b', branch: 'feat/x' });
  for (const branch of ['', '-x', 'a b', 'x'.repeat(256), undefined])
    invalid(() => S.parseParams('host.gitSwitch', { path: '/home/u/b', branch }));
  invalid(() => S.parseParams('host.gitBranches', { path: '' }));
  for (const m of ['host.gitBranches', 'host.gitSwitch']) assert.throws(() => S.requireFeatures(m, { features: [] }), /lacks gitBranch/);
});

test('B3: an older peer that omits the optional fields still parses; extra fields are dropped', () => {
  const start = S.parseParams('chat.start', valid['chat.start']);
  assert.deepEqual(Object.keys(start).sort(), [
    'attachments',
    'chatId',
    'effort',
    'epoch',
    'harness',
    'key',
    'model',
    'projectId',
    'skills',
    'text',
  ]);
  const full = S.parseParams('chat.start', { ...valid['chat.start'], cwd: '/w', permission: 'auto', model: 'm', future: 1 });
  assert.equal(full.cwd, '/w');
  assert.equal(full.permission, 'auto');
  assert.equal('future' in full, false);
  assert.deepEqual(S.parseParams('chat.stop', { ...valid['chat.stop'], turnId: 7, extra: 1 }), { ...scope, key, turnId: '7' });
  assert.deepEqual(S.parseParams('chat.stop', valid['chat.stop']), { ...scope, key });
  assert.deepEqual(S.parseParams('fs.list', { path: '/a', hidden: 1 }), { path: '/a', hidden: false });
  assert.deepEqual(S.parseParams('host.hello', { protocol: { minor: 2, floor: 1 } }).features, []);
  assert.deepEqual(S.parseParams('host.hello', { ...valid['host.hello'], features: ['epoch', 'epoch', 'later'] }).features, [
    'epoch',
    'later',
  ]);
});

test('B1: a hello with a bad version or feature list is refused', () => {
  for (const protocol of [undefined, { minor: 1 }, { minor: 1, floor: 2 }, { minor: -1, floor: 0 }, { minor: '1', floor: 1 }])
    invalid(() => S.parseParams('host.hello', { protocol, features: [] }));
  for (const features of ['epoch', [1], ['Bad Name'], Array.from({ length: 65 }, (_, i) => `f${i}`)])
    invalid(() => S.parseParams('host.hello', { ...valid['host.hello'], features }));
});

test('versions: the lower minor wins, a floor above the other minor refuses, features intersect', () => {
  const mine = S.helloParams();
  const theirs = { protocol: { minor: 3, floor: 1 }, features: ['epoch', 'lanes', 'extra'] };
  assert.deepEqual(S.negotiate(mine, theirs), { minor: 1, features: ['epoch', 'lanes'] });
  assert.throws(
    () => S.negotiate(mine, { protocol: { minor: 0, floor: 0 }, features: [] }),
    (e: any) => e.code === 'version_refused',
  );
  assert.throws(
    () => S.negotiate({ ...mine, protocol: { minor: 1, floor: 1 } }, { protocol: { minor: 5, floor: 2 }, features: [] }),
    (e: any) => e.code === 'version_refused',
  );
});

test('gates: a method missing a safety feature is refused, not downgraded; read methods need none', () => {
  const all = { features: [...S.FEATURES] };
  for (const m of Object.keys(S.REQUIRES)) S.requireFeatures(m, all);
  S.requireFeatures('host.status', { features: [] });
  S.requireFeatures('fs.list', { features: [] });
  for (const m of ['chat.start', 'chat.send', 'chat.stop', 'chat.permit', 'chat.subscribe'])
    assert.throws(
      () => S.requireFeatures(m, { features: ['dedupe', 'isolation', 'lanes'] }),
      (e: any) => e instanceof S.GateError && e.code === 'feature_missing' && e.missing.includes('epoch'),
    );
  assert.throws(
    () => S.requireFeatures('chat.start', { features: ['epoch', 'dedupe'] }),
    (e: any) => e.missing.join() === 'isolation',
  );
  assert.throws(() => S.requireFeatures('git.clone', { features: [] }), /lacks dedupe/);
});

test('B8: the wire has no field that names a tool server, so no host id or nonce reaches a name the model sees', () => {
  const start = S.parseParams('chat.start', {
    ...valid['chat.start'],
    serverName: 'mopilot-host-9',
    toolServer: 'x',
    hostId: 'h1',
    nonce: 'n',
  });
  for (const f of ['serverName', 'toolServer', 'hostId', 'nonce']) assert.equal(f in start, false);
  assert.deepEqual(
    S.parseParams('chat.start', valid['chat.start']),
    S.parseParams('chat.start', { ...valid['chat.start'], hostId: 'other' }),
  );
});

test('B1: an answer names its card and, unless the card was dismissed, the option picked', () => {
  const answer = valid['chat.answer'];
  const { optionId: _dismissed, ...dismissed } = answer;
  assert.equal(S.parseParams('chat.answer', dismissed).optionId, undefined);
  assert.equal(S.parseParams('chat.answer', answer).optionId, 'allow');
  for (const bad of [{ requestId: undefined }, { requestId: '' }, { requestId: 7 }, { optionId: '' }, { optionId: 'x'.repeat(201) }])
    invalid(() => S.parseParams('chat.answer', { ...answer, ...bad }));
});

test('B1: a resume point names the numbering its revision was counted in, or none', () => {
  const sub = { chatId: 'claude:abc', epoch: 1, fromRev: 4 };
  assert.equal(S.parseParams('chat.subscribe', sub).generation, undefined);
  assert.equal(S.parseParams('chat.subscribe', { ...sub, generation: 'f3a9-2' }).generation, 'f3a9-2');
  for (const bad of [7, '', 'has space', 'x'.repeat(129)]) invalid(() => S.parseParams('chat.subscribe', { ...sub, generation: bad }));
});

test("B1: a message may carry the chat's folder, which must be a path", () => {
  assert.equal(S.parseParams('chat.send', { ...send, cwd: '/home/u/a' }).cwd, '/home/u/a');
  assert.equal(S.parseParams('chat.send', send).cwd, undefined);
  invalid(() => S.parseParams('chat.send', { ...send, cwd: '' }));
});

test('chat input refuses unsupported file and skill paths rather than silently dropping them', () => {
  for (const method of ['chat.start', 'chat.send']) {
    for (const field of ['attachments', 'skills']) {
      assert.throws(
        () => S.parseParams(method, { ...valid[method], [field]: ['/only-on-the-client'] }),
        /Files other than images and local skills/,
      );
      assert.equal(S.parseParams(method, { ...valid[method], [field]: [] }).text, valid[method].text.trim());
    }
  }
});

test('host.relayEnroll may name the client it is for, and refuses a client that is not a fingerprint', () => {
  const base = valid['host.relayEnroll'];
  assert.equal(S.parseParams('host.relayEnroll', { ...base, client: 'a'.repeat(64) }).client, 'a'.repeat(64));
  assert.equal('client' in S.parseParams('host.relayEnroll', base), false);
  assert.throws(() => S.parseParams('host.relayEnroll', { ...base, client: 'nope' }));
});

test('MoMo’s settings and notification buttons: the brief switch, time and zone, the previews and the daily cap, and the typed answer of a notification, are checked field by field', () => {
  const ok = (m: string, p: object) => S.parseParams(m, p);
  assert.deepEqual(
    ok('host.momoPrefs', { brief: { on: true, time: '07:30', zone: 'Asia/Tokyo' }, notify: { previews: true, tellNowMax: 4 } }),
    {
      brief: { on: true, time: '07:30', zone: 'Asia/Tokyo' },
      notify: { previews: true, tellNowMax: 4 },
    },
  );
  assert.deepEqual(ok('host.momoPrefs', { brief: {}, notify: {} }), { brief: {}, notify: {} });
  for (const bad of [
    { brief: { on: 'yes' } },
    { brief: { time: '25:00' } },
    { brief: { zone: 'Mars/Olympus' } },
    { brief: { zone: 5 } },
    { notify: { previews: 'on' } },
    { notify: { tellNowMax: 0 } },
    { notify: { tellNowMax: 51 } },
    { notify: { tellNowMax: 2.5 } },
  ])
    invalid(() => S.parseParams('host.momoPrefs', bad));
  assert.deepEqual(ok('host.momoIntent', { key: 'dana-1', action: 'remind', at: 1_800_000_000_000 }), {
    key: 'dana-1',
    action: 'remind',
    at: 1_800_000_000_000,
  });
  assert.deepEqual(ok('host.momoIntent', { key: 'dana-1', action: 'draft' }), { key: 'dana-1', action: 'draft' });
  for (const bad of [
    { key: 'dana-1', action: 'approve' },
    { key: '', action: 'draft' },
    { key: 'a b', action: 'draft' },
    { key: 'dana-1', action: 'draft', at: 5 },
    { key: 'dana-1', action: 'remind', at: 0 },
    { key: 'dana-1', action: 'remind', at: 'tomorrow' },
  ])
    invalid(() => S.parseParams('host.momoIntent', bad));
  assert.deepEqual(ok('host.momoBriefNow', {}), {});
});
