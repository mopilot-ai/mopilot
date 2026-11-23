// electron/capabilities/tools/sessionControl.cjs: set_session_model, set_session_effort, set_session_fast_mode,
// set_session_output_style and set_session_permission_mode never raise cost or permission past the caller's own, and report
// what a harness cannot do as unavailable, the same way on Codex, Claude Code and ACP.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { controlSetup as setup, settingsFor, textOf, KINDS, type Kind } from './support/sessionManagementFakes.ts';
test('set_session_model switches a started session’s model, never this session’s and never to a costlier one', async () => {
  for (const [mine, theirs] of [
    ['claude', 'claude'],
    ['codex', 'codex'],
    ['acp:kimi', 'acp:kimi'],
  ] as [Kind, Kind][]) {
    const same = setup(mine, theirs, { top: { model: 'opus' }, alpha: { model: 'opus' } });
    // the model it already has is a no-op the host still confirms; the caller's own model is always allowed
    assert.match(
      textOf(await same.call('top', 'set_session_model', { session_id: 'alpha', model: 'opus' })),
      /^Session alpha \("Alpha task"\) will use "opus" from its next turn on\.$/,
    );
  }
  const s = setup('claude', 'claude', { top: { model: 'claude-opus-4-5' }, alpha: { model: 'claude-opus-4-5' } });
  assert.equal(
    textOf(await s.call('top', 'set_session_model', { session_id: 'alpha', model: 'claude-haiku-4-5' })),
    'Session alpha ("Alpha task") will use "claude-haiku-4-5" from its next turn on.',
  );
  assert.deepEqual(s.log.pop(), ['model', 'alpha', 'claude-haiku-4-5']);
  // a session that is working keeps its current turn; a costlier model is the user's to pick
  const busy = setup('claude', 'claude', {
    top: { model: 'claude-sonnet-4-5' },
    alpha: { model: 'claude-haiku-4-5' },
    states: { alpha: 'running' },
  });
  assert.match(
    textOf(await busy.call('top', 'set_session_model', { session_id: 'alpha', model: 'claude-sonnet-4-5' })),
    /next turn on \(its current turn is not changed\)\.$/,
  );
  assert.match(
    textOf(await busy.call('top', 'set_session_model', { session_id: 'alpha', model: 'claude-opus-4-5' })),
    /needs_user: Model "claude-opus-4-5" was not set: it is not this session's model or known to cost less/,
  );
  // across harnesses nothing is known about cost
  const mixed = setup('claude', 'codex', { top: { model: 'claude-opus-4-5' }, alpha: { model: 'gpt-5' } });
  assert.match(textOf(await mixed.call('top', 'set_session_model', { session_id: 'alpha', model: 'claude-haiku-4-5' })), /needs_user/);
  assert.match(
    textOf(await mixed.call('top', 'set_session_model', { session_id: 'alpha', model: 'GPT-5' })),
    /will use "GPT-5"/,
    'the model it already has',
  );
  const noModel = setup('claude', 'claude', { top: { model: null } });
  assert.match(textOf(await noModel.call('top', 'set_session_model', { session_id: 'alpha', model: 'claude-haiku-4-5' })), /needs_user/);
  assert.match(
    textOf(await s.call('top', 'set_session_model', { session_id: 'self', model: 'opus' })),
    /self_refused: Refusing to change this session's own model or effort; ask the user to change it from the model menu\./,
  );
  assert.match(textOf(await s.call('top', 'set_session_model', { session_id: 'alpha', model: ' ' })), /invalid_model/);
  assert.match(
    textOf(await s.call('alpha', 'set_session_model', { session_id: 'top', model: 'x' })),
    /not_linked: Only a session this chat started can be changed/,
  );
  const archived = setup('claude', 'claude', { archived: ['alpha'] });
  assert.match(
    textOf(await archived.call('top', 'set_session_model', { session_id: 'alpha', model: 'x' })),
    /chat_archived: Session alpha \("Alpha task"\) is archived - unarchive it first \(set_session_model\)/,
  );
  const gone = setup('claude', 'claude', { facts: { alpha: { settings: null } } });
  assert.match(
    textOf(await gone.call('top', 'set_session_model', { session_id: 'alpha', model: 'x' })),
    /not_found: That session is no longer available/,
  );
  const unknownCaller = setup('claude', 'claude', {
    facts: { top: { settings: null }, alpha: { settings: settingsFor('claude', { model: 'm' }) } },
  });
  assert.match(textOf(await unknownCaller.call('top', 'set_session_model', { session_id: 'alpha', model: 'm' })), /will use "m"/);
});

