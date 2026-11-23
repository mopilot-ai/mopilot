// The account switching contract (shared/switch.mjs), Codex's pool fixes (electron/identity/codexAccounts.cjs) and
// switch notes kept in the chat's v2 file (src/lib/chatMeta.ts). Data is made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { onUnavailable, sameLane, payPerUseText, switchNoteText, type LaneInstance } from '../shared/switch.mjs';
import { applyChat, chatChanges, mapsFromSnapshot, withChatNotes } from '../src/lib/chatMeta.ts';
import { fakeSafe } from './support/computerHistory.ts';
import { sealedAuth } from './support/sealedAuth.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sage-switching-'));
const codexHome = path.join(tmp, 'codex');
fs.mkdirSync(codexHome, { recursive: true });
process.env.CODEX_HOME = codexHome;
process.env.SAGE_NO_RELAY = '1';
const req = createRequire(import.meta.url);
const { Accounts } = req('../electron/identity/codexAccounts.cjs');
const policy = req('../electron/identity/contract/switch.cjs');

const sub = (id: string, extra = {}): LaneInstance => ({
  id,
  provider: 'anthropic',
  billing: 'subscription' as const,
  status: 'ok',
  ...extra,
});
const key: LaneInstance = { id: 'apiKey', provider: 'anthropic', billing: 'apiKey' as const, status: 'ok' };
const credits: LaneInstance = { id: 'mopilot', provider: 'mopilot', billing: 'credits' as const, status: 'ok' };

/* ---------- the contract ---------- */
test('a subscription moves on its own only to another subscription of the same provider', () => {
  const d = onUnavailable({ from: sub('a'), candidates: [key, credits, sub('b')] });
  assert.equal(d.action, 'switch');
  assert.equal((d as any).to.id, 'b');
});

test('subscription to pay-per-use always asks, even on the same provider', () => {
  const d = onUnavailable({ from: sub('a'), candidates: [sub('b', { limited: true }), sub('c', { status: 'signedOut' }), key, credits] });
  assert.deepEqual([d.action, (d as any).to.id], ['confirm', 'apiKey']);
  assert.equal(
    payPerUseText('Anthropic'),
    "Your subscription limit is reached. Continue with your Anthropic API key? You'll pay per use from here.",
  );
});

test('another provider is only offered, never switched to', () => {
  const d = onUnavailable({ from: sub('a'), candidates: [credits] });
  assert.deepEqual([d.action, (d as any).to.id], ['offer', 'mopilot']);
  assert.equal(onUnavailable({ from: sub('a'), candidates: [] }).action, 'none');
});

test('auto-switch off keeps the account; a temporary chat keeps it whatever is available', () => {
  assert.equal(onUnavailable({ from: sub('a'), candidates: [sub('b')], autoSwitch: false }).action, 'none');
  assert.equal(onUnavailable({ from: sub('a'), candidates: [sub('b'), key], ephemeral: true }).action, 'none');
});

test('a key moves only to another key of its provider, never back to a subscription on its own', () => {
  const k2 = { ...key, id: 'k2' };
  assert.equal((onUnavailable({ from: key, candidates: [sub('a'), k2] }) as any).to.id, 'k2');
  assert.notEqual(onUnavailable({ from: key, candidates: [sub('a')] }).action, 'switch');
});

test('accounts share a lane only with their own provider and billing', () => {
  assert.equal(sameLane(sub('a'), sub('b')), true);
  assert.equal(sameLane(sub('a'), key), false);
  assert.equal(sameLane(sub('a'), credits), false);
  assert.equal(sameLane(sub('a'), { ...sub('b'), provider: 'openai' }), false);
  // main reads the same rules
  assert.equal(policy.sameLane, sameLane);
});

test('switch notes', () => {
  assert.equal(
    switchNoteText({ reason: 'limit', from: 'a@x.com', to: 'b@x.com', plan: 'Max', carried: true }),
    'Max limit reached on a@x.com. Continued on b@x.com · Goal and plan mode carried over',
  );
  assert.equal(
    switchNoteText({ reason: 'expired', from: 'a@x.com', to: 'b@x.com' }),
    'a@x.com needs to sign in again. Continued on b@x.com',
  );
  assert.equal(switchNoteText({ reason: 'limit', to: 'b@x.com' }), 'Usage limit reached. Continued on b@x.com');
});

