// The Codex pool keeps a chat and the app in their billing lane (electron/identity/codexAccounts.cjs, identity/accounts/providers.cjs):
// when the active account goes (MoPilot sign-out, removal, the CLI signing out) the app falls back to a subscription
// only and otherwise activates nothing; a chat on an API key is never moved to a subscription or back; a chat's pins
// go with the account they name. Codex and the main app-server are faked (tests/support/electron-accounts.ts); data
// is made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { setup, sub, chatgptAuth, flush } from './support/electron-accounts.ts';

const { CodexDriver } = createRequire(import.meta.url)('../electron/identity/drivers/codex.cjs');
const { switchAccount } = createRequire(import.meta.url)('../electron/session/switchAccount.cjs');

const mopilot = { id: 'mopilot', kind: 'apiKey', mopilot: true, status: 'ok', baseUrl: 'https://gw.example.test/v1' };
const key = (id: string, extra: object = {}) => ({ id, kind: 'apiKey', status: 'ok', ...extra });
/** The main app-server: records requests; a logout deletes the CLI's own auth.json, as Codex does. */
function mainServer(a: any) {
  const sent: string[] = [];
  a.mainRequest = async (m: string) => {
    sent.push(m);
    if (m === 'account/logout') fs.rmSync(path.join(process.env.CODEX_HOME!, 'auth.json'), { force: true });
    return {};
  };
  return sent;
}
const cliAuth = () => fs.readFileSync(path.join(process.env.CODEX_HOME!, 'auth.json'), 'utf8');

/* ---------- A-5: MoPilot sign-out ---------- */
test('MoPilot sign-out with only an API key left activates nothing, and the CLI keeps its own sign-in', async (t) => {
  const { a, notices } = setup(t, {
    defaultAuth: { key: 'sk-cli' },
    state: { active: 'mopilot', accounts: [mopilot, key('k')] },
    homes: { mopilot: 'key:mpk', k: 'key:sk-k' },
  });
  const before = cliAuth();
  const sent = mainServer(a);
  await a.setMoPilotKey(null);
  assert.equal(a.state.active, null);
  assert.equal(a.active(), null);
  assert.equal(a.view().active, null);
  assert.ok(sent.includes('account/logout'), 'the app-server lets go of the revoked key');
  assert.equal(cliAuth(), before, "the CLI's own sign-in is left as it was");
  assert.deepEqual(
    notices().map((n: any) => n.kind),
    ['mopilotSignedOut'],
  );
  // the CLI's own key is not taken up later either, while nothing is chosen
  a.syncDefault();
  assert.equal(a.state.active, null);
});

test('MoPilot sign-out goes back to the subscription the user left, not the first one', async (t) => {
  const { a } = setup(t, {
    state: { active: 'mopilot', lastSubscription: 'c', accounts: [sub('b'), sub('c'), mopilot, key('k')] },
    homes: { b: 'b@example.com', c: 'c@example.com', mopilot: 'key:mpk', k: 'key:sk-k' },
  });
  mainServer(a);
  await a.setMoPilotKey(null);
  assert.equal(a.state.active, 'c');
});

/* ---------- A-6: pins go with the MoPilot account ---------- */
test('MoPilot sign-out drops the chats pinned to it and forgets its provider key', async (t) => {
  const forgot: string[] = [];
  const { a } = setup(t, {
    state: { accounts: [sub('b'), mopilot], chatPins: { mine: 'mopilot', other: 'b' } },
    homes: { b: 'b@example.com', mopilot: 'key:mpk' },
    extra: { forgetProvider: async (id: string) => void forgot.push(id) },
  });
  a.pins.set('auto', { id: 'mopilot', at: Date.now() });
  mainServer(a);
  await a.setMoPilotKey(null);
  assert.deepEqual(a.state.chatPins, { other: 'b' });
  assert.equal(a.pins.has('mine'), false);
  assert.equal(a.pins.has('auto'), false);
  assert.equal(a.pins.get('other').id, 'b');
  assert.deepEqual(forgot, ['mopilot']);
  // a failed keychain erase is not the sign-out's failure
  await a.setMoPilotKey('mpk-2', 'https://gw.example.test/v1');
  a.forgetProvider = async () => {
    throw new Error('keychain locked');
  };
  await a.setMoPilotKey(null);
  assert.equal(a.get('mopilot'), null);
});

