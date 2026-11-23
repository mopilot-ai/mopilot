// Codex native goals, reviews and voice delegates resolve the same Automatic model as a normal turn.
import { test, assert, setup, thread, crash } from './support/codex-adapter/fixture.ts';

for (const model of [null, 'old'])
  for (const run of ['goal', 'resume', 'review', 'voice'])
    test(`${run}: native thread settings use ${model === null ? 'the recommendation' : 'the explicit pin'} before starting`, async () => {
      const w = setup(
        {
          'config/read': () => ({ config: { model: 'old' } }),
          'model/list': () => ({ data: [{ model: 'new', isDefault: true }] }),
          'thread/goal/set': () => ({ goal: { objective: 'run', status: 'active' } }),
          'review/start': () => ({ turn: { id: 'review' } }),
        },
        { segments: { chat: 'native' }, prefs: { model: 'old' }, config: { chat: { model } } },
      );
      w.a.hold('native', thread('native', { name: 'Existing chat' }));
      if (run === 'goal')
        assert.equal((await w.a.startGoal('chat', { kind: 'codex', id: 'native' }, { opts: { goal: 'run' } })).started, true);
      else if (run === 'voice')
        // startVoice applies the same settings after ensureResumed, before realtime/start delegates any turns.
        await w.a.applyPermission('chat', 'native');
      else await w.a.leased('chat', run === 'review' ? 'review/start' : 'thread/goal/set', { status: 'active' });
      const updates = w.server.sent.filter((m: any) => m.method === 'thread/settings/update');
      assert.equal(updates.length, 1);
      assert.equal(updates[0].params.model, model ?? 'new');
      assert.equal(updates[0].params.collaborationMode.settings.model, model ?? 'new');
      if (run !== 'voice') assert.ok(w.server.sent.indexOf(updates[0]) < w.server.sent.length - 1);
    });

test('an in-flight permission edit preserves a native run’s model and any one-turn override', async () => {
  const w = setup({}, { segments: { chat: 'native' }, config: { chat: { model: null, permission: 'full-access' } } });
  w.a.hold('native', thread('native'));
  w.a.noteGoal('native', { status: 'active' });
  w.a.defaults = async () => assert.fail('a permission-only edit cannot choose another model mid-run');
  assert.deepEqual(await w.a.permissionChanged('chat'), ['chat']);
  const update = w.server.sent.find((m: any) => m.method === 'thread/settings/update');
  assert.equal('model' in update.params, false);
  assert.equal('collaborationMode' in update.params, false);
  assert.equal(update.params.sandboxPolicy.type, 'dangerFullAccess');
});

test('a replacement Codex process cannot inherit a last-good catalog from the retired process', async () => {
  const w = setup({ 'model/list': () => ({ data: [{ model: 'new', isDefault: true }] }) });
  await w.a.defaults();
  assert.equal(w.a.defaultsGood.defaultModel, 'new');
  crash(w.server);
  assert.equal(w.a.defaultsGood, null);
  assert.equal(w.a.defaultsP, null);
  assert.equal(w.a.modelListP, null);
});