/* ---------- Codex pool ---------- */
const jwt = (claims: object) => `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.x`;
function chatgptAuth(home: string, email: string, accountId: string) {
  fs.mkdirSync(home, { recursive: true });
  const auth = { 'https://api.openai.com/auth': { chatgpt_account_id: accountId, chatgpt_plan_type: 'plus' } };
  fs.writeFileSync(
    path.join(home, 'auth.json'),
    JSON.stringify({ tokens: { access_token: jwt({ ...auth, exp: 4e9 }), id_token: jwt({ ...auth, email }), account_id: accountId } }),
  );
}
function keyHome(home: string, k: string) {
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: k }));
}
let n = 0;
function pool(state: object, setup: (ud: string) => void = () => {}, extra: object = {}) {
  const userData = path.join(tmp, `ud-${n++}`);
  fs.mkdirSync(userData, { recursive: true });
  setup(userData);
  fs.writeFileSync(path.join(userData, 'accounts.json'), JSON.stringify(state));
  const sent: any[] = [];
  const server = { intercepts: new Set(), listeners: new Set(), send: (m: any) => sent.push(m) };
  const a = new Accounts({
    userData,
    server,
    findBin: () => 'codex',
    clientInfo: {},
    safeStorage: fakeSafe(),
    broadcast: () => {},
    openExternal: () => {},
    ...extra,
  });
  return { a, sent, userData };
}
const mopilot = { id: 'mopilot', kind: 'apiKey', mopilot: true, baseUrl: 'http://127.0.0.1:9/v1', status: 'ok' };
chatgptAuth(codexHome, 'a@example.com', 'acct-a');

test('one ChatGPT login plus MoPilot is still a single-account pool (D-70)', async () => {
  const { a, sent } = pool({ active: 'default', accounts: [mopilot] });
  try {
    assert.equal(a.subscriptions().length, 1);
    // pass-through, no per-chat routing
    assert.equal(a.pickFor('t1', new Set()), null);
    // the CLI's own login keeps the app-server's own auth handling: nothing is pushed to it
    await a.apply();
    assert.equal(sent.length, 0);
  } finally {
    a.dispose();
  }
});

test('MoPilot is never fallen back to as the active account (D-71)', () => {
  const { a } = pool({ active: 'gone', accounts: [mopilot] }, () => {});
  try {
    assert.equal(a.active()?.id, 'default');
  } finally {
    a.dispose();
  }
  fs.rmSync(path.join(codexHome, 'auth.json'));
  const only = pool({ active: 'default', accounts: [mopilot] });
  try {
    // no ChatGPT login at all: nothing is active until the user picks credits
    assert.equal(only.a.active(), null);
    assert.equal(only.a.view().active, null);
  } finally {
    only.a.dispose();
    chatgptAuth(codexHome, 'a@example.com', 'acct-a');
  }
});

test('failover candidates are subscriptions only; an API key is never switched to on its own', () => {
  const { a } = pool(
    {
      active: 'default',
      accounts: [
        {
          id: 'b',
          kind: 'chatgpt',
          email: 'b@example.com',
          chatgptAccountId: 'acct-b',
          status: 'ok',
          limits: { used: 10, reached: false },
        },
        { id: 'k', kind: 'apiKey', baseUrl: null, status: 'ok' },
        mopilot,
      ],
    },
    (ud) => chatgptAuth(path.join(ud, 'accounts', 'b'), 'b@example.com', 'acct-b'),
  );
  try {
    assert.deepEqual(
      a.candidates(a.active()).map((x: any) => x.id),
      ['b'],
    );
    assert.deepEqual(
      a.candidates(a.get('k')).map((x: any) => x.id),
      [],
    );
  } finally {
    a.dispose();
  }
});