/* ---------- A-10: per-chat pins stay in their lane ---------- */
test('a chat is put only on an account of its own lane', (t) => {
  const { a } = setup(t, {
    state: { accounts: [sub('b'), key('k'), key('k2')] },
    homes: { b: 'b@example.com', k: 'key:sk-k', k2: 'key:sk-k2' },
  });
  a.pinChat('t', 'b');
  assert.equal(a.state.chatPins.t, 'b');
  assert.throws(() => a.pinChat('t', 'k'), /billed the same way/);
  assert.equal(a.state.chatPins.t, 'b');
  // a chat on a key moves to another key, not to a subscription
  a.state.chatPins = {};
  a.pins.set('kc', { id: 'k', at: Date.now(), sticky: true });
  a.pinChat('kc', 'k2');
  assert.equal(a.pins.get('kc').id, 'k2');
  assert.throws(() => a.pinChat('kc', 'b'), /billed the same way/);
  assert.equal(a.pins.get('kc').id, 'k2');
  // back to automatic always works
  a.pinChat('kc', null);
  assert.equal(a.state.chatPins.kc, undefined);
});

test('a failed account pin save leaves the relay and the saved choice unchanged', (t) => {
  const { a } = setup(t, {
    state: { accounts: [sub('b'), sub('c')], chatPins: { t: 'b' } },
    homes: { b: 'b@example.com', c: 'c@example.com' },
  });
  const before = { ...a.pins.get('t') };
  const save = a.save;
  a.save = () => {
    throw new Error('disk full');
  };
  assert.throws(() => a.pinChat('t', null), /disk full/);
  assert.equal(a.state.chatPins.t, 'b');
  assert.deepEqual(a.pins.get('t'), before);
  a.save = save;
  a.pinChat('t', null);
  assert.equal(a.state.chatPins.t, undefined);
  assert.equal(a.pins.get('t').sticky, false);
});

test('a failed rollback must preserve the old Codex account across restart', (t) => {
  const { a, userData } = setup(t, {
    state: { accounts: [sub('b'), sub('c')], chatPins: { t: 'b' } },
    homes: { b: 'b@example.com', c: 'c@example.com' },
  });
  const put = switchAccount({ chats: {}, codex: () => a, claude: {} });
  const prepared = put.prepareAutomatic('codex', 't');
  a.save = () => {
    throw new Error('disk full');
  };
  assert.throws(() => prepared.undo(), /disk full/);
  assert.equal(a.pins.get('t').id, 'b');
  assert.equal(a.pins.get('t').sticky, true);
  assert.equal(a.state.chatPins.t, 'b');
  delete a.save;
  a.save();
  assert.equal(JSON.parse(fs.readFileSync(path.join(userData, 'accounts.json'), 'utf8')).chatPins.t, 'b');
});

test('a chat on an API key whose key route is gone is not served by a subscription', (t) => {
  const { a, notices } = setup(t, {
    state: { accounts: [sub('b'), sub('c'), key('k', { status: 'expired' })], chatPins: { kc: 'k' } },
    homes: { b: 'b@example.com', c: 'c@example.com', k: 'key:sk-k' },
  });
  assert.equal(a.keyRoute('kc'), null);
  assert.equal(a.pickFor('kc', new Set()), undefined);
  assert.equal(a.state.chatPins.kc, 'k');
  assert.equal(a.pins.get('kc').id, 'k');
  assert.equal(notices().filter((n: any) => n.kind === 'moved').length, 0);
  // with a single subscription it is not passed through on the app-server's login either
  a.state.accounts = a.state.accounts.filter((x: any) => x.id !== 'c');
  assert.equal(a.pickFor('kc', new Set()), undefined);
  // a record saved before kinds were written is a ChatGPT login: its chat is served as one
  a.state.accounts.push({ id: 'old', status: 'ok' });
  a.pins.set('oc', { id: 'old', at: Date.now(), sticky: true });
  assert.equal(a.pickFor('oc', new Set()).id, 'old');
  // MoPilot credits are a lane of their own too
  a.state.accounts.push({ ...mopilot, status: 'expired' });
  a.pins.set('mc', { id: 'mopilot', at: Date.now(), sticky: true });
  assert.equal(a.pickFor('mc', new Set()), undefined);
});

test('removing the active subscription never takes up an API key', async (t) => {
  const { a } = setup(t, {
    defaultAuth: 'none',
    state: { active: 'b', accounts: [sub('b'), key('k')] },
    homes: { b: 'b@example.com', k: 'key:sk-k' },
  });
  const sent = mainServer(a);
  await a.remove('b');
  assert.equal(a.state.active, null);
  assert.equal(a.active(), null);
  assert.ok(sent.includes('account/logout'), 'the app-server lets go of the removed login');
  assert.ok(a.get('k'), 'the key stays saved');
});

