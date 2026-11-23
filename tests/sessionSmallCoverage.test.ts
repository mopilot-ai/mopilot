// electron/session caps, goalHeld and state: sparse model and provider entries, account matching,
// missing prefs and kill-switch callbacks, held goals without optional fields, and store edge cases.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { CapsService, flagsFor, codexModelInfo, claudeModelInfo, providerProfile } = require('../electron/session/caps.cjs');
const { heldOf, restoreGoal } = require('../electron/session/goalHeld.cjs');
const { SessionStore } = require('../electron/session/state.cjs');

/* caps */

test('the account a chat runs on, named as its instance is: Claude’s own pick or the active login, Codex’s pin or the active account', () => {
  const refs: Record<string, any> = {
    cl: { kind: 'claude', key: 'claude:s' },
    cx: { kind: 'codex', key: 't1' },
    acp: { kind: 'acp:goose', key: 'g' },
  };
  const instances: Record<string, any[]> = {
    claude: [
      { account: 'default', label: 'me@x.com', active: true },
      { account: 'meg', label: 'meg@x.com', active: false },
    ],
    codex: [{ account: 'default', label: 'cx@x.com', active: true }],
  };
  const pins: Record<string, any> = { t1: null };
  let picked: string | null = 'meg';
  const caps = (o: any = {}) =>
    new CapsService({
      ref: (id: string) => refs[id] ?? null,
      instances: (h: string) => instances[h] ?? [],
      chatInstance: (_h: string, key: string) => pins[key],
      claudeLogin: () => picked,
      ...o,
    });
  const s = caps();
  // the chat moved to another login: it says that one
  assert.equal(s.accountLabel('cl'), 'meg@x.com');
  picked = null;
  assert.equal(s.accountLabel('cl'), 'me@x.com');
  // a pick no longer listed: the active login
  picked = 'gone';
  assert.equal(s.accountLabel('cl'), 'me@x.com');
  assert.equal(s.accountLabel('cx'), 'cx@x.com');
  pins.t1 = { label: 'pinned@x.com' };
  assert.equal(s.accountLabel('cx'), 'pinned@x.com');
  // no relay pins to read: the active account
  assert.equal(caps({ chatInstance: undefined }).accountLabel('cx'), 'cx@x.com');
  // a basic harness, a chat main doesn't know, or no account at all: none named
  assert.equal(s.accountLabel('acp'), null);
  assert.equal(s.accountLabel('nope'), null);
  instances.claude = [];
  assert.equal(caps({ claudeLogin: undefined }).accountLabel('cl'), null);
});

test('flagsFor keeps only boolean harness flags', () => {
  assert.deepEqual(
    flagsFor(() => true, { 'features.a': true, 'features.b': 'yes', 'features.c': false }, 'codex'),
    { 'features.a': true, 'features.c': false },
  );
  assert.deepEqual(
    flagsFor(() => true, undefined, null),
    {},
  );
});

test('model info from sparse Codex and Claude entries', () => {
  assert.deepEqual(codexModelInfo({ id: 'm1', supportedReasoningEfforts: ['low', { reasoningEffort: 'ultra' }] }), {
    id: 'm1',
    label: undefined,
    input: 'unknown',
    efforts: ['low', 'ultra'],
    ultra: true,
    serviceTiers: [],
  });
  assert.deepEqual(codexModelInfo({ model: 'm2', serviceTiers: [{ id: 'default' }, { id: 'flex' }, {}] }), {
    id: 'm2',
    label: 'm2',
    input: 'unknown',
    efforts: [],
    ultra: false,
    serviceTiers: ['flex'],
  });
  assert.deepEqual(claudeModelInfo({ value: 'sonnet' }, { available: false }), {
    id: 'sonnet',
    label: 'sonnet',
    input: 'unknown',
    efforts: [],
    ultra: false,
    serviceTiers: [],
  });
});

test('provider profile: a third party without wires or base URL cannot do speed', () => {
  assert.equal(providerProfile(null), null);
  assert.deepEqual(providerProfile({ provider: { id: 'x' } }, null, null), {
    id: 'x',
    wires: [],
    baseUrl: '',
    firstParty: false,
    models: [],
    drops: ['speed'],
    visionFallbackModel: null,
  });
});

const caps = (o: any = {}) =>
  new CapsService({
    ref: (id: string) => o.chats?.[id] ?? null,
    record: () => o.record ?? null,
    session: () => o.session ?? null,
    isEnabled: o.isEnabled,
    codex: async () => o.codex ?? null,
    claude: { version: () => '2', probeInfo: (acct: any) => (o.probed?.push(acct), o.probe ?? null), appliedOf: () => null },
    instances: (h: string) => o.instances?.[h] ?? [],
    chatInstance: o.chatInstance,
    claudeLogin: o.claudeLogin,
    prefs: () => o.prefs,
    accounts: o.accounts,
  });

test('caps: no harness known gives nothing; a new chat without prefs, instances or a kill-switch callback still resolves', async () => {
  assert.equal(await caps().get(null), null);
  const r = await caps().get(null, { kind: 'codex' });
  assert.equal(r.kind, 'codex');
  assert.equal(r.provider, null);
  assert.equal(r.caps.goal.via, 'rpc');
  const c = await caps().get(null, { kind: 'claude' });
  assert.equal(c.tier, 'first');
  assert.equal(c.provider, null);
});