test('a chat pinned to an API key is routed with that key, not moved (D-64)', () => {
  const { a } = pool(
    {
      active: 'default',
      accounts: [
        { id: 'b', kind: 'chatgpt', email: 'b@example.com', chatgptAccountId: 'acct-b', status: 'ok' },
        { id: 'k', kind: 'apiKey', baseUrl: 'https://gw.example.test/v1', status: 'ok' },
      ],
      chatPins: { t1: 'k' },
    },
    (ud) => {
      chatgptAuth(path.join(ud, 'accounts', 'b'), 'b@example.com', 'acct-b');
      keyHome(path.join(ud, 'accounts', 'k'), 'sk-test-1');
    },
  );
  try {
    assert.deepEqual(a.keyRoute('t1'), { base: 'https://gw.example.test/v1', key: 'sk-test-1' });
    assert.equal(a.keyRoute('t2'), null);
    assert.equal(a.state.chatPins.t1, 'k');
    assert.equal(a.unavailableReason({ status: 'ok', limits: null }), 'unavailable');
    assert.equal(a.unavailableReason({ status: 'expired' }), 'expired');
  } finally {
    a.dispose();
  }
});

test('a temporary chat stays on its account when it runs out', () => {
  const { a } = pool(
    { active: 'default', accounts: [{ id: 'b', kind: 'chatgpt', email: 'b@example.com', chatgptAccountId: 'acct-b', status: 'ok' }] },
    (ud) => chatgptAuth(path.join(ud, 'accounts', 'b'), 'b@example.com', 'acct-b'),
  );
  try {
    a.onMainMessage({ method: 'thread/started', params: { thread: { id: 'tmp', ephemeral: true } } });
    const first = a.pickFor('tmp', new Set());
    a.markLimited(first);
    assert.equal(a.pickFor('tmp', new Set()), first);
    assert.equal(a.pickFor('tmp', new Set([first.id])), undefined);
    // an ordinary chat moves
    const other = a.pickFor('t2', new Set());
    assert.notEqual(a.pickFor('t2', new Set([other.id])), other);
  } finally {
    a.dispose();
  }
});

test('Replace key updates the key in use instead of adding a row (D-33)', async () => {
  const { a } = pool({ active: 'k', accounts: [{ id: 'k', kind: 'apiKey', baseUrl: null, status: 'ok' }] }, (ud) =>
    keyHome(path.join(ud, 'accounts', 'k'), 'sk-old'),
  );
  a.mainRequest = async () => ({});
  try {
    await a.addApiKey('sk-new', 'http://127.0.0.1:9/v1', 'k');
    assert.deepEqual(
      a.state.accounts.map((x: any) => x.id),
      ['default', 'k'],
    );
    assert.equal(a.keyRoute('none'), null);
    assert.equal(sealedAuth(a.home(a.get('k'))).OPENAI_API_KEY, 'sk-new');
    assert.equal(a.get('k').baseUrl, 'http://127.0.0.1:9/v1');
  } finally {
    a.dispose();
  }
});

test("logging in a gateway key leaves the CLI's auth.json as it was, or absent (D-72)", async () => {
  const file = path.join(codexHome, 'auth.json');
  const saved = fs.existsSync(file) ? fs.readFileSync(file) : null;
  const { a } = pool({ active: 'mopilot', accounts: [mopilot] }, (ud) =>
    keyHome(path.join(ud, 'accounts', 'mopilot'), 'mpk_test_key_0000000000'),
  );
  // what the app-server does with an API-key login when it keeps credentials in a file
  a.mainRequest = async (_m: string, p: any) => void fs.writeFileSync(file, JSON.stringify({ OPENAI_API_KEY: p.apiKey }));
  try {
    // the user's own OpenAI key stays
    fs.writeFileSync(file, JSON.stringify({ OPENAI_API_KEY: 'sk-own' }));
    await a.apply();
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).OPENAI_API_KEY, 'sk-own');
    // no CLI login at all: no file afterwards
    fs.rmSync(file);
    a.applied = null;
    await a.apply();
    assert.equal(fs.existsSync(file), false);
  } finally {
    a.dispose();
    if (saved) fs.writeFileSync(file, saved);
    else fs.rmSync(file, { force: true });
  }
});

test('signing out of MoPilot with nothing else to fall back to logs the app-server out (D-73)', async () => {
  const file = path.join(codexHome, 'auth.json');
  const saved = fs.existsSync(file) ? fs.readFileSync(file) : null;
  fs.rmSync(file, { force: true });
  const notes: any[] = [];
  const { a } = pool({ active: 'mopilot', accounts: [mopilot] }, (ud) =>
    keyHome(path.join(ud, 'accounts', 'mopilot'), 'mpk_test_key_0000000000'),
  );
  const sent: string[] = [];
  a.mainRequest = async (m: string) => void sent.push(m);
  a.notice = (n: any) => notes.push(n);
  try {
    await a.setMoPilotKey(null);
    assert.ok(sent.includes('account/logout'));
    assert.equal(a.get('mopilot'), null);
    assert.deepEqual(
      notes.map((n) => n.kind),
      ['mopilotSignedOut'],
    );
  } finally {
    a.dispose();
    if (saved) fs.writeFileSync(file, saved);
  }
});

