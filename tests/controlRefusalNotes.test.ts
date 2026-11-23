// An app computer use refused in a turn (#1724), as the renderer reads it from the chat's saved notes: which apps a turn
// refused, the follow-up the composer suggests (never one on a refused app), the working-in card's state for it, and the
// notes put back after their turns.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { refusedApps, refusalOf } = await import('../src/lib/controlRefusal.ts');
const { suggestNextStep } = await import('../src/lib/nextStep.ts');
const { workingInOf } = await import('../src/lib/workingIn.ts');
const { withChatNotes, sameTurn } = await import('../src/lib/chatMeta.ts');

const SELF = { app: 'ai.mopilot.code', name: 'MoPilot' };
const note = (o: Record<string, unknown> = {}) => ({
  id: 'control-1',
  kind: 'control' as const,
  text: "Computer use can't control MoPilot itself.",
  refused: SELF,
  turnId: 'turn1',
  turn: Number.MAX_SAFE_INTEGER,
  at: 1,
  ...o,
});
const cua = (code: string, status = 'completed') => ({
  type: 'mcpToolCall',
  server: 'cua_repl',
  tool: 'js',
  arguments: { code },
  status,
  result: { content: [] },
});
const sage = (tool: string, args: Record<string, unknown>) => ({
  type: 'mcpToolCall',
  server: 'sage_x',
  tool,
  arguments: args,
  status: 'completed',
  result: { content: [] },
});

test("refusedApps: a control note with an app, for the chat's latest turn (a live ct- id is the transcript h- id)", () => {
  const T = (...ids: string[]) => ids.map((id) => ({ id }));
  const notes = [
    note(),
    note({ id: 'b', refused: undefined, text: 'Computer use stopped: another app is using this Mac.' }),
    note({ id: 'c', turnId: 'turn2', refused: { app: 'Notes', name: 'Notes' } }),
    { id: 'e', kind: 'account' as const, text: 'Moved', turnId: 'turn1', turn: 0, at: 1 },
  ];
  assert.deepEqual(refusedApps(notes, T('turn2', 'turn1')), [SELF]);
  assert.deepEqual(refusedApps(notes, T('turn1', 'turn2')), [{ app: 'Notes', name: 'Notes' }], 'an earlier turn’s note is not');
  assert.deepEqual(refusedApps([note({ turnId: 'ct-abc' })], T('h-abc')), [SELF]);
  // noted under a turn id no loaded turn has (a controller token such as auto-<uuid>), or under none: the latest turn's
  assert.deepEqual(refusedApps([note({ turnId: 'auto-1' }), note({ id: 'n', turnId: null })], T('turn1', 'turn2')), [SELF, SELF]);
  assert.deepEqual(refusedApps(undefined, T('turn1')), []);
  assert.deepEqual(refusedApps([], T('turn1')), []);
  assert.deepEqual(refusedApps(notes, []), []);
  assert.deepEqual(refusedApps(notes, undefined), []);
  assert.equal(sameTurn('pending-x', 'ct-x'), true);
  assert.equal(sameTurn('a', 'b'), false);
});

test('refusalOf: the app as the agent named it or by its name, in any case', () => {
  assert.equal(refusalOf('AI.MoPilot.Code', [SELF]), SELF);
  assert.equal(refusalOf(' mopilot ', [SELF]), SELF);
  assert.equal(refusalOf('Notes', [SELF]), null);
  assert.equal(refusalOf('Notes', []), null);
});

test('the composer never suggests acting on an app computer use refused; other apps keep their suggestion', () => {
  // the #1724 repro: Codex Computer Use bound MoPilot by bundle id and was stopped
  const sky = [cua("const s = await cua.getState(); const m = await cua.getApp('ai.mopilot.code');", 'failed')];
  assert.equal(suggestNextStep(sky), 'Check ai.mopilot.code again and tell me what changed', 'without the note: the old suggestion');
  assert.equal(suggestNextStep(sky, [SELF]), null);
  // MoPilot's own desktop tools on any harness, by the app's name
  const own = [sage('desktop_app_screenshot', { app: 'MoPilot' })];
  assert.equal(suggestNextStep(own, [SELF]), null);
  // a turn that used another app last keeps its suggestion
  assert.equal(
    suggestNextStep([...own, sage('desktop_app_screenshot', { app: 'Notes' })], [SELF]),
    'Check Notes again and tell me what changed',
  );
  // the user's blocked app, by the name its note gives
  assert.equal(suggestNextStep([sage('desktop_app_key', { app: 'Notes', combo: 'cmd+n' })], [{ app: 'notes', name: 'Notes' }]), null);
});

test('the working-in card shows a refused app by its name, as refused, with no picture; other apps as before', () => {
  const turn = {
    id: 'turn1',
    status: 'interrupted' as const,
    items: [
      cua("const te = await cua.getApp('TextEdit'); await te.pressKey('super+n');"),
      cua("const m = await cua.getApp('ai.mopilot.code');", 'failed'),
      // a later step of the same program goes to the app it bound: still refused
      cua('await m.click([1, 1]);', 'failed'),
    ],
  };
  const w = workingInOf(turn, undefined, [SELF])!;
  assert.equal(w.status, 'stopped');
  assert.deepEqual(
    w.apps.map((a) => [a.app, a.step, a.shot, a.refused ?? false]),
    [
      ['MoPilot', 'Refused', null, true],
      ['TextEdit', 'Pressed ⌘N in TextEdit', null, false],
    ],
  );
  // MoPilot's own desktop tool named it by bundle id, which the step's narration shortens: the call's argument matches
  const own = { id: 'turn2', status: 'completed' as const, items: [sage('desktop_app_screenshot', { app: 'ai.mopilot.code' })] };
  assert.deepEqual(
    workingInOf(own, undefined, [SELF])!.apps.map((a) => [a.app, a.step, a.refused]),
    [['MoPilot', 'Refused', true]],
  );
  assert.equal(workingInOf(own)!.apps[0].refused, undefined);
  // without the note the bundle id shows as before (the app-name lookup is the card's own, src/lib/appNames.ts)
  assert.deepEqual(
    workingInOf(turn)!.apps.map((a) => [a.app, a.refused ?? false]),
    [
      ['ai.mopilot.code', false],
      ['TextEdit', false],
    ],
  );
});

test('a refusal note goes back after its turn with the app it names; one with no turn id after the latest turn', () => {
  const turns = [
    { id: 'h-1', items: [{ id: 'a' }] },
    { id: 'h-2', items: [{ id: 'b' }] },
  ];
  const out = withChatNotes(turns, [note({ turnId: 'ct-1' }), note({ id: 'control-2', turnId: null, refused: undefined })]);
  assert.deepEqual(out[0].items.at(-1), {
    type: 'statusNote',
    id: 'control-1',
    kind: 'control',
    text: "Computer use can't control MoPilot itself.",
    refused: SELF,
  });
  assert.deepEqual(out[1].items.at(-1), {
    type: 'statusNote',
    id: 'control-2',
    kind: 'control',
    text: "Computer use can't control MoPilot itself.",
  });
});