test('set_session_effort sets a level at or below this session’s own and tells what applied', async () => {
  for (const kind of KINDS) {
    const s = setup(kind, kind, { top: { effort: 'high' }, alpha: { effort: 'low' } });
    assert.equal(
      textOf(await s.call('top', 'set_session_effort', { session_id: 'alpha', effort: 'medium' })),
      'Session alpha ("Alpha task") will run at medium effort from its next turn on.',
    );
    assert.deepEqual(s.log.pop(), ['effort', 'alpha', 'medium']);
    assert.match(
      textOf(await s.call('top', 'set_session_effort', { session_id: 'alpha', effort: 'max' })),
      /needs_user: Effort max was not set/,
    );
    assert.equal(s.log.length, 0);
  }
  const s = setup('claude', 'claude', {
    top: { effort: 'high' },
    alpha: { effort: 'low' },
    facts: { alpha: { describe: {}, settings: settingsFor('claude', { effort: 'low' }), appliedEffort: 'high' } },
  });
  assert.equal(
    textOf(await s.call('top', 'set_session_effort', { session_id: 'alpha', effort: 'medium' })),
    'Session alpha ("Alpha task") will run at high effort from its next turn on; medium is not offered for its model.',
  );
  assert.match(
    textOf(await s.call('top', 'set_session_effort', { session_id: 'alpha', effort: 'low' })),
    /will run at high effort/,
    'the level it has needs no right',
  );
  const busy = setup('claude', 'claude', { states: { alpha: 'running' } });
  assert.match(
    textOf(await busy.call('top', 'set_session_effort', { session_id: 'alpha', effort: 'low' })),
    /\(its current turn is not changed\)$/,
  );
  const noEffort = setup('claude', 'claude', { top: { effort: null } });
  assert.match(textOf(await noEffort.call('top', 'set_session_effort', { session_id: 'alpha', effort: 'medium' })), /needs_user/);
  const mixed = setup('claude', 'codex');
  assert.match(textOf(await mixed.call('top', 'set_session_effort', { session_id: 'alpha', effort: 'medium' })), /needs_user/);
  assert.match(
    textOf(await s.call('top', 'set_session_effort', { session_id: 'alpha', effort: 'huge' })),
    /invalid_effort: effort must be one of none, minimal, low/,
  );
  assert.match(textOf(await s.call('top', 'set_session_effort', { session_id: 'self', effort: 'low' })), /self_refused/);
  const archived = setup('claude', 'claude', { archived: ['alpha'] });
  assert.match(textOf(await archived.call('top', 'set_session_effort', { session_id: 'alpha', effort: 'low' })), /chat_archived/);
});

test('set_session_fast_mode turns fast mode off freely and on only when this session runs fast, where the harness has it', async () => {
  for (const kind of ['codex', 'claude'] as Kind[]) {
    const s = setup(kind, kind, { top: { fast: true }, alpha: { fast: false } });
    assert.equal(
      textOf(await s.call('top', 'set_session_fast_mode', { session_id: 'alpha', enabled: true })),
      'Session alpha ("Alpha task") has fast mode on from its next request on.',
    );
    assert.deepEqual(s.log.pop(), ['fast', 'alpha', true]);
    assert.equal(
      textOf(await s.call('top', 'set_session_fast_mode', { session_id: 'self', enabled: false })),
      'This session has fast mode off from its next request on.',
    );
    const slow = setup(kind, kind, { top: { fast: false }, alpha: { fast: false } });
    assert.match(
      textOf(await slow.call('top', 'set_session_fast_mode', { session_id: 'alpha', enabled: true })),
      /needs_user: Fast mode was not turned on for session alpha \("Alpha task"\): this session does not run fast itself/,
    );
    assert.match(
      textOf(await slow.call('top', 'set_session_fast_mode', { session_id: 'self', enabled: true })),
      /not turned on for this session/,
    );
    assert.equal(
      textOf(await slow.call('top', 'set_session_fast_mode', { session_id: 'alpha', enabled: false })),
      'Session alpha ("Alpha task") has fast mode off from its next request on.',
    );
  }
  const acp = setup('acp:kimi', 'acp:kimi');
  assert.match(
    textOf(await acp.call('top', 'set_session_fast_mode', { session_id: 'alpha', enabled: false })),
    /unavailable: Fast mode is not available for acp:kimi in MoPilot\./,
  );
  assert.match(
    textOf(await acp.call('top', 'set_session_fast_mode', { session_id: 'alpha', enabled: true })),
    /unavailable/,
    'unavailable first, before any question of who may',
  );
  assert.equal(acp.log.length, 0);
  // an agent whose host says "off" for a harness without the key
  const mixed = setup('claude', 'acp:kimi');
  assert.match(
    textOf(await mixed.call('top', 'set_session_fast_mode', { session_id: 'alpha', enabled: false })),
    /unavailable: Fast mode is not available for acp:kimi/,
  );
  const s = setup();
  assert.match(textOf(await s.call('top', 'set_session_fast_mode', { session_id: 'alpha', enabled: 'yes' as any })), /bad_args/);
  assert.match(
    textOf(await s.call('alpha', 'set_session_fast_mode', { session_id: 'top', enabled: false })),
    /not_linked: Only this session or a session this chat started can be changed/,
  );
  const archived = setup('claude', 'claude', { archived: ['alpha'] });
  assert.match(textOf(await archived.call('top', 'set_session_fast_mode', { session_id: 'alpha', enabled: false })), /chat_archived/);
});

