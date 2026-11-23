// Panel question lifetimes survive regressed history and retained delivery, without borrowing a retired native source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { PanelQuestions } = require('../electron/capabilities/browser/chromePanelQuestions.cjs');
const { SessionStore } = require('../electron/session/state.cjs');
const { ChatController } = require('../electron/session/controller.cjs');
function fixture() {
  const state = new SessionStore();
  const record = { id: 'chat', segments: [{ kind: 'acp:gemini', nativeId: 'native' }], meta: {} };
  const controller = new ChatController({
    state,
    chats: { record: () => record, records: new Map([['chat', record]]) },
    codex: {},
    claudeTurns: {},
    acpTurns: {},
  });
  state.patch('chat', { turn: 'running' });
  const turns = [{ id: 'turn', items: [{ id: 'question', type: 'agentMessage', questions: [{ title: 'Where?' }] }] }];
  let history: any = { turns };
  let calls = 0;
  controller.send = async () => (calls++, { action: 'queued', id: 'input' });
  const questions = new PanelQuestions(
    { controller, peerRuntime: { readHistory: () => Promise.resolve(history) } },
    { reachable: () => true, agent: () => 'Gemini' },
  );
  return {
    questions,
    state,
    controller,
    record,
    turns,
    calls: () => calls,
    history: (value: any) => {
      history = value;
    },
  };
}

test('queued answers retain their identity through missing and regressed history, then remain answered after a newer submission', async () => {
  const f = fixture();
  const first = f.questions.read('chat', f.turns)[0];
  assert.equal(await f.questions.answer('chat', first.id, 'submit', { 0: ['Taipei'] }, first.version), true);
  assert.equal(f.questions.read('chat', []).length, 0);
  const restored = f.questions.read('chat', f.turns)[0];
  assert.equal(restored.version, first.version);
  assert.equal(restored.disabled, true);
  assert.equal(await f.questions.answer('chat', restored.id, 'submit', { 0: ['Taipei'] }, restored.version), false);
  const answered = [...f.turns, { id: 'reply', items: [{ type: 'userMessage', content: [{ type: 'text', text: 'Where?\nTaipei' }] }] }];
  assert.equal(f.questions.read('chat', answered).length, 0);
  assert.equal(f.questions.read('chat', f.turns).length, 0, 'a late older history cannot resurrect an answered question');
  assert.equal(f.calls(), 1);
});

test('a held native receipt owns the input; a retry cannot duplicate it', async () => {
  const f = fixture();
  f.controller.send = async () => ({ action: 'held', id: 'held-input' });
  const first = f.questions.read('chat', f.turns)[0];
  assert.equal(await f.questions.answer('chat', first.id, 'skip', undefined, first.version), true);
  const held = f.questions.read('chat', f.turns)[0];
  assert.equal(held.disabled, true);
  assert.match(held.title, /waiting/);
  assert.equal(await f.questions.answer('chat', first.id, 'skip', undefined, first.version), false);
});

test('a pending answer survives a read omitting its question, and a changed native source refuses the old control', async () => {
  const f = fixture();
  const first = f.questions.read('chat', f.turns)[0];
  let finish: any;
  f.history(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const pending = f.questions.answer('chat', first.id, 'skip', undefined, first.version);
  f.questions.read('chat', []);
  const readAgain = f.questions.read('chat', f.turns)[0];
  assert.equal(readAgain.version, first.version);
  assert.equal(readAgain.disabled, true);
  f.record.segments.push({ kind: 'acp:gemini', nativeId: 'replacement' });
  finish({ turns: f.turns });
  assert.equal(await pending, false);
  assert.equal(f.calls(), 0);
});

test('the real ACP controller queues one typed answer and retains ownership while history is still catching up', async () => {
  const f = fixture();
  delete f.controller.send;
  const first = f.questions.read('chat', f.turns)[0];
  assert.equal(await f.questions.answer('chat', first.id, 'submit', { 0: ['Taipei'] }, first.version), true);
  assert.equal(f.state.get('chat').queue.length, 1);
  assert.equal(f.state.get('chat').queue[0].text, 'Where?\nTaipei');
  f.questions.read('chat', []);
  const pending = f.questions.read('chat', f.turns)[0];
  assert.equal(pending.disabled, true);
  assert.equal(await f.questions.answer('chat', pending.id, 'submit', { 0: ['Taipei'] }, pending.version), false);
  assert.equal(f.state.get('chat').queue.length, 1);
});

test('a removed or changed question cannot accept an old control after the authoritative history read', async () => {
  for (const changed of [false, true]) {
    const f = fixture();
    const first = f.questions.read('chat', f.turns)[0];
    f.history({
      turns: changed ? [{ id: 'turn', items: [{ id: 'question', type: 'agentMessage', questions: [{ title: 'When?' }] }] }] : [],
    });
    assert.equal(await f.questions.answer('chat', first.id, 'submit', { 0: ['Taipei'] }, first.version), false);
    assert.equal(f.calls(), 0);
  }
});

test('mutable history objects cannot change a previously offered question’s payload', async () => {
  const f = fixture();
  const first = f.questions.read('chat', f.turns)[0];
  const retained = [...f.questions.cache('chat').values()][0];
  f.turns[0].items[0].questions[0].title = 'Replaced';
  assert.equal(retained.questions[0].title, 'Where?');
  assert.equal(await f.questions.answer('chat', first.id, 'skip', undefined, first.version), false);
  assert.equal(f.calls(), 0);
});

test('an external-running transition during history read refuses delivery, and a discarded receipt stays explicit', async () => {
  const f = fixture();
  const first = f.questions.read('chat', f.turns)[0];
  let finish: any;
  f.history(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const pending = f.questions.answer('chat', first.id, 'skip', undefined, first.version);
  f.state.patch('chat', { turn: 'idle', runningElsewhere: true });
  finish({ turns: f.turns });
  await assert.rejects(pending, /Another client/);
  assert.equal(f.calls(), 0);
  f.state.patch('chat', { runningElsewhere: false });
  f.history({ turns: f.turns });
  f.controller.send = async () => ({ action: 'discarded', id: 'input', error: 'No longer queued' });
  assert.equal(await f.questions.answer('chat', first.id, 'skip', undefined, first.version), true);
  const discarded = f.questions.read('chat', f.turns)[0];
  assert.equal(discarded.disabled, true);
  assert.match(discarded.title, /discarded/);
  assert.equal(discarded.detail, 'No longer queued');
});

test('legacy question snapshots without native ids still retain one stable control for an unchanged snapshot', () => {
  const f = fixture();
  const snapshot = [
    {
      items: [
        { type: 'agentMessage', text: 'Before the question' },
        { type: 'agentMessage', questions: [{ title: 'Where?' }] },
      ],
    },
  ];
  const first = f.questions.read('chat', snapshot)[0];
  assert.equal(f.questions.read('chat', structuredClone(snapshot))[0].version, first.version);
});

test('native session scoped questions cannot complete another segment reusing the same turn and item ids', async () => {
  const f = fixture();
  const turns = ['earlier-native', 'current-native'].map((sourceSession) => ({ ...structuredClone(f.turns[0]), sourceSession }));
  const cards = f.questions.read('chat', turns);
  assert.equal(cards.length, 2);
  assert.notEqual(cards[0].version, cards[1].version);
  const answered = [...turns, { id: 'reply', items: [{ type: 'userMessage', content: [{ type: 'text', text: 'Where?\nTaipei' }] }] }];
  const remaining = f.questions.read('chat', answered);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].version, cards[0].version);
  assert.equal(f.questions.read('chat', turns).length, 1);
});
