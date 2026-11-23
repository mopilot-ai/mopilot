// Codex's model list read again while MoPilot runs (src/store/connection.ts refreshModels): Codex sends nothing when a
// model is released, so a list that opens asks once the last answer is MODELS_FRESH_MS old, an account change always
// asks, a read under way is joined, and only the newest read's answer is kept.
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadStore, flush, impl, callsOf, bootImpls } from './support/store-harness.ts';

mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 1_000_000 });
const { store: S } = await loadStore();
const st = () => S.useStore.getState();
const asked = () => callsOf('api.modelList').length;
const model = (id: string) => ({ model: id, displayName: id, hidden: false, supportedReasoningEfforts: [] });
const listing =
  (...ids: string[]) =>
  async () => ({ data: ids.map(model) });
const shown = () => st().models.map((m: { model: string }) => m.model);
/** Let a read just started make its model/list call (it asks on the next tick). */
const asking = () => Promise.resolve();
/** A model/list answered only when the test says: resolve or reject it later. */
function held() {
  let answer!: (ids: string[]) => void;
  let fail!: (e: Error) => void;
  const p = new Promise<{ data: unknown[] }>((res, rej) => {
    answer = (ids) => res({ data: ids.map(model) });
    fail = rej;
  });
  return { list: () => p, answer, fail };
}

beforeEach(async () => {
  bootImpls({
    'api.accountRead': async () => ({ account: { type: 'chatgpt', email: 'a@b', planType: 'pro' }, requiresOpenaiAuth: false }),
  });
  impl['api.modelList'] = listing('gpt-6');
  await S.boot();
  await S.connect();
  await flush();
  mock.timers.tick(S.MODELS_FRESH_MS);
  await S.refreshModels();
});

test('a list opened again within MODELS_FRESH_MS asks nothing; one opened after it shows a newly released model', async () => {
  const before = asked();
  impl['api.modelList'] = listing('gpt-6', 'gpt-7');
  mock.timers.tick(S.MODELS_FRESH_MS - 1);
  assert.equal(S.refreshModels(), undefined);
  assert.equal(S.refreshHarnessModels('codex'), undefined);
  assert.equal(asked(), before);
  mock.timers.tick(1);
  await S.refreshHarnessModels('codex');
  assert.equal(asked(), before + 1);
  assert.deepEqual(shown(), ['gpt-6', 'gpt-7']);
});

test('lists opened while a read is under way join it', async () => {
  mock.timers.tick(S.MODELS_FRESH_MS);
  const h = held();
  impl['api.modelList'] = h.list;
  const before = asked();
  const first = S.refreshModels();
  assert.ok(first);
  assert.equal(S.refreshModels(), first);
  h.answer(['gpt-7']);
  await first;
  assert.equal(asked(), before + 1);
  assert.deepEqual(shown(), ['gpt-7']);
});

test('an account read that changed the account asks at once; one that changed nothing does not', async () => {
  const before = asked();
  await S.refreshAccount();
  await flush();
  assert.equal(asked(), before, 'the same account, read again');
  impl['api.accountRead'] = async () => ({ account: { type: 'chatgpt', email: 'a@b', planType: 'plus' }, requiresOpenaiAuth: false });
  impl['api.modelList'] = listing('gpt-6-plus');
  await S.refreshAccount();
  await flush();
  assert.equal(asked(), before + 1);
  assert.deepEqual(shown(), ['gpt-6-plus']);
});