test('set_session_output_style is unavailable on every harness and says what to do instead', async () => {
  for (const kind of KINDS) {
    const s = setup(kind, kind);
    assert.equal(
      textOf(await s.call('top', 'set_session_output_style', { session_id: 'alpha', style: 'Explanatory' })),
      `ERROR unavailable: A per-chat output style is not available for ${kind} in MoPilot.`,
    );
    assert.equal(s.log.length, 0);
  }
  const s = setup();
  assert.match(textOf(await s.call('top', 'set_session_output_style', { session_id: 'self', style: 'default' })), /unavailable/);
  assert.match(textOf(await s.call('top', 'set_session_output_style', { session_id: 'alpha', style: '  ' })), /invalid_style/);
  assert.match(textOf(await s.call('top', 'set_session_output_style', { session_id: 'solo', style: 'x' })), /not_linked/);
  const unknown = setup('claude', 'claude', { facts: { alpha: { settings: null } } });
  assert.match(
    textOf(await unknown.call('top', 'set_session_output_style', { session_id: 'alpha', style: 'x' })),
    /not available for this harness in MoPilot/,
  );
  const description = s.r.list().find((t: any) => t.name === 'set_session_output_style').description;
  assert.match(description, /applies no per-chat output style on any harness/);
});

test('set_session_permission_mode never goes above this session’s own, maps native names, and reports what a harness applied', async () => {
  for (const kind of KINDS) {
    const s = setup(kind, kind, { top: { permission: 'auto-review' }, alpha: { permission: 'default' } });
    assert.equal(
      textOf(await s.call('top', 'set_session_permission_mode', { session_id: 'alpha', mode: 'read-only' })),
      'Session alpha ("Alpha task") now runs in read-only mode. It applies from its next action on.',
    );
    assert.deepEqual(s.log.pop(), ['permission', 'alpha', 'read-only']);
    assert.match(
      textOf(await s.call('top', 'set_session_permission_mode', { session_id: 'alpha', mode: 'full-access' })),
      /needs_user: Nothing was changed: full-access lets a session do more without asking than this session's auto-review\. Ask the user to switch it\./,
    );
    assert.match(
      textOf(await s.call('top', 'set_session_permission_mode', { session_id: 'alpha', mode: 'bypassPermissions' })),
      /needs_user/,
      'a native name is checked as what it means',
    );
    assert.match(
      textOf(await s.call('top', 'set_session_permission_mode', { session_id: 'alpha', mode: 'auto' })),
      /now runs in auto-review mode/,
    );
    assert.equal(s.log.at(-1)[2], 'auto-review');
    assert.equal(
      textOf(await s.call('top', 'set_session_permission_mode', { session_id: 'alpha', mode: 'acceptEdits' })),
      'Session alpha ("Alpha task") is already in default mode.',
    );
    assert.equal(
      textOf(await s.call('top', 'set_session_permission_mode', { session_id: 'self', mode: 'default' })),
      'This session now runs in default mode. It applies to the rest of this turn and every turn after it.',
    );
  }
  const closest = setup('claude', 'acp:kimi', {
    alpha: { permission: 'read-only' },
    facts: { alpha: { describe: {}, settings: settingsFor('acp:kimi', { permission: 'read-only' }), appliedMode: 'read-only' } },
  });
  assert.match(
    textOf(await closest.call('top', 'set_session_permission_mode', { session_id: 'alpha', mode: 'default' })),
    /now runs in read-only mode \(default is the closest mode its harness declares\)\./,
  );
  assert.match(
    textOf(await closest.call('top', 'set_session_permission_mode', { session_id: 'alpha', mode: 'nonsense' })),
    /invalid_mode: mode must be one of plan, read-only, default, auto-review, full-access\./,
  );
  assert.match(textOf(await closest.call('top', 'set_session_permission_mode', { session_id: 'alpha', mode: 7 as any })), /bad_args/);
  const unknown = setup('claude', 'claude', { top: { permission: null } });
  assert.match(
    textOf(await unknown.call('top', 'set_session_permission_mode', { session_id: 'alpha', mode: 'read-only' })),
    /unknown_permission: Nothing was changed: this session has not reported a known permission mode/,
  );
  const plan = setup('claude', 'claude', { top: { permission: 'plan' } });
  assert.match(
    textOf(await plan.call('top', 'set_session_permission_mode', { session_id: 'alpha', mode: 'default' })),
    /needs_user/,
    'plan is below everything',
  );
  const archived = setup('claude', 'claude', { archived: ['alpha'] });
  assert.match(
    textOf(await archived.call('top', 'set_session_permission_mode', { session_id: 'alpha', mode: 'read-only' })),
    /chat_archived/,
  );
  assert.match(textOf(await archived.call('alpha', 'set_session_permission_mode', { session_id: 'top', mode: 'read-only' })), /not_linked/);
});

