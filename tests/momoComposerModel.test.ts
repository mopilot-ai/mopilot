// A MoMo chat's composer on Claude Code (src/session/harness/select.ts, #2304): it shows the model the chat's turns run on (its
// brain's, chat meta momoModel), and a model picked there goes to main, which owns it, never to the chat's own pick or the
// new-chat default.
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { called, fx, reset } from './support/harness-logic-fakes.ts';

const sel = await import('../src/session/harness/select.ts');
const { claudeThreadId } = await import('../src/harness/types.ts');

const CL = claudeThreadId('momo');
beforeEach(() => {
  reset();
  // the Claude key is known (so the hooks don't ask main for it)
  fx.native.claude = { apiKey: () => new Promise(() => {}) };
});

test('an effort edit keeps the saved own model when runtime settings have not read a model yet', () => {
  fx.state.claude.models = [{ id: 'opus' }, { id: 'sonnet' }];
  fx.state.prefs.claudeSelection = { model: 'opus', effort: 'high', fast: false };
  fx.state.chatConfig[CL] = { model: 'sonnet', effort: 'low' };
  fx.state.runtime[CL] = { settings: { permission: 'read-only' } };
  sel.setSelection('claude', { effort: 'max' }, CL);
  assert.equal(called('setPrefs').at(-1)?.[0].claudeSelection.model, 'sonnet');
  assert.equal(fx.state.chatConfig[CL].model, 'sonnet');
});

test('the pinned model uses its own known effort or its saved effort while runtime still names another model', () => {
  fx.state.claude.models = [
    { id: 'opus', efforts: ['low', 'medium', 'high'] },
    { id: 'haiku', efforts: ['low', 'medium', 'high'] },
  ];
  fx.state.prefs.claudeSelection = { model: 'opus', effort: 'high', fast: false };
  fx.state.momoModels = { [CL]: 'haiku' };
  fx.state.runtime[CL] = { settings: { model: 'haiku', effort: 'low' } };
  assert.equal(sel.useEffectiveSelection('claude', CL).effort, 'low');
  fx.state.runtime[CL] = { settings: { model: 'opus', effort: 'low' } };
  fx.state.chatConfig[CL] = { model: 'haiku', effort: 'medium' };
  assert.equal(sel.useEffectiveSelection('claude', CL).effort, 'medium');
  assert.equal(called('setPrefs').length, 0, 'reading the selection does not rewrite defaults');
});

test('a MoMo chat on Claude Code shows its brain’s model; a model picked there goes to main, not to the defaults (#2304)', async () => {
  fx.state.claude.models = [
    { id: 'opus', label: 'Opus', efforts: ['low', 'high'] },
    { id: 'haiku', label: 'Haiku', efforts: ['low', 'high'] },
  ];
  fx.state.prefs.claudeSelection = { model: 'opus', effort: 'high', fast: false };
  fx.state.runtime[CL] = { settings: { model: 'opus', effort: 'low' } };
  fx.state.momoModels = { [CL]: 'haiku' };
  const asked: any[] = [];
  const told: string[] = [];
  fx.store.toastFailure = (what: string) => (e: Error) => told.push(`${what}: ${e.message}`);
  fx.store.toast = (text: string) => told.push(text);
  let fail: Error | null = null;
  let warning: string | null = null;
  fx.native.momoChat = {
    setChatModel: async (...a: any[]) => (asked.push(a), fail ? Promise.reject(fail) : { chatId: CL, warning }),
  };
  const r = sel.useEffectiveSelection('claude', CL);
  assert.deepEqual([r.modelId, r.effort], ['haiku', 'high'], 'an effort picked for opus cannot appear as the brain model effort');
  // a pin the model list doesn't name shows as itself
  fx.state.momoModels = { [CL]: 'claude-new-5' };
  assert.equal(sel.useEffectiveSelection('claude', CL).modelId, 'claude-new-5');
  fx.state.momoModels = { [CL]: 'haiku' };
  const prefs = called('setPrefs').length;
  sel.setSelection('claude', { model: 'opus' }, CL);
  sel.setSelection('claude', { model: 'gone' }, CL);
  assert.deepEqual(asked, [
    [CL, 'opus', 'Opus'],
    [CL, 'gone', null],
  ]);
  assert.equal(fx.state.runtime[CL].settings.model, 'opus', 'the chat’s own pick is left to main');
  assert.equal(called('setPrefs').length, prefs, 'the new-chat default stays');
  // a reset names no model to send, and says so; an effort beside a model still applies to the chat
  sel.setSelection('claude', { model: null }, CL);
  assert.deepEqual(told, ['Pick a model for MoMo.']);
  sel.setSelection('claude', { model: 'haiku', effort: 'max' }, CL);
  assert.equal(asked.length, 3);
  assert.equal(fx.state.runtime[CL].settings.effort, 'max');
  assert.equal(fx.state.runtime[CL].settings.model, 'haiku', 'the intentional effort edit belongs to the current brain model');
  // a change main applies with a warning, or refuses, is said
  warning = 'It uses the login in use.';
  sel.setSelection('claude', { model: 'opus' }, CL);
  await new Promise((r) => setImmediate(r));
  fail = new Error('MoMo is working');
  sel.setSelection('claude', { model: 'opus' }, CL);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(told.slice(1), ['It uses the login in use.', "Couldn't change MoMo's model: MoMo is working"]);
});