test("caps: the chat's own account picks its instance; a key instance probes without an account", async () => {
  const anthropic = { id: 'anthropic', firstParty: true };
  const probed: any[] = [];
  const o = {
    chats: { c: { kind: 'claude', key: '' } },
    // the login the chat runs on (ClaudeAdapter.pickedLogin)
    claudeLogin: (chatId: string) => (chatId === 'c' ? 'k' : null),
    record: { meta: {}, segments: [] },
    probed,
    probe: { models: [{ value: 'sonnet', displayName: 'Sonnet' }] },
    prefs: { claudeSelection: { model: 'sonnet[1m]' } },
    instances: {
      claude: [
        { account: 'other', active: true, provider: anthropic },
        { account: 'k', kind: 'sageKey', billing: 'key', provider: anthropic },
      ],
    },
  };
  const r = await caps(o).get('c');
  assert.deepEqual(probed, [undefined]);
  assert.deepEqual(r.provider, { id: 'anthropic', label: 'anthropic', firstParty: true, visionFallbackModel: null });
  assert.equal(r.caps.speed.state !== undefined, true);

  // an account with no instance of its own falls back to the active one; none at all means no provider
  probed.length = 0;
  const fallback = await caps({ ...o, claudeLogin: () => 'gone' }).get('c');
  assert.deepEqual(probed, ['other']);
  assert.equal(fallback.provider.id, 'anthropic');
  const none = await caps({ ...o, instances: { claude: [{ account: 'x', active: false }] } }).get('c');
  assert.equal(none.provider, null);
});

test("caps: Codex reads the chat's relay pin, else the active account, never Claude's saved login", async () => {
  const openai = (label: string) => ({ id: 'openai', label, firstParty: true });
  const o: any = {
    chats: { c: { kind: 'codex', key: 't' } },
    // a Claude segment's login, saved in the same file: not a Codex account
    record: { meta: { account: { id: 'b', pinned: true } }, segments: [] },
    codex: { version: '1', models: [{ model: 'gpt', isDefault: true }], negotiated: {} },
    instances: {
      codex: [
        { account: 'a', active: true, provider: openai('A') },
        { account: 'b', provider: openai('B') },
      ],
    },
  };
  assert.equal((await caps(o).get('c')).provider.label, 'A');
  const pinned = await caps({
    ...o,
    chatInstance: (_h: string, key: string) => o.instances.codex.find((i: any) => key === 't' && i.account === 'b'),
  });
  assert.equal((await pinned.get('c')).provider.label, 'B');
  assert.equal((await caps({ ...o, instances: { codex: [{ account: 'z' }] } }).get('c')).provider, null);
});

test('caps: a basic harness without an account lane, and another app running a chat main has no session for', async () => {
  const r = await caps({ chats: { c: { kind: 'acp:kimi' } } }).get('c', { elsewhere: true });
  assert.equal(r.tier, 'basic');
  const lanes: string[] = [];
  const s = await caps({ accounts: (h: string) => (lanes.push(h), null) }).get(null, { kind: 'acp:kimi', elsewhere: true });
  assert.equal(s.kind, 'acp:kimi');
  assert.deepEqual(lanes, ['acp']);
  // a kill-switch callback that turns everything off reaches the gate
  const off = await caps({ isEnabled: () => false }).get(null, { kind: 'codex' });
  assert.equal(off.caps.computerUse.via, 'none');
});

/* goalHeld */

test('heldOf: only paused or limited goals with a condition; optional fields default to null', () => {
  assert.equal(heldOf(null), null);
  assert.equal(heldOf({ status: 'active', objective: 'x' }), null);
  assert.equal(heldOf({ status: 'paused' }), null);
  assert.equal(heldOf({ status: 'paused', objective: '  ' }), null);
  assert.deepEqual(heldOf({ status: 'budgetLimited', objective: ' ship ' }), {
    objective: 'ship',
    status: 'budgetLimited',
    limit: null,
    at: null,
  });
  assert.deepEqual(heldOf({ status: 'paused', objective: 'x', claude: {}, updatedAt: 3 }), {
    objective: 'x',
    status: 'paused',
    limit: null,
    at: 3,
  });
});

test('restoreGoal: unusable records give null; a record without time or limit uses now', () => {
  assert.equal(restoreGoal(null, 'c'), null);
  assert.equal(restoreGoal({ objective: 5 }, 'c'), null);
  const g = restoreGoal({ objective: ' x ' }, 'c', 100);
  assert.equal(g.createdAt, 100);
  assert.equal(g.updatedAt, 100);
  assert.equal(g.claude.limit, null);
  const before = Date.now() / 1000;
  assert.ok(restoreGoal({ objective: 'y', at: 1, limit: 30 }, 'c').updatedAt >= before);
});

/* state */

test('SessionStore: bad ids and partials are ignored, rev and unknown keys are skipped, undefined clears, a default publisher', () => {
  const s = new SessionStore();
  assert.equal(s.patch('', { plan: true }), false);
  assert.equal(s.patch(1, { plan: true }), false);
  assert.equal(s.patch('c', null), false);
  assert.equal(s.patch('c', 'x'), false);
  assert.equal(s.patch('c', { rev: 9, nope: 1 }), false);
  assert.equal(s.patch('c', { permission: 'ask' }), true);
  assert.equal(s.patch('c', { permission: undefined }), true);
  assert.equal(s.get('c').permission, null);
  assert.equal(s.get('c').rev, 2);
  assert.equal(s.clientPatch('c', null), false);
  assert.equal(s.clientPatch('c', 'x'), false);
});