test('set_session_harness moves a started session back to this chat’s harness, keeping this session’s model and effort as the ceiling', async () => {
  const s = setup('claude', 'codex', { top: { model: 'claude-opus-5-5', effort: 'high' } });
  // the reported journey: a child moved to Codex, its parent asks for Sonnet at medium, with no window and no named harness
  assert.equal(
    textOf(
      await s.call('top', 'set_session_harness', { session_id: 'alpha', harness: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' }),
    ),
    'Session alpha ("Alpha task") moves to claude on "claude-sonnet-5-5" at medium effort with its next message, which carries the conversation across.',
  );
  assert.deepEqual(s.log.at(-1), [
    'harness',
    'alpha',
    { harness: 'claude', model: 'claude-sonnet-5-5', effort: 'medium', inheritedEffort: null },
  ]);
  // omitted: this session's own, never a default that may cost more
  await s.call('top', 'set_session_harness', { session_id: 'alpha', harness: 'claude' });
  assert.deepEqual(s.log.at(-1), [
    'harness',
    'alpha',
    { harness: 'claude', model: 'claude-opus-5-5', effort: null, inheritedEffort: 'high' },
  ]);
  // costlier than the caller is the user's to name
  const before = s.log.length;
  assert.match(
    textOf(await s.call('top', 'set_session_harness', { session_id: 'alpha', harness: 'claude', model: 'claude-fable-5-1' })),
    /needs_user/,
  );
  assert.match(textOf(await s.call('top', 'set_session_harness', { session_id: 'alpha', harness: 'claude', effort: 'max' })), /needs_user/);
  assert.equal(s.log.length, before);
  s.orchestrator.o.said = () => 'use claude-fable-5-1 at max effort';
  await s.call('top', 'set_session_harness', { session_id: 'alpha', harness: 'claude', model: 'claude-fable-5-1', effort: 'max' });
  assert.deepEqual(s.log.at(-1), [
    'harness',
    'alpha',
    { harness: 'claude', model: 'claude-fable-5-1', effort: 'max', inheritedEffort: null },
  ]);
  // a turn in flight is left alone, and said so
  const busy = setup('claude', 'codex', { states: { alpha: 'running' } });
  assert.match(
    textOf(await busy.call('top', 'set_session_harness', { session_id: 'alpha', harness: 'claude' })),
    /its current turn is not changed/,
  );
});

test('set_session_harness goes elsewhere only on the user’s word, for every harness pair', async () => {
  for (const [mine, theirs, to] of [
    ['claude', 'claude', 'codex'],
    ['codex', 'codex', 'claude'],
    ['codex', 'claude', 'acp:kimi'],
    ['acp:kimi', 'acp:kimi', 'claude'],
  ] as [Kind, Kind, string][]) {
    const s = setup(mine, theirs);
    assert.match(textOf(await s.call('top', 'set_session_harness', { session_id: 'alpha', harness: to })), /needs_user/);
    assert.deepEqual(s.log, []);
    s.orchestrator.o.said = () => `switch to ${to.replace('acp:', '')}`;
    assert.match(textOf(await s.call('top', 'set_session_harness', { session_id: 'alpha', harness: to })), /moves to/);
    // an omitted model or effort is the target's default: this session's mean nothing there
    assert.deepEqual(s.log.at(-1), ['harness', 'alpha', { harness: to, model: null, effort: null, inheritedEffort: null }]);
  }
  // the user naming a model picks its harness; the agent's model there still needs that word
  const named = setup('codex', 'codex');
  named.orchestrator.o.said = () => '切回 sonnet 5.5 medium';
  await named.call('top', 'set_session_harness', { session_id: 'alpha', harness: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' });
  assert.deepEqual(named.log.at(-1), [
    'harness',
    'alpha',
    { harness: 'claude', model: 'claude-sonnet-5-5', effort: 'medium', inheritedEffort: null },
  ]);
  const word = setup('codex', 'codex');
  word.orchestrator.o.said = () => 'use claude';
  assert.match(
    textOf(await word.call('top', 'set_session_harness', { session_id: 'alpha', harness: 'claude', model: 'claude-opus-5-5' })),
    /needs_user/,
  );
  assert.match(
    textOf(await word.call('top', 'set_session_harness', { session_id: 'alpha', harness: 'claude', effort: 'high' })),
    /needs_user/,
  );
  // another agent with this chat's harness family compares with nothing
  const otherAgent = setup('acp:kimi', 'claude');
  assert.deepEqual((await otherAgent.call('top', 'set_session_harness', { session_id: 'alpha', harness: 'acp:kimi' })).ok, true);
  assert.deepEqual(otherAgent.log.at(-1), ['harness', 'alpha', { harness: 'acp:kimi', model: null, effort: null, inheritedEffort: null }]);
});

test('set_session_harness cancels on the session’s own harness and refuses what it cannot do', async () => {
  const s = setup('claude', 'codex');
  assert.equal(
    textOf(await s.call('top', 'set_session_harness', { session_id: 'alpha', harness: 'codex' })),
    'Session alpha ("Alpha task") stays on codex; any waiting switch is cancelled.',
  );
  assert.deepEqual(s.log.at(-1), ['harness', 'alpha', { harness: 'codex' }]);
  assert.match(
    textOf(await s.call('top', 'set_session_harness', { session_id: 'alpha', harness: 'codex', model: 'gpt-5' })),
    /same_harness/,
  );
  assert.match(textOf(await s.call('top', 'set_session_harness', { session_id: 'alpha', harness: ' ' })), /invalid_harness/);
  assert.match(
    textOf(await s.call('top', 'set_session_harness', { session_id: 'alpha', harness: 'claude', effort: 'huge' })),
    /invalid_effort/,
  );
  assert.match(textOf(await s.call('top', 'set_session_harness', { session_id: 'self', harness: 'codex' })), /self_refused/);
  assert.match(
    textOf(await s.call('alpha', 'set_session_harness', { session_id: 'top', harness: 'claude' })),
    /not_linked|self_refused|not_descendant/,
  );
  const archived = setup('claude', 'codex', { archived: ['alpha'] });
  assert.match(textOf(await archived.call('top', 'set_session_harness', { session_id: 'alpha', harness: 'claude' })), /chat_archived/);
  // blank optional fields are left out; a real one is passed through unchanged
  const applied = setup('claude', 'codex', { top: { model: null, effort: null } });
  assert.match(
    textOf(await applied.call('top', 'set_session_harness', { session_id: 'alpha', harness: 'claude', model: ' ' })),
    /moves to claude with its next message/,
  );
  assert.deepEqual(applied.log.at(-1), ['harness', 'alpha', { harness: 'claude', model: null, effort: null, inheritedEffort: null }]);
  // a bare level needs its destination named beside it: "high priority" picks no effort
  const bareHome = setup('codex', 'acp:kimi', { top: { effort: 'low' } });
  bareHome.orchestrator.o.said = () => 'high priority, keep going';
  assert.match(
    textOf(await bareHome.call('top', 'set_session_harness', { session_id: 'alpha', harness: 'codex', effort: 'high' })),
    /needs_user/,
  );
});

test('a waiting switch answers set_session_model and set_session_effort before their cost checks', async () => {
  const s = setup('claude', 'codex', {
    facts: { alpha: { switching: true, describe: { title: 'Alpha task' }, settings: settingsFor('codex') } },
  });
  // a model and level this session could not grant: the answer is still the switch, not "ask the user"
  assert.match(textOf(await s.call('top', 'set_session_model', { session_id: 'alpha', model: 'gpt-costly' })), /switch_pending/);
  assert.match(textOf(await s.call('top', 'set_session_effort', { session_id: 'alpha', effort: 'max' })), /switch_pending/);
  assert.deepEqual(s.log, []);
});