/* ---------- notes in the v2 file ---------- */
test('switch notes travel as the chat meta "notes" and come back after a reload', () => {
  const note = { id: 'account-1', kind: 'account' as const, text: 'Max limit reached. Continued on b@x.com', turnId: 't2', turn: 1, at: 1 };
  const prev = mapsFromSnapshot({ chats: {}, newer: [] });
  const next = { ...prev, chatNotes: { c: [note] } };
  // the window sends the note it added; main appends it to the chat's own (electron/platform/windowMetaPatch.cjs)
  assert.deepEqual(chatChanges(prev, next).meta, { c: { notesAdded: [note] } });
  const back = applyChat(prev, 'c', { segments: null, meta: { notes: [note] } as any });
  assert.deepEqual(back.chatNotes.c, [note]);

  const turns = [
    { id: 't1', items: [] },
    { id: 't2', items: [{ id: 'x' }] },
  ];
  const shown = withChatNotes(turns, [note]);
  assert.deepEqual(
    shown[1].items.map((i: any) => i.id),
    ['x', 'account-1'],
  );
  // already shown (live): not added twice; no notes: the same array
  assert.equal(withChatNotes(shown, [note])[1].items.length, 2);
  assert.equal(withChatNotes(turns, undefined), turns);
  // a turn id that isn't there any more: falls back to the index
  assert.deepEqual(
    withChatNotes(turns, [{ ...note, turnId: 'gone', turn: 0 }])[0].items.map((i: any) => i.id),
    ['account-1'],
  );
});

test('removing an account forgets its provider key; the relay no longer hides the provider input', async () => {
  const forgotten: string[] = [];
  const { a } = pool({ active: 'default', accounts: [mopilot] }, () => {}, {
    forgetProvider: async (id: string) => void forgotten.push(id),
  });
  try {
    a.relay = {};
    a.state.active = 'mopilot';
    keyHome(a.home(mopilot), 'sk-test-x');
    assert.equal(a.providerInput()?.account, 'mopilot');
    a.state.active = 'default';
    a.sidecar = () => ({ call: async () => ({}) });
    await a.remove('mopilot');
    assert.deepEqual(forgotten, ['mopilot']);
    assert.equal(a.get('mopilot'), null);
  } finally {
    a.relay = null;
    a.dispose();
  }
});

test('a sidecar whose binary is missing fails at once and is replaced on next use', async () => {
  const { a } = pool({ active: 'default', accounts: [] }, () => {}, { findBin: () => path.join(tmp, 'no-such-codex') });
  try {
    const t0 = Date.now();
    const sc = a.sidecar(a.active());
    await assert.rejects(sc.call('account/read', {}), /Codex exited/);
    await sc.close();
    assert.ok(Date.now() - t0 < 5000);
    assert.notEqual(a.sidecar(a.active()), sc);
    // sign-in doesn't hang on the dead sidecar either
    await assert.rejects(a.startLogin(), /Codex exited/);
  } finally {
    a.dispose();
  }
});

test("overlapping apply() calls run one at a time and leave the CLI's auth.json as it was (D-72)", async () => {
  const file = path.join(codexHome, 'auth.json');
  const saved = fs.existsSync(file) ? fs.readFileSync(file) : null;
  const { a } = pool({ active: 'mopilot', accounts: [mopilot] }, (ud) =>
    keyHome(path.join(ud, 'accounts', 'mopilot'), 'mpk_test_key_0000000000'),
  );
  // the app-server writes the key to auth.json at once and answers a little later
  a.mainRequest = async (_m: string, p: any) => {
    fs.writeFileSync(file, JSON.stringify({ OPENAI_API_KEY: p.apiKey }));
    await new Promise((r) => setTimeout(r, 20));
  };
  try {
    fs.writeFileSync(file, JSON.stringify({ OPENAI_API_KEY: 'sk-own' }));
    await Promise.all([a.apply(), a.apply()]);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).OPENAI_API_KEY, 'sk-own');
  } finally {
    a.dispose();
    if (saved) fs.writeFileSync(file, saved);
    else fs.rmSync(file, { force: true });
  }
});