test('removing the active subscription keeps the CLI sign-in file when nothing is left to activate', async (t) => {
  const { a } = setup(t, {
    defaultAuth: { key: 'sk-cli' },
    state: { active: 'b', accounts: [sub('b')] },
    homes: { b: 'b@example.com' },
  });
  const before = cliAuth();
  mainServer(a);
  await a.remove('b');
  assert.equal(a.state.active, null);
  assert.equal(cliAuth(), before);
});

test('removing the active API key falls back to a subscription, preferring a healthy one', async (t) => {
  const { a } = setup(t, {
    defaultAuth: 'none',
    state: { active: 'k', accounts: [sub('b', { status: 'expired' }), sub('c'), key('k'), key('k2')] },
    homes: { b: 'b@example.com', c: 'c@example.com', k: 'key:sk-k', k2: 'key:sk-k2' },
  });
  mainServer(a);
  await a.remove('k');
  assert.equal(a.state.active, 'c');
});

test('the CLI signing out by itself falls back to a subscription, never to a key', async (t) => {
  const { a } = setup(t, { state: { accounts: [key('k')] }, homes: { k: 'key:sk-k' } });
  assert.equal(a.state.active, 'default');
  fs.rmSync(path.join(process.env.CODEX_HOME!, 'auth.json'));
  a.syncDefault();
  // the CLI's own login stays the one chosen, so it is taken up again when the CLI signs back in; the key is not
  assert.equal(a.state.active, 'default');
  assert.equal(a.active(), null);
  // a subscription in the pool takes over instead
  const t2 = setup(t, { state: { accounts: [key('k'), sub('b')] }, homes: { k: 'key:sk-k', b: 'b@example.com' } });
  fs.rmSync(path.join(process.env.CODEX_HOME!, 'auth.json'));
  t2.a.syncDefault();
  assert.equal(t2.a.state.active, 'b');
});

test('nothing chosen: a subscription the CLI signs in to is taken up, an unknown active id falls back to a subscription only', (t) => {
  const { a } = setup(t, { defaultAuth: 'none', state: { active: null, accounts: [key('k')] }, homes: { k: 'key:sk-k' } });
  assert.equal(a.active(), null);
  // a dangling id (an old file) never resolves to a key
  a.state.active = 'gone';
  assert.equal(a.active(), null);
  a.state.accounts.push(sub('b'));
  assert.equal(a.active().id, 'b');
  // the CLI signs in with ChatGPT while nothing is chosen
  a.state.active = null;
  chatgptAuth(process.env.CODEX_HOME!, 'cli@example.com', 'acct-cli');
  a.syncDefault();
  assert.equal(a.state.active, 'default');
});

/* ---------- A-11: the loop guard says so ---------- */
test('the automatic-continue loop guard stops with a notification, not silently', async (t) => {
  const told: string[] = [];
  const { a } = setup(t, {
    state: { accounts: [sub('b')] },
    homes: { b: 'b@example.com' },
    extra: { notifyLimit: (threadId: string) => void told.push(threadId) },
  });
  const now = Date.now();
  a.resumes.set('t', [now, now, now]);
  await a.onTurnLimit('t');
  assert.deepEqual(told, ['t']);
  // with nothing listening it still returns quietly
  const { a: bare } = setup(t, { state: { accounts: [sub('b')] }, homes: { b: 'b@example.com' } });
  bare.resumes.set('t', [now, now, now]);
  await bare.onTurnLimit('t');
  await flush();
});

/* ---------- A-11: the identity driver agrees with routing ---------- */
test('Codex per-chat accounts need two subscriptions behind the relay, as pickFor does; limits show in instances', (t) => {
  const { a } = setup(t, { state: { accounts: [key('k')] }, homes: { k: 'key:sk-k' } });
  const d = new CodexDriver(a);
  a.relay = {};
  assert.equal(d.perChat, false, 'one ChatGPT login and a key: pins are ignored');
  a.state.accounts.push(sub('b'));
  assert.equal(d.perChat, true);
  a.relay = null;
  assert.equal(d.perChat, false);
  a.markLimited(a.get('b'), 9e9);
  const byAccount = Object.fromEntries(d.instances().map((i: any) => [i.account, i]));
  assert.equal(byAccount.b.limited, true);
  assert.equal(byAccount.default.limited, false);
  assert.equal(byAccount.k.limited, false);
});

