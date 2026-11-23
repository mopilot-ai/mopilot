// electron/harness/harnessUpdates.cjs Update all: one harness after another, quietly; one with chats mid-turn left out
// and saying so; a launch that can't start is a result; Cancel stops after the current one, never killing it.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { setup, npmMethod } = await import('./support/harness-updates-kit.ts');

test('Update all: one after another, quietly; a harness with chats mid-turn is left out and says so; Cancel stops after the current one', async () => {
  const s = setup({
    methods: {
      'acp:kimi': npmMethod('@moonshot-ai/kimi-code'),
      codex: npmMethod('@openai/codex'),
      'acp:qwen': npmMethod('@qwen-code/qwen-code'),
    },
    installed: [
      { kind: 'acp:kimi', bin: '/k', version: '1.0.0' },
      { kind: 'codex', bin: '/c', version: '0.162.0' },
      { kind: 'acp:qwen', bin: '/q', version: '0.1.0' },
    ],
    latest: { '@moonshot-ai/kimi-code': '2.2.0', '@openai/codex': '0.170.0', '@qwen-code/qwen-code': '0.25.0' },
    versions: {},
  });
  assert.deepEqual(s.updates.updateAll(), { ok: false, error: 'nothing' });
  await s.updates.check();
  s.setBusy({
    codex: [
      { id: 'c1', title: 't' },
      { id: 'c2', title: 'u' },
    ],
  });
  assert.deepEqual(s.updates.updateAll(), { ok: true });
  assert.deepEqual(s.updates.updateAll(), { ok: true }, 'already under way');
  let all = s.updates.state().all;
  assert.equal(all.current, 'acp:kimi');
  assert.equal(all.total, 3);
  assert.equal(s.quiet.length, 1, 'quietly');
  s.setHealth(() => ({ version: '2.2.0', broken: null }));
  await s.end(0, s.quiet[0].h);
  all = s.updates.state().all;
  // codex had a chat mid-turn: left out; qwen next
  assert.equal(all.current, 'acp:qwen');
  assert.deepEqual(
    all.results.map((r: any) => [r.harness, r.outcome.result]),
    [
      ['acp:kimi', 'updated'],
      ['codex', 'failed'],
    ],
  );
  assert.equal(all.results[1].outcome.message, '2 chats are working with it');
  assert.equal(s.updates.cancelAll(), true);
  assert.equal(s.updates.state().all.cancelled, true);
  assert.equal(s.quiet.filter((q: any) => q === 'killed').length, 0, 'the running one is never killed');
  await s.end(1, s.quiet.at(-1).h);
  all = s.updates.state().all;
  assert.equal(all.running, false);
  assert.equal(all.results.length, 3);
  assert.equal(s.updates.cancelAll(), false);
});

test("Update all: a launch that can't start is a result, and Cancel with nothing running ends at once", async () => {
  const s = setup();
  await s.updates.check();
  // kimi's npm run is already going in a terminal: Update all takes codex, whose npm is locked by it
  await s.updates.update('acp:kimi');
  s.setBusy({});
  s.updates.updateAll();
  const all = s.updates.state().all;
  assert.equal(all.running, false);
  assert.deepEqual(all.results, [
    { harness: 'codex', outcome: { result: 'failed', from: null, to: null, message: 'another update was running' } },
  ]);
  const t = setup();
  await t.updates.check();
  t.updates.methods.delete('codex');
  t.updates.methods.delete('acp:kimi');
  t.updates.updateAll();
  assert.equal(t.updates.state().all.results.find((r: any) => r.harness === 'codex').outcome.message, "couldn't start");
  // cancelling between harnesses (nothing current) ends it
  const u = setup();
  await u.updates.check();
  u.updates.all = { running: true, queue: ['codex'], total: 1, index: 0, current: null, results: [], cancelled: false };
  assert.equal(u.updates.cancelAll(), true);
  assert.equal(u.updates.state().all.running, false);
});

test('Update all says one chat in the singular', async () => {
  const s = setup();
  await s.updates.check();
  s.setBusy({ 'acp:kimi': [{ id: 'c1', title: 't' }], codex: [{ id: 'c2', title: 'u' }] });
  s.updates.updateAll();
  assert.deepEqual(
    s.updates.state().all.results.map((r: any) => r.outcome.message),
    ['1 chat is working with it', '1 chat is working with it'],
  );
});

test('Update all leaves a harness that waits for its chats to that wait', async () => {
  const s = setup();
  await s.updates.check();
  s.setBusy({ 'acp:kimi': [{ id: 'c1', title: 't' }] });
  await s.updates.update('acp:kimi', { when: 'idle' });
  s.setBusy({});
  s.updates.updateAll();
  const all = s.updates.state().all;
  assert.equal(all.total, 1);
  assert.equal(all.current, 'codex');
  assert.equal(s.info('acp:kimi').state, 'waiting');
});