/* ---------- a turn that hits its usage limit ---------- */
function limitPool(chatPins: Record<string, string> = {}) {
  const accounts = ['b', 'c'].map((id, i) => ({
    id,
    kind: 'chatgpt',
    email: `${id}@example.com`,
    chatgptAccountId: `acct-${id}`,
    status: 'ok',
    limits: { used: 10 * (i + 1), reached: false },
  }));
  const p = pool({ active: 'default', autoSwitch: true, pool: 'spread', accounts, chatPins }, (ud) => {
    for (const { id } of accounts) chatgptAuth(path.join(ud, 'accounts', id), `${id}@example.com`, `acct-${id}`);
  });
  const notices: any[] = [];
  const switched: string[] = [];
  const failing = new Set<string>();
  p.a.notice = (n: any) => notices.push(n);
  p.a.refreshUsage = async () => {};
  p.a.switchTo = async (id: string) => {
    switched.push(id);
    if (failing.has(id)) throw new Error(`token refresh failed for ${id}`);
  };
  return { ...p, notices, switched, failing };
}

test('a usage limit moves the chat to the next account that switches, skipping one that fails', async () => {
  const { a, notices, switched, failing } = limitPool();
  failing.add('b');
  try {
    await a.onTurnLimit('t1');
    assert.deepEqual(switched, ['b', 'c']);
    assert.deepEqual(notices, [{ kind: 'resume', threadId: 't1', from: 'a@example.com', to: 'c@example.com' }]);
    assert.equal(a.pins.get('t1').id, 'c');
  } finally {
    a.dispose();
  }
});

test('a usage limit with no account that switches never announces a move: the chat stays, and the pool is exhausted', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { a, notices, switched, failing } = limitPool({ t1: 'default' });
  failing.add('b').add('c');
  try {
    const before = a.pins.get('t1');
    await a.onTurnLimit('t1');
    assert.deepEqual(switched, ['b', 'c']);
    assert.deepEqual(notices, [{ kind: 'exhausted' }]);
    assert.equal(a.pins.get('t1'), before, 'the pin the chat had is kept');
    assert.equal(a.resumes.get('t1'), undefined, 'a failed move does not count against the continue cap');
  } finally {
    a.dispose();
  }
  // an unpinned chat is left unpinned; a call without a chat pins nothing
  const other = limitPool();
  other.failing.add('b').add('c');
  try {
    await other.a.onTurnLimit('t2');
    assert.equal(other.a.pins.has('t2'), false);
    await other.a.onTurnLimit(null);
    assert.deepEqual(other.switched, ['b', 'c', 'b', 'c']);
    assert.deepEqual(other.notices, [{ kind: 'exhausted' }], 'the exhausted notice is not repeated');
    assert.equal(other.a.pins.size, 0);
  } finally {
    other.a.dispose();
  }
});

test('behind the relay a spread pool re-homes the chat by its pin without switching the app-server', async () => {
  const { a, notices, switched } = limitPool();
  a.relay = {};
  try {
    await a.onTurnLimit('t1');
    assert.deepEqual(switched, []);
    assert.equal(a.pins.get('t1').id, 'b');
    assert.deepEqual(notices, [{ kind: 'resume', threadId: 't1', from: 'a@example.com', to: 'b@example.com' }]);
  } finally {
    a.relay = null;
    a.dispose();
  }
});

test('usage-limit switching honors auto-switch and the continue cap, and can recover without an active account', async () => {
  const { a, notices, switched } = limitPool();
  try {
    a.state.autoSwitch = false;
    await a.onTurnLimit('off');
    assert.deepEqual(switched, []);
    a.state.autoSwitch = true;
    a.resumes.set('capped', [Date.now(), Date.now(), Date.now()]);
    await a.onTurnLimit('capped');
    assert.deepEqual(switched, []);
    assert.deepEqual(notices, []);
    a.active = () => null;
    await a.onTurnLimit(null);
    assert.deepEqual(switched, ['b']);
    assert.deepEqual(notices, [{ kind: 'resume', threadId: null, from: null, to: 'b@example.com' }]);
  } finally {
    a.dispose();
  }
});