test('a read for an account switched away from never lands, nor does its failure', async () => {
  mock.timers.tick(S.MODELS_FRESH_MS);
  const old = held();
  impl['api.modelList'] = old.list;
  const oldCalls = asked();
  const oldRead = S.refreshModels();
  await asking();
  assert.equal(asked(), oldCalls + 1, 'the held read was asked');
  // another account is now in use: its read starts while the old one is still out
  impl['api.modelList'] = listing('b-model');
  S.setState({ accounts: { ...st().accounts, active: 'b' } });
  await S.refreshModels();
  assert.deepEqual(shown(), ['b-model']);
  old.answer(['a-model']);
  await oldRead;
  assert.deepEqual(shown(), ['b-model'], "the old account's answer came last");
  // and the new account's list counts as fresh
  assert.equal(S.refreshModels(), undefined);

  mock.timers.tick(S.MODELS_FRESH_MS);
  const failing = held();
  impl['api.modelList'] = failing.list;
  const failCalls = asked();
  const failed = S.refreshModels();
  await asking();
  assert.equal(asked(), failCalls + 1, 'the held read was asked');
  impl['api.modelList'] = listing('c-model');
  S.setState({ accounts: { ...st().accounts, active: 'c' }, modelsLoaded: false });
  await S.refreshModels();
  S.setState({ modelsLoaded: false });
  failing.fail(new Error('gone'));
  await failed;
  assert.deepEqual([shown(), st().modelsLoaded], [['c-model'], false], "the old read's failure changes nothing");
});

test('a failed read keeps the list and the next list opened asks again', async () => {
  mock.timers.tick(S.MODELS_FRESH_MS);
  impl['api.modelList'] = () => Promise.reject(new Error('offline'));
  await S.refreshModels();
  assert.deepEqual(shown(), ['gpt-6']);
  impl['api.modelList'] = listing('gpt-7');
  const before = asked();
  await S.refreshModels();
  assert.equal(asked(), before + 1);
  assert.deepEqual(shown(), ['gpt-7']);
});

test('a clock set back reads the list as stale', async () => {
  const before = asked();
  mock.timers.setTime(Date.now() - 1000);
  await S.refreshModels();
  assert.equal(asked(), before + 1);
});

test('a Codex not connected is left to connect(); Claude Code is asked nothing', async () => {
  const before = asked();
  mock.timers.tick(S.MODELS_FRESH_MS);
  for (const conn of ['idle', 'connecting', 'error'] as const) {
    S.setState({ conn });
    assert.equal(S.refreshModels(), undefined);
  }
  S.setState({ conn: 'ready' });
  assert.equal(S.refreshHarnessModels('claude'), undefined);
  assert.equal(asked(), before);
});

test('connecting reads the models once, after the account, and that list counts as fresh', async () => {
  impl['api.accountRead'] = async () => ({ account: { type: 'chatgpt', email: 'new@b', planType: 'pro' }, requiresOpenaiAuth: false });
  impl['api.modelList'] = listing('gpt-7');
  const before = asked();
  await S.connect();
  await flush();
  assert.equal(asked(), before + 1);
  assert.deepEqual(shown(), ['gpt-7']);
  assert.equal(S.refreshModels(), undefined);
  // an account read that fails reads the models anyway, for the account as last read
  impl['api.accountRead'] = () => Promise.reject(new Error('down'));
  await S.connect();
  await flush();
  assert.equal(asked(), before + 2);
  assert.equal(S.refreshModels(), undefined, 'that read is the fresh one for the account as last read');
});

test('a list opened while an account switch is read is read again once the new account is known', async () => {
  mock.timers.tick(S.MODELS_FRESH_MS);
  const before = asked();
  // main switched the account: its own record is the new one before Codex's account read answers
  S.setState({ accounts: { ...st().accounts, active: 'b' } });
  impl['api.modelList'] = listing('half-switched');
  await S.refreshModels();
  impl['api.accountRead'] = async () => ({ account: { type: 'apiKey' }, requiresOpenaiAuth: false });
  impl['api.modelList'] = listing('b-model');
  await S.refreshAccount();
  await flush();
  assert.equal(asked(), before + 2);
  assert.deepEqual(shown(), ['b-model']);
});

test('a model/list call that throws at once is a failed read: the next list opened asks again', async () => {
  mock.timers.tick(S.MODELS_FRESH_MS);
  impl['api.modelList'] = () => {
    throw new Error('not connected');
  };
  await S.refreshModels();
  impl['api.modelList'] = listing('gpt-8');
  await S.refreshModels();
  assert.deepEqual(shown(), ['gpt-8']);
});