/* ---------- review: ordering and restarts ---------- */
test('a failed switch after MoPilot sign-out keeps the subscription chosen, never the removed MoPilot account', async (t) => {
  const { a } = setup(t, {
    defaultAuth: 'none',
    state: { active: 'mopilot', accounts: [sub('b'), mopilot] },
    homes: { b: 'b@example.com', mopilot: 'key:mpk' },
  });
  mainServer(a);
  a.applyNow = async () => {
    throw new Error('app-server down');
  };
  await a.setMoPilotKey(null);
  assert.equal(a.state.active, 'b');
  // signing in to MoPilot again does not put the app back on credits
  await a.setMoPilotKey('mpk-2', 'https://gw.example.test/v1');
  assert.equal(a.state.active, 'b');
});

test('a MoPilot sign-in that lands while the sign-out is still switching keeps its key in the keychain', async (t) => {
  const forgot: string[] = [];
  const { a } = setup(t, {
    state: { active: 'mopilot', accounts: [sub('b'), mopilot] },
    homes: { b: 'b@example.com', mopilot: 'key:mpk' },
    extra: { forgetProvider: async (id: string) => void forgot.push(id) },
  });
  mainServer(a);
  const switchTo = a.switchTo.bind(a);
  a.switchTo = async (id: string) => {
    await a.setMoPilotKey('mpk-2', 'https://gw.example.test/v1');
    return switchTo(id);
  };
  await a.setMoPilotKey(null);
  assert.ok(a.get('mopilot'), 'the new sign-in stays');
  assert.deepEqual(forgot, []);
});

test('nothing chosen: a restarted app-server lets go of the CLI key it read, and the CLI file stays', async (t) => {
  const { a } = setup(t, { defaultAuth: { key: 'sk-cli' }, state: { active: null, accounts: [key('k')] }, homes: { k: 'key:sk-k' } });
  const before = cliAuth();
  const sent = mainServer(a);
  assert.equal(a.active(), null);
  await a.applyNow();
  assert.deepEqual(sent, ['account/logout']);
  assert.equal(cliAuth(), before);
  assert.equal(a.state.active, null);
  // with no CLI sign-in there is nothing for the app-server to hold
  const t2 = setup(t, { defaultAuth: 'none', state: { active: null, accounts: [key('k')] }, homes: { k: 'key:sk-k' } });
  const sent2 = mainServer(t2.a);
  await t2.a.applyNow();
  assert.deepEqual(sent2, []);
});

test("a chat's lane is read from its live pin, as the window reads it, not from an expired automatic one", (t) => {
  const { a } = setup(t, {
    defaultAuth: 'none',
    state: { active: 'k', accounts: [sub('b'), key('k'), key('k2')] },
    homes: { b: 'b@example.com', k: 'key:sk-k', k2: 'key:sk-k2' },
  });
  // an automatic pin older than its lifetime, not yet swept: the chat is on the active key
  a.pins.set('t', { id: 'b', at: 0 });
  a.pinChat('t', 'k2');
  assert.equal(a.state.chatPins.t, 'k2');
});

test('keychain writes for a provider key run in the order asked: a sign-out erase never lands after a later store', async () => {
  const { CodexProviders } = createRequire(import.meta.url)('../electron/identity/contract/codexProvider.cjs');
  const log: string[] = [];
  let release!: () => void;
  const p = new CodexProviders({
    command: '/fake/auth-command',
    exists: () => true,
    store: async (_s: string, _a: string, k: string) => void log.push(`store ${k}`),
    erase: () =>
      new Promise<void>((resolve) => {
        release = () => (log.push('erase'), resolve());
      }),
  });
  Object.defineProperty(p, 'available', { value: true });
  const forgetting = p.forget('mopilot');
  const storing = p.fragment({ account: 'mopilot', key: 'mpk-2', baseUrl: 'https://gw.example.test/v1', name: 'MoPilot' });
  await flush();
  assert.deepEqual(log, [], 'the store waits for the erase asked first');
  release();
  await forgetting;
  assert.ok(await storing);
  assert.deepEqual(log, ['erase', 'store mpk-2']);
  // a failed write does not hold the next one
  p.erase = async () => {
    throw new Error('denied');
  };
  await p.forget('mopilot');
  assert.ok(await p.fragment({ account: 'mopilot', key: 'mpk-3', baseUrl: 'https://gw.example.test/v1', name: 'MoPilot' }));
  assert.deepEqual(log, ['erase', 'store mpk-2', 'store mpk-3']);
});
